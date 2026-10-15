package supervisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/config"
	"github.com/EkaPutCom/markwork/markworkd/internal/model"
	"github.com/EkaPutCom/markwork/markworkd/internal/runner"
	"github.com/EkaPutCom/markwork/markworkd/internal/store"
	"github.com/EkaPutCom/markwork/markworkd/internal/testutil"
)

func TestMain(m *testing.M) { testutil.Main(m) }

type env struct {
	t     *testing.T
	sup   *Supervisor
	st    *store.Store
	state string
	root  string
	agent string
	cfg   config.Config
	opts  Options
}

func newEnv(t *testing.T, mod func(*config.Config, *Options)) *env {
	t.Helper()
	e := &env{t: t, state: t.TempDir(), root: t.TempDir(), agent: testutil.FakeAgent(t)}
	e.cfg = config.Default()
	e.cfg.Roots = []string{e.root}
	e.cfg.Programs = map[string]string{"agent": e.agent}
	e.cfg.EnvAllow = []string{"T_*"}
	e.cfg.DefaultIdleTTLSec = 0
	e.opts = Options{StopGrace: 300 * time.Millisecond, IdleUnit: 20 * time.Millisecond, IdleGrace: 200 * time.Millisecond, WriteTimeout: time.Second}
	if mod != nil {
		mod(&e.cfg, &e.opts)
	}
	e.start()
	return e
}

// start (re)creates the supervisor over the same state directory, as a daemon restart would.
func (e *env) start() {
	e.t.Helper()
	st, err := store.Open(e.state)
	if err != nil {
		e.t.Fatal(err)
	}
	e.st = st
	o := e.opts
	o.Config, o.Store = e.cfg, st
	if o.Launcher == nil {
		o.Launcher = runner.OSLauncher{Drain: 300 * time.Millisecond}
	}
	e.sup = New(o)
	if err := e.sup.Recover(); err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { e.sup.StopAll(200 * time.Millisecond) })
}

func (e *env) spec(id string, args ...string) model.SpawnSpec {
	return model.SpawnSpec{Run: id, Program: "agent", Args: args, Cwd: e.root}
}

func (e *env) spawn(spec model.SpawnSpec) SpawnResult {
	e.t.Helper()
	res, err := e.sup.Spawn(spec)
	if err != nil {
		e.t.Fatalf("spawn %s: %v", spec.Run, err)
	}
	return res
}

func (e *env) wait(id string, state model.State) model.Summary {
	e.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		sum, err := e.sup.Get(id)
		if err == nil && sum.State == state {
			return sum
		}
		time.Sleep(10 * time.Millisecond)
	}
	sum, _ := e.sup.Get(id)
	e.t.Fatalf("run %s never reached %s (now %s)", id, state, sum.State)
	return sum
}

func (e *env) records(id string, from uint64) []model.Record {
	e.t.Helper()
	sub, err := e.sup.Subscribe(id, from)
	if err != nil {
		e.t.Fatal(err)
	}
	defer sub.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var all []model.Record
	for {
		recs, err := sub.Next(ctx)
		all = append(all, recs...)
		if errors.Is(err, io.EOF) {
			return all
		}
		if err != nil {
			e.t.Fatalf("subscription: %v", err)
		}
	}
}

func lines(recs []model.Record, kind model.Kind) []string {
	var out []string
	for _, r := range recs {
		if r.Kind == kind {
			out = append(out, r.Line)
		}
	}
	return out
}

func code(err error) string {
	var me *model.Error
	if errors.As(err, &me) {
		return me.Code
	}
	return fmt.Sprint(err)
}

func TestRunLifecycleAndReplay(t *testing.T) {
	e := newEnv(t, nil)
	res := e.spawn(e.spec("r1", "-hello", "ready"))
	if res.Existing || res.Summary.State == model.StateExited {
		t.Fatalf("spawn result %+v", res)
	}
	e.wait("r1", model.StateRunning)
	if seq, err := e.sup.Write("r1", "hello"); err != nil || seq == 0 {
		t.Fatalf("write: %d, %v", seq, err)
	}
	if err := e.sup.CloseStdin("r1"); err != nil {
		t.Fatal(err)
	}
	sum := e.wait("r1", model.StateExited)
	if sum.Exit == nil || sum.Exit.Reason != model.ReasonExited || sum.Exit.Code == nil || *sum.Exit.Code != 0 {
		t.Fatalf("exit %+v", sum.Exit)
	}
	recs := e.records("r1", 0)
	if got := lines(recs, model.KindOut); strings.Join(got, "|") != "ready|echo:hello|eof" {
		t.Fatalf("stdout %v", got)
	}
	if got := lines(recs, model.KindIn); len(got) != 1 || got[0] != "hello" {
		t.Fatalf("stdin %v", got)
	}
	if recs[0].Kind != model.KindStart || recs[len(recs)-1].Kind != model.KindExit {
		t.Fatalf("a log starts with start and ends with exit: %v", recs)
	}
	for i, r := range recs {
		if r.Seq != uint64(i+1) {
			t.Fatalf("record %d has seq %d", i, r.Seq)
		}
	}
	if sum.LastSeq != recs[len(recs)-1].Seq {
		t.Fatalf("summary last_seq %d, log ends at %d", sum.LastSeq, recs[len(recs)-1].Seq)
	}
	// Replay from the middle, and "only new" beyond the end.
	if got := e.records("r1", 3); len(got) != len(recs)-2 || got[0].Seq != 3 {
		t.Fatalf("replay from 3: %v", got)
	}
	if got := e.records("r1", 999); len(got) != 0 {
		t.Fatalf("beyond the end of a finished run gives nothing, got %v", got)
	}
	if _, err := e.sup.Write("r1", "late"); code(err) != model.CodeNotRunning {
		t.Fatalf("write to an exited run: %v", err)
	}
}

func TestSpawnValidation(t *testing.T) {
	e := newEnv(t, nil)
	other := t.TempDir()
	cases := map[string]struct {
		mod  func(*model.SpawnSpec)
		want string
	}{
		"bad id":         {func(s *model.SpawnSpec) { s.Run = "../x" }, model.CodeBadRequest},
		"no program":     {func(s *model.SpawnSpec) { s.Program = "" }, model.CodeBadRequest},
		"unknown prog":   {func(s *model.SpawnSpec) { s.Program = "sh" }, model.CodeProgramNotAllowed},
		"program path":   {func(s *model.SpawnSpec) { s.Program = "/bin/sh" }, model.CodeProgramNotAllowed},
		"cwd outside":    {func(s *model.SpawnSpec) { s.Cwd = other }, model.CodeCwdNotAllowed},
		"cwd relative":   {func(s *model.SpawnSpec) { s.Cwd = "x" }, model.CodeCwdNotAllowed},
		"env not listed": {func(s *model.SpawnSpec) { s.Env = map[string]string{"HOME": "/x"} }, model.CodeEnvNotAllowed},
		"bad input":      {func(s *model.SpawnSpec) { s.InitialInput = []string{"a\nb"} }, model.CodeInvalidLine},
		"negative ttl":   {func(s *model.SpawnSpec) { v := -1; s.IdleTTLSec = &v }, model.CodeBadRequest},
		"huge labels":    {func(s *model.SpawnSpec) { s.Labels = map[string]string{"k": strings.Repeat("v", 9000)} }, model.CodeLimitExceeded},
	}
	for name, c := range cases {
		spec := e.spec("v1")
		c.mod(&spec)
		if _, err := e.sup.Spawn(spec); code(err) != c.want {
			t.Errorf("%s: got %v, want code %s", name, err, c.want)
		}
	}
	// A rejected spawn leaves nothing behind.
	if ids, _ := e.st.RunIDs(); len(ids) != 0 {
		t.Fatalf("leftover runs %v", ids)
	}
	ok := e.spec("v2")
	ok.Env = map[string]string{"T_X": "1"}
	e.spawn(ok)
}

func TestSpawnIsIdempotent(t *testing.T) {
	e := newEnv(t, nil)
	spec := e.spec("same", "-hello", "x")
	spec.Labels = map[string]string{"card": "A"}
	first := e.spawn(spec)
	again := e.spawn(spec)
	if first.Existing || first.Summary.State != model.StateRunning || !again.Existing || again.Summary.Run != "same" {
		t.Fatalf("first %+v again %+v", first, again)
	}
	changed := spec
	changed.Args = []string{"-hello", "y"}
	if _, err := e.sup.Spawn(changed); code(err) != model.CodeConflict {
		t.Fatalf("different parameters: %v", err)
	}
	if n := len(e.sup.List(Filter{})); n != 1 {
		t.Fatalf("%d runs", n)
	}
}

func TestLanesRunOneAtATimeInOrder(t *testing.T) {
	e := newEnv(t, nil)
	a := e.spec("a")
	a.Lane = "proj"
	b := e.spec("b")
	b.Lane = "proj"
	c := e.spec("c")
	c.Lane = "proj"
	other := e.spec("other")
	other.Lane = "elsewhere"

	e.spawn(a)
	rb := e.spawn(b)
	rc := e.spawn(c)
	e.spawn(other)
	if rb.Summary.State != model.StateQueued || rb.Summary.QueuePosition != 1 || rc.Summary.QueuePosition != 2 {
		t.Fatalf("b %+v c %+v", rb.Summary, rc.Summary)
	}
	e.wait("a", model.StateRunning)
	e.wait("other", model.StateRunning) // another lane is not held up
	if _, err := e.sup.Write("b", "x"); code(err) != model.CodeNotStarted {
		t.Fatalf("writing to a queued run: %v", err)
	}

	e.sup.CloseStdin("a")
	e.wait("a", model.StateExited)
	e.wait("b", model.StateRunning)
	if sum, _ := e.sup.Get("c"); sum.State != model.StateQueued || sum.QueuePosition != 1 {
		t.Fatalf("c should now be first in line: %+v", sum)
	}
	e.sup.CloseStdin("b")
	e.wait("c", model.StateRunning)
	e.sup.CloseStdin("c")
	e.wait("c", model.StateExited)
	if q, r, _ := e.sup.Counts(); q != 0 || r != 1 {
		t.Fatalf("queued %d running %d", q, r)
	}
}

func TestLaneSlotsLetSeveralRunsGoAtOnce(t *testing.T) {
	e := newEnv(t, nil)
	spec := func(id string) model.SpawnSpec {
		s := e.spec(id)
		s.Lane, s.LaneSlots = "proj", 2
		return s
	}
	e.spawn(spec("a"))
	e.spawn(spec("b"))
	rc := e.spawn(spec("c"))
	rd := e.spawn(spec("d"))
	e.wait("a", model.StateRunning)
	e.wait("b", model.StateRunning)
	if rc.Summary.State != model.StateQueued || rc.Summary.QueuePosition != 1 || rd.Summary.QueuePosition != 2 {
		t.Fatalf("c %+v d %+v", rc.Summary, rd.Summary)
	}

	e.sup.CloseStdin("b")
	e.wait("b", model.StateExited)
	e.wait("c", model.StateRunning) // the freed slot goes to the first in line
	if sum, _ := e.sup.Get("d"); sum.State != model.StateQueued || sum.QueuePosition != 1 {
		t.Fatalf("d should wait for a slot: %+v", sum)
	}

	// A run that allows only one at a time waits until it would be alone, and keeps the ones behind it waiting.
	single := e.spec("single")
	single.Lane = "proj"
	e.spawn(single)
	e.sup.CloseStdin("a")
	e.wait("a", model.StateExited)
	e.wait("d", model.StateRunning)
	e.sup.CloseStdin("c")
	e.wait("c", model.StateExited)
	if sum, _ := e.sup.Get("single"); sum.State != model.StateQueued {
		t.Fatalf("single must wait while d runs: %+v", sum)
	}
	e.sup.CloseStdin("d")
	e.wait("single", model.StateRunning)
	e.sup.CloseStdin("single")
	e.wait("single", model.StateExited)

	bad := e.spec("bad")
	bad.LaneSlots = -1
	if _, err := e.sup.Spawn(bad); code(err) != model.CodeBadRequest {
		t.Fatalf("negative slots: %v", err)
	}
}

func TestCancelQueuedAndStopRunning(t *testing.T) {
	e := newEnv(t, nil)
	a := e.spec("a")
	a.Lane = "p"
	b := e.spec("b")
	b.Lane = "p"
	c := e.spec("c")
	c.Lane = "p"
	e.spawn(a)
	e.spawn(b)
	e.spawn(c)
	e.wait("a", model.StateRunning)

	if err := e.sup.Stop("b", 0); err != nil {
		t.Fatal(err)
	}
	sum := e.wait("b", model.StateExited)
	if sum.Exit.Reason != model.ReasonCanceled {
		t.Fatalf("exit %+v", sum.Exit)
	}
	if recs := e.records("b", 0); len(recs) != 1 || recs[0].Kind != model.KindExit {
		t.Fatalf("a canceled run only has an exit record: %v", recs)
	}
	if err := e.sup.Stop("b", 0); err != nil {
		t.Fatalf("stop must be idempotent: %v", err)
	}

	if err := e.sup.Stop("a", 0); err != nil {
		t.Fatal(err)
	}
	sum = e.wait("a", model.StateExited)
	if sum.Exit.Reason != model.ReasonStopped || sum.Exit.Signal == nil {
		t.Fatalf("exit %+v", sum.Exit)
	}
	e.wait("c", model.StateRunning) // the lane moved on, skipping the canceled run
}

func TestStopEscalatesToKill(t *testing.T) {
	e := newEnv(t, nil)
	e.spawn(e.spec("stubborn", "-ignore-term"))
	e.wait("stubborn", model.StateRunning)
	time.Sleep(100 * time.Millisecond)
	begin := time.Now()
	e.sup.Stop("stubborn", 300*time.Millisecond)
	sum := e.wait("stubborn", model.StateExited)
	if sum.Exit.Reason != model.ReasonStopped || sum.Exit.Signal == nil || *sum.Exit.Signal != 9 {
		t.Fatalf("exit %+v", sum.Exit)
	}
	if time.Since(begin) < 250*time.Millisecond {
		t.Fatal("SIGKILL came before the grace period")
	}
}

func TestInitialInputIsDeliveredEvenWhenQueued(t *testing.T) {
	e := newEnv(t, nil)
	a := e.spec("a")
	a.Lane = "p"
	b := e.spec("b")
	b.Lane = "p"
	b.InitialInput = []string{"first", "second", "exit 7"}
	e.spawn(a)
	e.spawn(b)
	e.wait("a", model.StateRunning)
	e.sup.CloseStdin("a")
	sum := e.wait("b", model.StateExited)
	if sum.Exit.Code == nil || *sum.Exit.Code != 7 {
		t.Fatalf("exit %+v", sum.Exit)
	}
	recs := e.records("b", 0)
	if got := strings.Join(lines(recs, model.KindOut), "|"); got != "echo:first|echo:second" {
		t.Fatalf("stdout %q", got)
	}
	if got := lines(recs, model.KindIn); len(got) != 3 {
		t.Fatalf("stdin %v", got)
	}
}

func TestIdleTimeout(t *testing.T) {
	e := newEnv(t, nil)
	ttl := 3 // 60ms with the test unit
	spec := e.spec("idle")
	spec.IdleTTLSec = &ttl
	e.spawn(spec)
	sum := e.wait("idle", model.StateExited)
	if sum.Exit.Reason != model.ReasonIdleTimeout {
		t.Fatalf("exit %+v", sum.Exit)
	}
	if got := lines(e.records("idle", 0), model.KindOut); len(got) != 1 || got[0] != "eof" {
		t.Fatalf("closing stdin should end the agent in an orderly way: %v", got)
	}
}

func TestIdleTimeoutWaitsForSubscribersAndActivity(t *testing.T) {
	e := newEnv(t, nil)
	ttl := 3
	spec := e.spec("busy")
	spec.IdleTTLSec = &ttl
	e.spawn(spec)
	e.wait("busy", model.StateRunning)

	sub, err := e.sup.Subscribe("busy", 0)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond) // five times the ttl
	if sum, _ := e.sup.Get("busy"); sum.State != model.StateRunning {
		t.Fatalf("a watched run must not time out: %+v", sum)
	}
	sub.Close()
	// Output counts as activity, including stderr.
	stop := time.After(250 * time.Millisecond)
	for tick := time.NewTicker(20 * time.Millisecond); ; {
		select {
		case <-tick.C:
			e.sup.Write("busy", "err still here")
			continue
		case <-stop:
		}
		break
	}
	if sum, _ := e.sup.Get("busy"); sum.State != model.StateRunning {
		t.Fatalf("a run with activity must not time out: %+v", sum)
	}
	if sum := e.wait("busy", model.StateExited); sum.Exit.Reason != model.ReasonIdleTimeout {
		t.Fatalf("exit %+v", sum.Exit)
	}
}

func TestLogLimitStopsTheRun(t *testing.T) {
	e := newEnv(t, func(c *config.Config, o *Options) { c.MaxLogBytes = 4096 })
	spec := e.spec("noisy")
	spec.InitialInput = []string{"big 3000", "big 3000", "big 3000", "big 3000"}
	e.spawn(spec)
	sum := e.wait("noisy", model.StateExited)
	if sum.Exit.Reason != model.ReasonLogLimit {
		t.Fatalf("exit %+v", sum.Exit)
	}
	recs := e.records("noisy", 0)
	if recs[len(recs)-1].Kind != model.KindExit {
		t.Fatal("the exit record is written even over the cap")
	}
	if sum.LogBytes > 4096+512 {
		t.Fatalf("log is %d bytes", sum.LogBytes)
	}
}

func TestStderrIsKeptApartFromTheLog(t *testing.T) {
	e := newEnv(t, nil)
	spec := e.spec("loud", "-stderr", "boot warning")
	spec.InitialInput = []string{"err it broke", "out fine", "exit 1"}
	e.spawn(spec)
	sum := e.wait("loud", model.StateExited)
	if sum.StderrBytes == 0 {
		t.Fatal("stderr_bytes should be set")
	}
	text, partial, err := e.sup.Stderr("loud", 0)
	if err != nil || partial || text != "boot warning\nit broke\n" {
		t.Fatalf("stderr %q partial=%v err=%v", text, partial, err)
	}
	for _, r := range e.records("loud", 0) {
		if r.Kind == model.KindOut && (strings.Contains(r.Line, "broke") || strings.Contains(r.Line, "warning")) {
			t.Fatalf("stderr leaked into the log: %+v", r)
		}
	}
	if _, _, err := e.sup.Stderr("nope", 0); code(err) != model.CodeNotFound {
		t.Fatalf("got %v", err)
	}
}

type failingLauncher struct{}

func (failingLauncher) Start(runner.Params) (runner.Process, error) {
	return nil, errors.New("exec: boom")
}

func TestStartFailureIsRecorded(t *testing.T) {
	e := newEnv(t, func(c *config.Config, o *Options) { o.Launcher = failingLauncher{} })
	a := e.spec("a")
	a.Lane = "p"
	b := e.spec("b")
	b.Lane = "p"
	e.spawn(a)
	e.spawn(b)
	sum := e.wait("a", model.StateExited)
	if sum.Exit.Reason != model.ReasonStartFailed || !strings.Contains(sum.Exit.Error, "boom") {
		t.Fatalf("exit %+v", sum.Exit)
	}
	e.wait("b", model.StateExited) // the failure must not block the lane
}

func TestSlowSubscriberDoesNotBlockAndLosesNothing(t *testing.T) {
	e := newEnv(t, nil)
	spec := e.spec("flood")
	const n = 3000
	for i := 0; i < n; i++ {
		spec.InitialInput = append(spec.InitialInput, fmt.Sprintf("out line-%d", i))
		if len(spec.InitialInput) == maxInitialLines {
			break
		}
	}
	e.spawn(spec)
	e.wait("flood", model.StateRunning)
	sub, err := e.sup.Subscribe("flood", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()
	for i := 0; i < 2000; i++ { // the subscriber is not reading while the run goes on
		e.sup.Write("flood", fmt.Sprintf("out more-%d", i))
	}
	e.sup.CloseStdin("flood")
	e.wait("flood", model.StateExited)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var next uint64 = 1
	for {
		recs, err := sub.Next(ctx)
		for _, r := range recs {
			if r.Seq != next {
				t.Fatalf("gap or duplicate: got seq %d, want %d", r.Seq, next)
			}
			next++
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if sum, _ := e.sup.Get("flood"); next != sum.LastSeq+1 {
		t.Fatalf("read up to %d, log ends at %d", next-1, sum.LastSeq)
	}
}

func TestSubscribeFollowsALiveRun(t *testing.T) {
	e := newEnv(t, nil)
	e.spawn(e.spec("live"))
	e.wait("live", model.StateRunning)
	sub, err := e.sup.Subscribe("live", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	recs, err := sub.Next(ctx) // the start record, already there
	if err != nil || recs[0].Kind != model.KindStart {
		t.Fatalf("%v %v", recs, err)
	}
	go func() {
		time.Sleep(50 * time.Millisecond)
		e.sup.Write("live", "ping")
	}()
	var got []string
	for len(got) < 2 {
		recs, err := sub.Next(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range recs {
			got = append(got, string(r.Kind)+":"+r.Line)
		}
	}
	if strings.Join(got, ",") != "in:ping,out:echo:ping" && strings.Join(got, ",") != "out:echo:ping,in:ping" {
		t.Fatalf("got %v", got)
	}
	// Cancelling the context ends a wait without ending the subscription.
	short, stop := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer stop()
	if _, err := sub.Next(short); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v", err)
	}
}

func TestWatchSnapshotAndEvents(t *testing.T) {
	e := newEnv(t, nil)
	e.spawn(e.spec("before"))
	e.wait("before", model.StateRunning)
	snap, w := e.sup.Watch()
	defer w.Close()
	if len(snap) != 1 || snap[0].Run != "before" {
		t.Fatalf("snapshot %+v", snap)
	}
	e.spawn(e.spec("after"))
	e.wait("after", model.StateRunning)
	e.sup.CloseStdin("after")
	var states []string
	timeout := time.After(10 * time.Second)
	for len(states) == 0 || states[len(states)-1] != "after:exited" {
		select {
		case sum := <-w.C():
			if sum.Run == "after" {
				states = append(states, sum.Run+":"+string(sum.State))
			}
		case <-timeout:
			t.Fatalf("saw %v", states)
		}
	}
	if states[0] != "after:queued" && states[0] != "after:running" {
		t.Fatalf("the first event for a new run should be its creation: %v", states)
	}
}

func TestWatchOverflowClosesTheWatcher(t *testing.T) {
	e := newEnv(t, nil)
	_, w := e.sup.Watch()
	e.spawn(e.spec("w"))
	e.wait("w", model.StateRunning)
	e.sup.mu.Lock()
	r := e.sup.runs["w"]
	for i := 0; i < watchBuffer+10; i++ {
		e.sup.emitLocked(r)
	}
	e.sup.mu.Unlock()
	if !w.Overflowed() {
		t.Fatal("watcher should have overflowed")
	}
	for range w.C() {
	}
	w.Close() // closing an already closed watcher is fine
}

func TestForgetAndRetention(t *testing.T) {
	now := time.Now()
	var mu sync.Mutex
	e := newEnv(t, func(c *config.Config, o *Options) {
		c.RetentionDays = 2
		o.Now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	})
	e.spawn(e.spec("live"))
	e.spawn(e.spec("done1"))
	e.spawn(e.spec("done2"))
	e.wait("live", model.StateRunning)
	for _, id := range []string{"done1", "done2"} {
		e.sup.CloseStdin(id)
		e.wait(id, model.StateExited)
	}
	if err := e.sup.Forget("live"); code(err) != model.CodeNotFinished {
		t.Fatalf("forget a live run: %v", err)
	}
	if err := e.sup.Forget("done1"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.sup.Get("done1"); code(err) != model.CodeNotFound {
		t.Fatalf("got %v", err)
	}
	if err := e.sup.Forget("nope"); code(err) != model.CodeNotFound {
		t.Fatalf("got %v", err)
	}
	if n := e.sup.Sweep(); n != 0 {
		t.Fatalf("nothing is old yet, swept %d", n)
	}
	mu.Lock()
	now = now.Add(3 * 24 * time.Hour)
	mu.Unlock()
	if n := e.sup.Sweep(); n != 1 {
		t.Fatalf("swept %d, want only the finished old run", n)
	}
	if _, err := e.sup.Get("live"); err != nil {
		t.Fatal("a running run must never be swept")
	}
	ids, _ := e.st.RunIDs()
	if len(ids) != 1 || ids[0] != "live" {
		t.Fatalf("on disk: %v", ids)
	}
}

func TestMaxActiveRuns(t *testing.T) {
	e := newEnv(t, func(c *config.Config, o *Options) { c.MaxActiveRuns = 2 })
	e.spawn(e.spec("a"))
	e.spawn(e.spec("b"))
	if _, err := e.sup.Spawn(e.spec("c")); code(err) != model.CodeLimitExceeded {
		t.Fatalf("got %v", err)
	}
	e.sup.CloseStdin("a")
	e.wait("a", model.StateExited)
	e.spawn(e.spec("c")) // finished runs do not count
}

func TestShutdownRefusesWithActiveRunsUnlessForced(t *testing.T) {
	e := newEnv(t, nil)
	a := e.spec("a")
	a.Lane = "p"
	b := e.spec("b")
	b.Lane = "p"
	e.spawn(a)
	e.spawn(b)
	e.wait("a", model.StateRunning)
	if err := e.sup.Shutdown(false); code(err) != model.CodeRunsActive {
		t.Fatalf("got %v", err)
	}
	if err := e.sup.Shutdown(true); err != nil {
		t.Fatal(err)
	}
	sum := e.wait("a", model.StateExited)
	if sum.Exit.Reason != model.ReasonStopped {
		t.Fatalf("an orderly stop is 'stopped', not 'lost': %+v", sum.Exit)
	}
	time.Sleep(100 * time.Millisecond)
	if sum, _ := e.sup.Get("b"); sum.State != model.StateQueued {
		t.Fatalf("b must stay queued for the next daemon, got %+v", sum)
	}
	if _, err := e.sup.Spawn(e.spec("late")); code(err) != model.CodeShuttingDown {
		t.Fatalf("got %v", err)
	}
}

func TestRestartMarksRunningLostAndRestartsQueued(t *testing.T) {
	e := newEnv(t, nil)
	a := e.spec("a")
	a.Lane = "p"
	b := e.spec("b", "-hello", "second ran")
	b.Lane = "p"
	b.Labels = map[string]string{"card": "B"}
	e.spawn(a)
	e.spawn(b)
	e.wait("a", model.StateRunning)

	// The daemon dies: its agents lose their pipes. Simulate by stopping the old supervisor abruptly and starting a
	// new one over the same state directory.
	meta, _ := e.st.LoadMeta("a")
	old := e.sup
	old.mu.Lock()
	old.stopping = true // so that the old one does not start b when a ends
	proc := old.runs["a"].proc
	old.mu.Unlock()
	proc.Signal(9)
	<-old.runs["a"].done
	// Rewrite the state as the crash would have left it: a still "running", with no exit record.
	e.rewind("a", meta)

	e.start()
	sum := e.wait("a", model.StateExited)
	if sum.Exit.Reason != model.ReasonLost {
		t.Fatalf("a: %+v", sum.Exit)
	}
	recs := e.records("a", 0)
	if recs[len(recs)-1].Kind != model.KindExit {
		t.Fatal("the lost run must end with an exit record")
	}
	// b was queued; the new daemon starts it.
	e.wait("b", model.StateRunning)
	if got := lines(e.records2("b"), model.KindOut); len(got) == 0 || got[0] != "second ran" {
		t.Fatalf("b stdout %v", got)
	}
	if sum, _ := e.sup.Get("b"); sum.Labels["card"] != "B" {
		t.Fatalf("labels must survive a restart: %+v", sum.Labels)
	}
}

// rewind restores a run's meta.json to its running state and removes the exit record, as a crash would leave it.
func (e *env) rewind(id string, meta *store.Meta) {
	e.t.Helper()
	meta.State, meta.Exit, meta.EndedAt = model.StateRunning, nil, 0
	if err := e.st.SaveMeta(id, meta); err != nil {
		e.t.Fatal(err)
	}
	path := e.st.LogPath(id)
	l, err := store.OpenLog(path, true)
	if err != nil {
		e.t.Fatal(err)
	}
	cur, _ := l.Seek(l.LastSeq())
	_ = cur
	data := mustRead(e.t, path)
	cut := strings.LastIndex(strings.TrimRight(data, "\n"), "\n")
	mustWrite(e.t, path, data[:cut+1])
}

// records2 reads what b has logged so far without waiting for it to end.
func (e *env) records2(id string) []model.Record {
	e.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		l, err := store.OpenLog(e.st.LogPath(id), true)
		if err == nil && l.LastSeq() >= 2 {
			c, _ := l.Seek(1)
			recs, _ := l.Read(&c, 100)
			return recs
		}
		time.Sleep(20 * time.Millisecond)
	}
	e.t.Fatal("no output")
	return nil
}

func TestRecoverSkipsAndCleansBrokenDirectories(t *testing.T) {
	e := newEnv(t, nil)
	e.spawn(e.spec("good"))
	e.wait("good", model.StateRunning)
	e.sup.CloseStdin("good")
	e.wait("good", model.StateExited)
	dir := filepath.Join(e.state, "runs", "halfmade")
	mustMkdir(t, dir)
	mustWrite(t, filepath.Join(e.state, "runs", "garbage", "x"), "")
	e.start()
	if _, err := e.sup.Get("good"); err != nil {
		t.Fatal(err)
	}
	// Directories without a meta.json were never completed; they are removed.
	if ids, _ := e.st.RunIDs(); len(ids) != 1 || ids[0] != "good" {
		t.Fatalf("ids %v", ids)
	}
}

// Whoever has read the exit record may immediately ask for the run's state: it must already be "exited".
func TestStateIsExitedAsSoonAsTheExitRecordIsVisible(t *testing.T) {
	e := newEnv(t, func(c *config.Config, o *Options) { c.MaxActiveRuns = 1000 })
	for i := 0; i < 150; i++ {
		id := fmt.Sprintf("q%d", i)
		spec := e.spec(id)
		spec.InitialInput = []string{"exit 0"}
		e.spawn(spec)
		sub, err := e.sup.Subscribe(id, 0)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		for {
			recs, err := sub.Next(ctx)
			if err != nil {
				t.Fatalf("%s: %v", id, err)
			}
			if recs[len(recs)-1].Kind == model.KindExit {
				break
			}
		}
		cancel()
		if sum, _ := e.sup.Get(id); sum.State != model.StateExited || sum.Exit == nil || sum.EndedAt == nil {
			t.Fatalf("%s: the exit record was visible but the state is %+v", id, sum)
		}
		sub.Close()
	}
	if q, r, _ := e.sup.Counts(); q != 0 || r != 0 {
		t.Fatalf("queued %d running %d after all runs ended", q, r)
	}
	if err := e.sup.Shutdown(false); err != nil {
		t.Fatalf("a shutdown right after the runs ended must not be refused: %v", err)
	}
}

// The daemon can die after the exit record is written but before meta.json is saved. The log has the truth.
func TestRecoveryTrustsAnExitRecordOverStaleMeta(t *testing.T) {
	e := newEnv(t, nil)
	spec := e.spec("done")
	spec.InitialInput = []string{"exit 5"}
	e.spawn(spec)
	e.wait("done", model.StateExited)

	meta, _ := e.st.LoadMeta("done")
	meta.State, meta.Exit, meta.EndedAt = model.StateRunning, nil, 0
	if err := e.st.SaveMeta("done", meta); err != nil {
		t.Fatal(err)
	}
	e.start()
	sum, err := e.sup.Get("done")
	if err != nil {
		t.Fatal(err)
	}
	if sum.State != model.StateExited || sum.Exit.Reason != model.ReasonExited || sum.Exit.Code == nil || *sum.Exit.Code != 5 {
		t.Fatalf("the real exit was lost: %+v", sum.Exit)
	}
	recs := e.records("done", 0)
	exits := 0
	for _, r := range recs {
		if r.Kind == model.KindExit {
			exits++
		}
	}
	if exits != 1 {
		t.Fatalf("a log has exactly one exit record, got %d", exits)
	}
}

func TestAgentEnvReachesTheAgentAndClientEnvCanOverrideIt(t *testing.T) {
	e := newEnv(t, func(c *config.Config, o *Options) {
		c.AgentEnv = map[string]string{"FROM_CONFIG": "fixed", "T_BOTH": "config"}
	})
	spec := e.spec("envs")
	spec.Env = map[string]string{"T_BOTH": "client"}
	spec.InitialInput = []string{"env FROM_CONFIG", "env T_BOTH", "exit 0"}
	e.spawn(spec)
	e.wait("envs", model.StateExited)
	if got := strings.Join(lines(e.records("envs", 0), model.KindOut), "|"); got != "env:fixed|env:client" {
		t.Fatalf("the agent saw %q", got)
	}
}
