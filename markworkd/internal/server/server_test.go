package server_test

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/bridge"
	"github.com/EkaPutCom/markwork/markworkd/internal/client"
	"github.com/EkaPutCom/markwork/markworkd/internal/config"
	"github.com/EkaPutCom/markwork/markworkd/internal/model"
	"github.com/EkaPutCom/markwork/markworkd/internal/protocol"
	"github.com/EkaPutCom/markwork/markworkd/internal/runner"
	"github.com/EkaPutCom/markwork/markworkd/internal/server"
	"github.com/EkaPutCom/markwork/markworkd/internal/store"
	"github.com/EkaPutCom/markwork/markworkd/internal/supervisor"
	"github.com/EkaPutCom/markwork/markworkd/internal/testutil"
)

func TestMain(m *testing.M) { testutil.Main(m) }

type fixture struct {
	t    *testing.T
	sup  *supervisor.Supervisor
	srv  *server.Server
	sock string
	root string
}

func newFixture(t *testing.T, mod func(*server.Options)) *fixture {
	t.Helper()
	// Unix socket paths are limited to about 100 bytes, so not t.TempDir().
	dir, err := os.MkdirTemp("", "mw")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	f := &fixture{t: t, sock: filepath.Join(dir, "s.sock"), root: t.TempDir()}
	cfg := config.Default()
	cfg.Roots = []string{f.root}
	cfg.Programs = map[string]string{"agent": testutil.FakeAgent(t)}
	cfg.DefaultIdleTTLSec = 0
	st, err := store.Open(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	f.sup = supervisor.New(supervisor.Options{
		Config: cfg, Store: st, Launcher: runner.OSLauncher{Drain: 300 * time.Millisecond},
		StopGrace: 300 * time.Millisecond, WriteTimeout: time.Second,
	})
	opts := server.Options{Supervisor: f.sup, Version: "test", Machine: "testbox", StateDir: dir, MaxActiveRuns: cfg.MaxActiveRuns}
	if mod != nil {
		mod(&opts)
	}
	f.srv = server.New(opts)
	ln, err := server.Listen(f.sock)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { f.srv.Serve(ln); close(done) }()
	t.Cleanup(func() {
		f.sup.StopAll(300 * time.Millisecond)
		f.srv.Close()
		<-done
	})
	return f
}

func (f *fixture) dial() *client.Client {
	f.t.Helper()
	c, err := client.Dial(f.sock, "test")
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { c.Close() })
	return c
}

func (f *fixture) spec(id string, args ...string) model.SpawnSpec {
	return model.SpawnSpec{Run: id, Program: "agent", Args: args, Cwd: f.root}
}

func code(err error) string {
	var me *model.Error
	if errors.As(err, &me) {
		return me.Code
	}
	return "other: " + err.Error()
}

func drain(t *testing.T, sub *client.Subscription) []model.Record {
	t.Helper()
	var all []model.Record
	timeout := time.After(10 * time.Second)
	for {
		select {
		case r, ok := <-sub.Records:
			if !ok {
				return all
			}
			all = append(all, r)
		case <-timeout:
			t.Fatalf("timed out; got %d records", len(all))
		}
	}
}

func waitState(t *testing.T, c *client.Client, run string, want model.State) model.Summary {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		sum, err := c.Get(run)
		if err == nil && sum.State == want {
			return sum
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("run %s never reached %s", run, want)
	return model.Summary{}
}

func TestFullSession(t *testing.T) {
	f := newFixture(t, nil)
	c := f.dial()

	info, err := c.Info()
	if err != nil || info.Machine != "testbox" || info.PID != os.Getpid() {
		t.Fatalf("info %+v, %v", info, err)
	}
	if err := c.Ping(); err != nil {
		t.Fatal(err)
	}

	res, err := c.Spawn(f.spec("r1", "-hello", "ready"))
	if err != nil || res.State != model.StateRunning || res.Run != "r1" {
		t.Fatalf("spawn %+v, %v", res, err)
	}
	sub, err := c.Subscribe("r1", 0)
	if err != nil {
		t.Fatal(err)
	}
	if sub.Result.FirstSeq != 1 || sub.Result.State != model.StateRunning {
		t.Fatalf("subscribe result %+v", sub.Result)
	}
	if seq, err := c.Write("r1", "hello"); err != nil || seq == 0 {
		t.Fatalf("write %d, %v", seq, err)
	}
	if err := c.CloseStdin("r1"); err != nil {
		t.Fatal(err)
	}
	recs := drain(t, sub)
	if sub.Err() != nil {
		t.Fatalf("stream error: %v", sub.Err())
	}
	var out []string
	for _, r := range recs {
		if r.Kind == model.KindOut {
			out = append(out, r.Line)
		}
	}
	if strings.Join(out, "|") != "ready|echo:hello|eof" || recs[len(recs)-1].Kind != model.KindExit {
		t.Fatalf("records %+v", recs)
	}
	for i, r := range recs {
		if r.Seq != uint64(i+1) {
			t.Fatalf("seq %d at index %d", r.Seq, i)
		}
	}
	sum := waitState(t, c, "r1", model.StateExited)
	if sum.Exit == nil || sum.Exit.Reason != model.ReasonExited {
		t.Fatalf("summary %+v", sum)
	}
	runs, err := c.List(protocol.ListParams{State: model.StateExited})
	if err != nil || len(runs) != 1 {
		t.Fatalf("list %v, %v", runs, err)
	}
	if err := c.Forget("r1"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Get("r1"); code(err) != model.CodeNotFound {
		t.Fatalf("got %v", err)
	}
}

func TestErrorsAreReportedWithCodes(t *testing.T) {
	f := newFixture(t, nil)
	c := f.dial()
	if _, err := c.Spawn(model.SpawnSpec{Run: "x", Program: "sh", Cwd: f.root}); code(err) != model.CodeProgramNotAllowed {
		t.Fatalf("got %v", err)
	}
	if _, err := c.Write("nope", "x"); code(err) != model.CodeNotFound {
		t.Fatalf("got %v", err)
	}
	if _, err := c.Subscribe("nope", 0); code(err) != model.CodeNotFound {
		t.Fatalf("got %v", err)
	}
	if err := c.Stop("nope", 0); code(err) != model.CodeNotFound {
		t.Fatalf("got %v", err)
	}
	if _, err := c.Spawn(f.spec("e1")); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write("e1", "a\nb"); code(err) != model.CodeInvalidLine {
		t.Fatalf("got %v", err)
	}
	// The connection is still usable after errors.
	if err := c.Ping(); err != nil {
		t.Fatal(err)
	}
}

// raw talks to the daemon without the client library.
func rawConn(t *testing.T, f *fixture) (net.Conn, *bufio.Reader) {
	t.Helper()
	conn, err := net.Dial("unix", f.sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	return conn, bufio.NewReader(conn)
}

func readFrame(t *testing.T, br *bufio.Reader) map[string]any {
	t.Helper()
	line, err := br.ReadBytes('\n')
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(line, &m); err != nil {
		t.Fatalf("bad frame %q: %v", line, err)
	}
	return m
}

func TestHelloIsRequiredAndVersionChecked(t *testing.T) {
	f := newFixture(t, nil)

	conn, br := rawConn(t, f)
	io.WriteString(conn, `{"id":"1","op":"ping"}`+"\n")
	m := readFrame(t, br)
	if m["ok"] != false || m["error"].(map[string]any)["code"] != model.CodeBadRequest {
		t.Fatalf("got %v", m)
	}
	if _, err := br.ReadByte(); err == nil {
		t.Fatal("the connection should be closed after a request before hello")
	}

	conn, br = rawConn(t, f)
	io.WriteString(conn, `{"id":"1","op":"hello","proto":99}`+"\n")
	m = readFrame(t, br)
	e := m["error"].(map[string]any)
	if e["code"] != model.CodeUnsupportedProto || e["supported"].([]any)[0] != float64(protocol.Version) {
		t.Fatalf("got %v", m)
	}

	conn, br = rawConn(t, f)
	io.WriteString(conn, `{"id":"1","op":"hello","proto":1,"client":"raw","future_field":true}`+"\n")
	m = readFrame(t, br)
	if m["ok"] != true || m["re"] != "1" || m["proto"] != float64(1) {
		t.Fatalf("hello: %v", m)
	}
	io.WriteString(conn, "not json\n"+`{"id":"2","op":"nope"}`+"\n")
	if m = readFrame(t, br); m["ok"] != false {
		t.Fatalf("garbage: %v", m)
	}
	if m = readFrame(t, br); m["error"].(map[string]any)["code"] != model.CodeUnknownOp || m["re"] != "2" {
		t.Fatalf("unknown op: %v", m)
	}
}

func TestOversizedFrameClosesTheConnection(t *testing.T) {
	f := newFixture(t, func(o *server.Options) { o.MaxFrame = 4096 })
	conn, br := rawConn(t, f)
	io.WriteString(conn, `{"id":"1","op":"hello","proto":1}`+"\n")
	readFrame(t, br)
	io.WriteString(conn, strings.Repeat("x", 10000)+"\n")
	m := readFrame(t, br)
	if m["error"].(map[string]any)["code"] != model.CodeFrameTooLarge {
		t.Fatalf("got %v", m)
	}
	if _, err := br.ReadByte(); err == nil {
		t.Fatal("expected the connection to close")
	}
}

// The point of the daemon: a run does not care whether anyone is connected.
func TestRunSurvivesDisconnectAndResumesWithoutGaps(t *testing.T) {
	f := newFixture(t, nil)
	c1 := f.dial()
	if _, err := c1.Spawn(f.spec("long", "-hello", "up")); err != nil {
		t.Fatal(err)
	}
	sub, err := c1.Subscribe("long", 0)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		c1.Write("long", "one")
	}
	var seen []model.Record
	for len(seen) < 6 {
		select {
		case r := <-sub.Records:
			seen = append(seen, r)
		case <-time.After(10 * time.Second):
			t.Fatal("timeout")
		}
	}
	c1.Close() // the user closes the window

	time.Sleep(100 * time.Millisecond)
	c2 := f.dial()
	if sum := waitState(t, c2, "long", model.StateRunning); sum.Run != "long" {
		t.Fatal("the run must still be there")
	}
	for i := 0; i < 5; i++ {
		c2.Write("long", "while away")
	}
	last := seen[len(seen)-1].Seq
	sub2, err := c2.Subscribe("long", last+1)
	if err != nil {
		t.Fatal(err)
	}
	c2.CloseStdin("long")
	rest := drain(t, sub2)
	if rest[0].Seq != last+1 {
		t.Fatalf("resumed at %d, want %d", rest[0].Seq, last+1)
	}
	all := append(seen, rest...)
	for i, r := range all {
		if r.Seq != uint64(i+1) {
			t.Fatalf("gap or duplicate at %d: seq %d", i, r.Seq)
		}
	}
}

func TestSubscribeReplacesAndUnsubscribeStops(t *testing.T) {
	f := newFixture(t, nil)
	c := f.dial()
	c.Spawn(f.spec("s"))
	waitState(t, c, "s", model.StateRunning)
	first, err := c.Subscribe("s", 0)
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.Subscribe("s", 0) // replaces the first
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := <-first.Records; ok {
		// the start record may already have been delivered; the stream must end
		for range first.Records {
		}
	}
	<-second.Records // the start record
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	c.Write("s", "ping")
	time.Sleep(100 * time.Millisecond)
	if _, ok := <-second.Records; ok {
		t.Fatal("no records after unsubscribe")
	}
	c.CloseStdin("s")
}

func TestWatchSeesChanges(t *testing.T) {
	f := newFixture(t, nil)
	c := f.dial()
	c.Spawn(f.spec("old"))
	snap, w, err := c.Watch()
	if err != nil || len(snap) != 1 || snap[0].Run != "old" {
		t.Fatalf("snapshot %v, %v", snap, err)
	}
	c2 := f.dial() // another client's actions are seen too
	c2.Spawn(f.spec("new"))
	waitState(t, c2, "new", model.StateRunning)
	c2.CloseStdin("new")
	deadline := time.After(10 * time.Second)
	var states []model.State
	for {
		select {
		case ev := <-w.Events:
			if ev.Run == "new" {
				states = append(states, ev.State)
				if ev.State == model.StateExited {
					if ev.Exit == nil || ev.Exit.Reason != model.ReasonExited || ev.LastSeq == 0 {
						t.Fatalf("exit event %+v", ev)
					}
					return
				}
			}
		case <-deadline:
			t.Fatalf("saw %v", states)
		}
	}
}

func TestStderrOp(t *testing.T) {
	f := newFixture(t, nil)
	c := f.dial()
	spec := f.spec("e", "-stderr", "bad thing")
	spec.InitialInput = []string{"exit 2"}
	c.Spawn(spec)
	waitState(t, c, "e", model.StateExited)
	r, err := c.Stderr("e", 100)
	if err != nil || r.Text != "bad thing\n" || r.HeadDropped {
		t.Fatalf("%+v, %v", r, err)
	}
}

func TestShutdownRefusesWithActiveRuns(t *testing.T) {
	f := newFixture(t, nil)
	c := f.dial()
	c.Spawn(f.spec("busy"))
	waitState(t, c, "busy", model.StateRunning)
	if err := c.Shutdown(false); code(err) != model.CodeRunsActive {
		t.Fatalf("got %v", err)
	}
	select {
	case <-f.srv.ShutdownRequested():
		t.Fatal("shutdown must not be requested after a refusal")
	default:
	}
	if err := c.Shutdown(true); err != nil {
		t.Fatal(err)
	}
	select {
	case <-f.srv.ShutdownRequested():
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown was not requested")
	}
	if sum, _ := c.Get("busy"); sum.State != model.StateExited || sum.Exit.Reason != model.ReasonStopped {
		t.Fatalf("%+v", sum)
	}
}

func TestSocketPermissionsAndListen(t *testing.T) {
	f := newFixture(t, nil)
	st, err := os.Stat(f.sock)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode %v, %v", st.Mode(), err)
	}
	if _, err := server.Listen(f.sock); err == nil || !strings.Contains(err.Error(), "already") {
		t.Fatalf("a second daemon must be refused, got %v", err)
	}
	// A stale socket file (the daemon died) is replaced.
	stale := filepath.Join(filepath.Dir(f.sock), "stale.sock")
	l, _ := net.Listen("unix", stale)
	l.(*net.UnixListener).SetUnlinkOnClose(false)
	l.Close()
	ln, err := server.Listen(stale)
	if err != nil {
		t.Fatalf("stale socket: %v", err)
	}
	ln.Close()
}

// The SSH path: the client talks through the bridge, with junk from a login shell in front.
func TestBridgeCarriesTheProtocol(t *testing.T) {
	f := newFixture(t, nil)
	clientToBridgeR, clientToBridgeW := io.Pipe()
	bridgeToClientR, bridgeToClientW := io.Pipe()
	go func() {
		io.WriteString(bridgeToClientW, "Welcome to the VPS!\nLast login: yesterday\n")
		bridge.Run(f.sock, nil, clientToBridgeR, bridgeToClientW)
		bridgeToClientW.Close()
	}()
	rwc := struct {
		io.Reader
		io.Writer
		io.Closer
	}{bridgeToClientR, clientToBridgeW, closerFunc(func() error { clientToBridgeW.Close(); bridgeToClientR.Close(); return nil })}
	c := client.New(rwc, client.Options{ExpectBridge: true})
	defer c.Close()
	if _, err := c.Hello("via-bridge"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Spawn(f.spec("b1")); err != nil {
		t.Fatal(err)
	}
	sub, err := c.Subscribe("b1", 0)
	if err != nil {
		t.Fatal(err)
	}
	c.Write("b1", "over ssh")
	c.CloseStdin("b1")
	var out []string
	for _, r := range drain(t, sub) {
		if r.Kind == model.KindOut {
			out = append(out, r.Line)
		}
	}
	if strings.Join(out, "|") != "echo:over ssh|eof" {
		t.Fatalf("got %v", out)
	}
}

type closerFunc func() error

func (f closerFunc) Close() error { return f() }

func TestBridgeStartsTheDaemonWhenNobodyAnswers(t *testing.T) {
	dir, _ := os.MkdirTemp("", "mw")
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "none.sock")
	started := false
	in, inW := io.Pipe()
	var out strings.Builder
	errc := make(chan error, 1)
	go func() {
		errc <- bridge.Run(sock, func() error {
			started = true
			return errors.New("cannot start in this test")
		}, in, &out)
	}()
	select {
	case err := <-errc:
		if !started || err == nil || !strings.Contains(err.Error(), "starting the daemon") {
			t.Fatalf("got %v (started=%v)", err, started)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timeout")
	}
	inW.Close()
}
