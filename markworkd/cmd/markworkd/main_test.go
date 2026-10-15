package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/client"
	"github.com/EkaPutCom/markwork/markworkd/internal/model"
	"github.com/EkaPutCom/markwork/markworkd/internal/testutil"
)

var (
	buildOnce sync.Once
	binPath   string
	buildDir  string
	buildErr  string
)

func TestMain(m *testing.M) {
	code := m.Run()
	if buildDir != "" {
		os.RemoveAll(buildDir)
	}
	testutil.Cleanup()
	os.Exit(code)
}

func binary(t *testing.T) string {
	t.Helper()
	buildOnce.Do(func() {
		_, file, _, _ := runtime.Caller(0)
		module := filepath.Join(filepath.Dir(file), "..", "..")
		var err error
		if buildDir, err = os.MkdirTemp("", "markworkd-bin-"); err != nil {
			buildErr = err.Error()
			return
		}
		binPath = filepath.Join(buildDir, "markworkd")
		cmd := exec.Command("go", "build", "-o", binPath, "./cmd/markworkd")
		cmd.Dir = module
		if out, err := cmd.CombinedOutput(); err != nil {
			buildErr = err.Error() + "\n" + string(out)
		}
	})
	if buildErr != "" {
		t.Fatalf("building markworkd: %s", buildErr)
	}
	return binPath
}

type daemonEnv struct {
	t     *testing.T
	bin   string
	dir   string
	sock  string
	state string
	conf  string
	root  string
}

func newDaemonEnv(t *testing.T) *daemonEnv { return newDaemonEnvWith(t, nil) }

// newDaemonEnvWith adds entries to config.json.
func newDaemonEnvWith(t *testing.T, extra map[string]any) *daemonEnv {
	t.Helper()
	dir, err := os.MkdirTemp("", "mwd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	e := &daemonEnv{t: t, bin: binary(t), dir: dir, sock: filepath.Join(dir, "s.sock"), state: filepath.Join(dir, "state"), conf: filepath.Join(dir, "config.json"), root: filepath.Join(dir, "proj")}
	os.Mkdir(e.root, 0o755)
	cfg := map[string]any{"roots": []string{e.root}, "programs": map[string]string{"agent": testutil.FakeAgent(t)}, "default_idle_ttl_sec": 0, "shim_linger_sec": 5}
	for k, v := range extra {
		cfg[k] = v
	}
	data, _ := json.Marshal(cfg)
	os.WriteFile(e.conf, data, 0o600)
	// Whatever the test leaves behind must not outlive it.
	t.Cleanup(func() { e.cli("stop", "--force"); testutil.KillAgents(e.state) })
	return e
}

func (e *daemonEnv) flags() []string {
	return []string{"--socket", e.sock, "--state-dir", e.state, "--config", e.conf}
}

func (e *daemonEnv) cli(args ...string) (string, int) {
	e.t.Helper()
	cmd := exec.Command(e.bin, append(args[:1:1], append(e.flags(), args[1:]...)...)...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		e.t.Fatal(err)
	}
	return out.String(), code
}

func (e *daemonEnv) dial() *client.Client {
	e.t.Helper()
	c, err := client.Dial(e.sock, "e2e")
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { c.Close() })
	return c
}

func (e *daemonEnv) spec(id string, args ...string) model.SpawnSpec {
	return model.SpawnSpec{Run: id, Program: "agent", Args: args, Cwd: e.root}
}

func (e *daemonEnv) wait(c *client.Client, run string, want model.State) model.Summary {
	e.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if sum, err := c.Get(run); err == nil && sum.State == want {
			return sum
		}
		time.Sleep(20 * time.Millisecond)
	}
	e.t.Fatalf("run %s never reached %s", run, want)
	return model.Summary{}
}

func TestStartIsIdempotentAndStopRefusesWithActiveRuns(t *testing.T) {
	e := newDaemonEnv(t)
	if out, code := e.cli("status"); code == 0 || !strings.Contains(out, "not running") {
		t.Fatalf("status before start: %q %d", out, code)
	}
	if out, code := e.cli("start"); code != 0 {
		t.Fatalf("start: %q %d", out, code)
	}
	if out, code := e.cli("start"); code != 0 {
		t.Fatalf("a second start must be fine: %q %d", out, code)
	}
	out, code := e.cli("status")
	if code != 0 || !strings.Contains(out, "markworkd") || !strings.Contains(out, "0 running") {
		t.Fatalf("status: %q %d", out, code)
	}

	c := e.dial()
	if _, err := c.Spawn(e.spec("job", "-hello", "working")); err != nil {
		t.Fatal(err)
	}
	if out, _ := e.cli("list"); !strings.Contains(out, "job") || !strings.Contains(out, "running") {
		t.Fatalf("list: %q", out)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if out, _ := e.cli("logs", "job"); strings.Contains(out, "working") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("logs never showed the agent's output")
		}
		time.Sleep(50 * time.Millisecond)
	}

	if out, code := e.cli("stop"); code == 0 || !strings.Contains(out, "runs_active") {
		t.Fatalf("stop with an active run must be refused: %q %d", out, code)
	}
	if out, code := e.cli("stop", "--force"); code != 0 || !strings.Contains(out, "stopped") {
		t.Fatalf("stop --force: %q %d", out, code)
	}
	// The forced stop was orderly: the run ended as stopped, with a complete log, not as lost.
	meta := readMeta(t, e, "job")
	if meta.State != model.StateExited || meta.Exit == nil || meta.Exit.Reason != model.ReasonStopped {
		t.Fatalf("meta after stop: %+v", meta)
	}
}

type metaFile struct {
	State model.State `json:"state"`
	Exit  *model.Exit `json:"exit"`
}

func readMeta(t *testing.T, e *daemonEnv, run string) metaFile {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(e.state, "runs", run, "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m metaFile
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// Without shims the agents are children of the daemon, so a stop of the daemon has to end them.
func TestSigtermStopsRunsInAnOrderlyWay(t *testing.T) {
	e := newDaemonEnvWith(t, map[string]any{"shims": false})
	cmd := exec.Command(e.bin, append([]string{"serve"}, e.flags()...)...)
	var logs bytes.Buffer
	cmd.Stderr = &logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	defer cmd.Process.Kill()
	waitSocket(t, e.sock)

	c := e.dial()
	a := e.spec("a")
	a.Lane = "p"
	b := e.spec("b")
	b.Lane = "p"
	c.Spawn(a)
	c.Spawn(b)
	e.wait(c, "a", model.StateRunning)

	cmd.Process.Signal(syscall.SIGTERM)
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("exit: %v\n%s", err, logs.String())
		}
	case <-time.After(15 * time.Second):
		t.Fatalf("the daemon did not stop\n%s", logs.String())
	}
	if m := readMeta(t, e, "a"); m.Exit == nil || m.Exit.Reason != model.ReasonStopped {
		t.Fatalf("a: %+v", m)
	}
	if m := readMeta(t, e, "b"); m.State != model.StateQueued {
		t.Fatalf("b must stay queued for the next start: %+v", m)
	}
	if _, err := os.Stat(e.sock); err == nil {
		t.Fatal("the socket file should be removed on exit")
	}

	// The next daemon picks up the queued run.
	if out, code := e.cli("start"); code != 0 {
		t.Fatalf("restart: %q", out)
	}
	c2 := e.dial()
	e.wait(c2, "b", model.StateRunning)
}

// kill -9 is the worst case: no orderly stop. The run that was active is "lost"; the queued one starts.
func TestCrashRecoveryWithoutShims(t *testing.T) {
	e := newDaemonEnvWith(t, map[string]any{"shims": false})
	cmd := exec.Command(e.bin, append([]string{"serve"}, e.flags()...)...)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go cmd.Wait()
	defer cmd.Process.Kill()
	waitSocket(t, e.sock)

	c := e.dial()
	a := e.spec("a")
	a.Lane = "p"
	b := e.spec("b", "-hello", "b is up")
	b.Lane = "p"
	c.Spawn(a)
	c.Spawn(b)
	e.wait(c, "a", model.StateRunning)

	cmd.Process.Signal(syscall.SIGKILL)
	time.Sleep(200 * time.Millisecond)
	if m := readMeta(t, e, "a"); m.State != model.StateRunning {
		t.Fatalf("the crash should have left a as running: %+v", m)
	}

	if out, code := e.cli("start"); code != 0 {
		t.Fatalf("start after a crash (stale socket, stale lock): %q", out)
	}
	c2 := e.dial()
	sum := e.wait(c2, "a", model.StateExited)
	if sum.Exit.Reason != model.ReasonLost {
		t.Fatalf("a: %+v", sum.Exit)
	}
	e.wait(c2, "b", model.StateRunning)
	if out, _ := e.cli("logs", "a"); !strings.Contains(out, "lost") {
		t.Fatalf("logs of the lost run: %q", out)
	}
}

// Starts `serve` in the foreground and returns the command and a channel with its exit status.
func (e *daemonEnv) serve() (*exec.Cmd, <-chan error) {
	e.t.Helper()
	cmd := exec.Command(e.bin, append([]string{"serve"}, e.flags()...)...)
	if err := cmd.Start(); err != nil {
		e.t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	e.t.Cleanup(func() { cmd.Process.Kill() })
	waitSocket(e.t, e.sock)
	return cmd, exited
}

func (e *daemonEnv) waitOut(c *client.Client, run string, want ...string) {
	e.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	var got []string
	for time.Now().Before(deadline) {
		got = got[:0]
		sub, err := c.Subscribe(run, 0)
		if err == nil {
			for len(got) < len(want) {
				select {
				case rec, ok := <-sub.Records:
					if !ok {
						goto done
					}
					if rec.Kind == model.KindOut {
						got = append(got, rec.Line)
					}
				case <-time.After(200 * time.Millisecond):
					goto done
				}
			}
		done:
			sub.Close()
		}
		if strings.Join(got, "|") == strings.Join(want, "|") {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	e.t.Fatalf("run %s: output %v, want %v", run, got, want)
}

// kill -9 on the daemon: the agent lives under its shim, so it goes on, and the next daemon takes it over,
// including what it printed while nobody was there.
func TestAgentSurvivesKillNineOfTheDaemon(t *testing.T) {
	e := newDaemonEnv(t)
	cmd, _ := e.serve()
	c := e.dial()
	a := e.spec("a", "-hello", "up")
	a.Lane = "p"
	b := e.spec("b", "-hello", "b is up")
	b.Lane = "p"
	c.Spawn(a)
	c.Spawn(b)
	pid := e.wait(c, "a", model.StateRunning).PID
	e.waitOut(c, "a", "up")
	if _, err := c.Write("a", "after 400 while-away"); err != nil {
		t.Fatal(err)
	}

	cmd.Process.Signal(syscall.SIGKILL)
	time.Sleep(700 * time.Millisecond)
	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatalf("the agent should still be alive: %v", err)
	}

	if out, code := e.cli("start"); code != 0 {
		t.Fatalf("start after a crash: %q", out)
	}
	c2 := e.dial()
	sum := e.wait(c2, "a", model.StateRunning)
	if sum.PID != pid {
		t.Fatalf("the same agent should be running: pid %d, was %d", sum.PID, pid)
	}
	e.waitOut(c2, "a", "up", "while-away")
	if sum, _ := c2.Get("b"); sum.State != model.StateQueued {
		t.Fatalf("b must keep waiting: the lane slot of a is taken: %s", sum.State)
	}
	if _, err := c2.Write("a", "exit 0"); err != nil {
		t.Fatal(err)
	}
	e.wait(c2, "a", model.StateExited)
	e.wait(c2, "b", model.StateRunning)
}

// SIGTERM (a service stop or restart) and `stop --detach` leave the runs to their shims.
func TestStopDetachAndSigtermLeaveRunsGoing(t *testing.T) {
	e := newDaemonEnv(t)
	_, exited := e.serve()
	c := e.dial()
	c.Spawn(e.spec("a", "-hello", "up"))
	e.wait(c, "a", model.StateRunning)

	if out, code := e.cli("stop", "--force", "--detach"); code == 0 {
		t.Fatalf("--force and --detach exclude each other: %q", out)
	}
	if out, code := e.cli("stop", "--detach"); code != 0 || !strings.Contains(out, "stopped") {
		t.Fatalf("stop --detach: %q %d", out, code)
	}
	<-exited
	if m := readMeta(t, e, "a"); m.State != model.StateRunning {
		t.Fatalf("a should be left running after stop --detach: %+v", m)
	}

	cmd, exited := e.serve() // the next daemon takes it over
	c2 := e.dial()
	e.wait(c2, "a", model.StateRunning)
	e.waitOut(c2, "a", "up")

	cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-exited:
	case <-time.After(15 * time.Second):
		t.Fatal("the daemon did not stop on SIGTERM")
	}
	if m := readMeta(t, e, "a"); m.State != model.StateRunning {
		t.Fatalf("a should be left running after SIGTERM: %+v", m)
	}

	e.serve() // and once more; the cleanup then stops it for good
	c3 := e.dial()
	e.wait(c3, "a", model.StateRunning)
	if _, err := c3.Write("a", "exit 0"); err != nil {
		t.Fatal(err)
	}
	e.wait(c3, "a", model.StateExited)
}

// systemd passes the listening socket as fd 3 and announces it with LISTEN_PID and LISTEN_FDS.
func TestSocketActivation(t *testing.T) {
	e := newDaemonEnv(t)
	ln := mustListen(t, e.sock)
	f, err := ln.File()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	// sh exports its own pid as LISTEN_PID and then becomes markworkd (exec keeps the pid), as systemd arranges.
	script := `LISTEN_PID=$$ LISTEN_FDS=1 exec "$0" serve "$@"`
	cmd := exec.Command("sh", append([]string{"-c", script, e.bin}, "--state-dir", e.state, "--config", e.conf, "--socket", filepath.Join(e.dir, "unused.sock"))...)
	cmd.ExtraFiles = []*os.File{f}
	var logs bytes.Buffer
	cmd.Stderr = &logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	defer cmd.Process.Kill()

	c := e.dial() // connects to the socket that the test holds; the daemon serves it
	if _, err := c.Spawn(e.spec("act")); err != nil {
		t.Fatalf("%v\n%s", err, logs.String())
	}
	e.wait(c, "act", model.StateRunning)
	if _, err := os.Stat(filepath.Join(e.dir, "unused.sock")); err == nil {
		t.Fatal("the daemon must use the inherited socket, not create its own")
	}
	// The agents must not inherit the activation variables or the listening socket.
	sub, err := c.Subscribe("act", 0)
	if err != nil {
		t.Fatal(err)
	}
	c.Write("act", "env LISTEN_FDS")
	c.Write("act", "env LISTEN_PID")
	c.Write("act", "sockets")
	var got []string
	for rec := range sub.Records {
		if rec.Kind == model.KindOut {
			got = append(got, rec.Line)
		}
		if len(got) == 3 {
			break
		}
	}
	if strings.Join(got, "|") != "env:<unset>|env:<unset>|sockets:0" {
		t.Fatalf("the agent saw %v", got)
	}
	cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-exited:
	case <-time.After(15 * time.Second):
		t.Fatalf("no exit\n%s", logs.String())
	}
}

func TestBridgeCommandCarriesTheProtocol(t *testing.T) {
	e := newDaemonEnv(t)
	cmd := exec.Command(e.bin, append([]string{"bridge"}, e.flags()...)...)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil { // no daemon yet: the bridge starts it
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	rwc := struct {
		*pipeReader
		*pipeWriter
	}{&pipeReader{stdout}, &pipeWriter{stdin}}
	c := client.New(rwcCloser{rwc, func() { stdin.Close() }}, client.Options{ExpectBridge: true})
	defer c.Close()
	info, err := hello(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(info, "markworkd") {
		t.Fatalf("hello: %q", info)
	}
}
