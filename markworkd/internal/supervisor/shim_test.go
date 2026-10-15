package supervisor

import (
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/config"
	"github.com/EkaPutCom/markwork/markworkd/internal/model"
	"github.com/EkaPutCom/markwork/markworkd/internal/runner"
	"github.com/EkaPutCom/markwork/markworkd/internal/shim"
	"github.com/EkaPutCom/markwork/markworkd/internal/testutil"
)

// newShimEnv is newEnv with every agent running under a shim, started from the real markworkd binary.
func newShimEnv(t *testing.T, mod func(*config.Config, *Options)) *env {
	t.Helper()
	exe := testutil.Markworkd(t)
	return newEnv(t, func(c *config.Config, o *Options) {
		c.Shims = true
		o.Launcher = shim.Launcher{Exe: exe, Ready: 10 * time.Second}
		if mod != nil {
			mod(c, o)
		}
	})
}

// crash makes the current supervisor stop being the owner of its runs without stopping them, as the death of the
// daemon process does: its connections to the shims are gone, nothing was recorded.
func (e *env) crash() {
	e.t.Helper()
	e.sup.Detach()
	e.sup.mu.Lock()
	var procs []interface{ Release() }
	for _, r := range e.sup.runs {
		if rel, ok := r.proc.(interface{ Release() }); ok {
			procs = append(procs, rel)
		}
	}
	e.sup.mu.Unlock()
	for _, p := range procs {
		p.Release()
	}
}

func (e *env) waitLines(id string, want int) []string {
	e.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if got := lines(e.recordsNow(id), model.KindOut); len(got) >= want {
			return got
		}
		time.Sleep(10 * time.Millisecond)
	}
	e.t.Fatalf("run %s: fewer than %d output lines: %v", id, want, lines(e.recordsNow(id), model.KindOut))
	return nil
}

// recordsNow reads what is in the log now, without waiting for the run to end.
func (e *env) recordsNow(id string) []model.Record {
	e.t.Helper()
	r := e.sup.runs[id]
	cur, err := r.log.Seek(0)
	if err != nil {
		e.t.Fatal(err)
	}
	recs, err := r.log.Read(&cur, 100000)
	if err != nil {
		e.t.Fatal(err)
	}
	return recs
}

func TestShimRunAsUsual(t *testing.T) {
	e := newShimEnv(t, nil)
	e.spawn(e.spec("s1", "-hello", "ready", "-stderr", "oops"))
	e.waitLines("s1", 1)
	if _, err := e.sup.Write("s1", "out one"); err != nil {
		t.Fatal(err)
	}
	e.waitLines("s1", 2)
	if _, err := e.sup.Write("s1", "err trouble"); err != nil {
		t.Fatal(err)
	}
	e.sup.CloseStdin("s1")
	sum := e.wait("s1", model.StateExited)
	if sum.Exit.Reason != model.ReasonExited || sum.Exit.Code == nil || *sum.Exit.Code != 0 {
		t.Fatalf("exit = %+v", sum.Exit)
	}
	out := lines(e.records("s1", 0), model.KindOut)
	if want := []string{"ready", "one", "eof"}; !reflect.DeepEqual(out, want) {
		t.Fatalf("out = %v, want %v", out, want)
	}
	text, _, err := e.sup.Stderr("s1", 0)
	if err != nil || !strings.Contains(text, "oops") || !strings.Contains(text, "trouble") {
		t.Fatalf("stderr = %q, %v", text, err)
	}
	if sum.StderrBytes == 0 {
		t.Fatal("the summary should know the size of stderr.log")
	}
}

func TestShimRunSurvivesTheDaemon(t *testing.T) {
	e := newShimEnv(t, nil)
	e.spawn(e.spec("s2", "-hello", "ready"))
	e.waitLines("s2", 1)
	if _, err := e.sup.Write("s2", "out before"); err != nil {
		t.Fatal(err)
	}
	e.waitLines("s2", 2)
	pid := e.wait("s2", model.StateRunning).PID

	// The agent will print twice while there is no daemon.
	for _, l := range []string{"after 300 late-1", "after 400 late-2"} {
		if _, err := e.sup.Write("s2", l); err != nil {
			t.Fatal(err)
		}
	}
	e.crash()
	time.Sleep(900 * time.Millisecond)

	e.start() // the next daemon
	sum := e.wait("s2", model.StateRunning)
	if sum.PID != pid {
		t.Fatalf("the run should be the same process: pid %d, was %d", sum.PID, pid)
	}
	got := e.waitLines("s2", 4)
	if want := []string{"ready", "before", "late-1", "late-2"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("out = %v, want %v (every line once, in order)", got, want)
	}

	// The new daemon drives the same agent.
	if _, err := e.sup.Write("s2", "out after"); err != nil {
		t.Fatal(err)
	}
	e.waitLines("s2", 5)
	if _, err := e.sup.Write("s2", "exit 7"); err != nil {
		t.Fatal(err)
	}
	end := e.wait("s2", model.StateExited)
	if end.Exit.Reason != model.ReasonExited || end.Exit.Code == nil || *end.Exit.Code != 7 {
		t.Fatalf("exit = %+v", end.Exit)
	}
	all := e.records("s2", 0)
	for i, r := range all {
		if r.Seq != uint64(i+1) {
			t.Fatalf("record %d has seq %d", i, r.Seq)
		}
	}
	if want := []string{"ready", "before", "late-1", "late-2", "after"}; !reflect.DeepEqual(lines(all, model.KindOut), want) {
		t.Fatalf("out = %v", lines(all, model.KindOut))
	}
	// The shim goes once the exit is recorded.
	waitGone(t, filepath.Join(e.state, "runs", "s2", "shim.sock"))
}

func TestShimAgentEndsWhileNoDaemonIsThere(t *testing.T) {
	e := newShimEnv(t, nil)
	e.spawn(e.spec("s3", "-hello", "ready"))
	e.waitLines("s3", 1)
	if _, err := e.sup.Write("s3", "after 100 last-words"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.sup.Write("s3", "exitafter 250 3"); err != nil {
		t.Fatal(err)
	}
	e.crash()
	time.Sleep(900 * time.Millisecond)

	e.start()
	end := e.wait("s3", model.StateExited)
	if end.Exit.Reason != model.ReasonExited || end.Exit.Code == nil || *end.Exit.Code != 3 {
		t.Fatalf("exit = %+v, want code 3 delivered by the shim", end.Exit)
	}
	if want := []string{"ready", "last-words"}; !reflect.DeepEqual(lines(e.records("s3", 0), model.KindOut), want) {
		t.Fatalf("out = %v", lines(e.records("s3", 0), model.KindOut))
	}
}

func TestShimRunTakenOverKeepsItsLane(t *testing.T) {
	e := newShimEnv(t, nil)
	first := e.spec("l1", "-hello", "one")
	first.Lane = "proj"
	second := e.spec("l2", "-hello", "two")
	second.Lane = "proj"
	e.spawn(first)
	if res := e.spawn(second); res.Summary.State != model.StateQueued {
		t.Fatalf("the second run should wait, it is %s", res.Summary.State)
	}
	e.waitLines("l1", 1)
	e.crash()

	e.start()
	if sum, _ := e.sup.Get("l2"); sum.State != model.StateQueued {
		t.Fatalf("the queued run must not take the slot of the run that went on: %s", sum.State)
	}
	if _, err := e.sup.Write("l1", "exit 0"); err != nil {
		t.Fatal(err)
	}
	e.wait("l1", model.StateExited)
	e.wait("l2", model.StateRunning) // the slot was freed when the first one ended
	_ = e.sup.Stop("l2", 0)
	e.wait("l2", model.StateExited)
}

func TestShimGoneMeansLost(t *testing.T) {
	e := newShimEnv(t, func(c *config.Config, _ *Options) { c.ShimLingerSec = 1 })
	e.spawn(e.spec("s4", "-hello", "ready"))
	e.waitLines("s4", 1)
	e.crash()
	// Without its socket the shim cannot be reached: the same as a shim that was killed.
	if err := os.Remove(filepath.Join(e.state, "runs", "s4", "shim.sock")); err != nil {
		t.Fatal(err)
	}

	e.start()
	end := e.wait("s4", model.StateExited)
	if end.Exit.Reason != model.ReasonLost {
		t.Fatalf("exit = %+v, want lost", end.Exit)
	}
}

func TestShimDetachLeavesRunsAndRefusesNewOnes(t *testing.T) {
	e := newShimEnv(t, nil)
	e.spawn(e.spec("s5", "-hello", "ready"))
	e.waitLines("s5", 1)
	if err := e.sup.Shutdown(false, false); code(err) != model.CodeRunsActive {
		t.Fatalf("a plain shutdown is refused while a run is active: %v", err)
	}
	if err := e.sup.Shutdown(false, true); err != nil {
		t.Fatalf("detach: %v", err)
	}
	if sum, _ := e.sup.Get("s5"); sum.State != model.StateRunning {
		t.Fatalf("a detached daemon leaves the run going: %s", sum.State)
	}
	if _, err := e.sup.Spawn(e.spec("s6")); code(err) != model.CodeShuttingDown {
		t.Fatalf("spawn after detach: %v", err)
	}
	e.crash()
	e.start()
	e.wait("s5", model.StateRunning)
	_ = e.sup.Stop("s5", 0)
	e.wait("s5", model.StateExited)
}

func TestDetachNeedsShims(t *testing.T) {
	e := newEnv(t, func(c *config.Config, o *Options) {
		c.Shims = false
		o.Launcher = runner.OSLauncher{}
	})
	if err := e.sup.Shutdown(false, true); code(err) != model.CodeBadRequest {
		t.Fatalf("detach without shims: %v", err)
	}
}

func waitGone(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s still exists", path)
}

// shimPID finds the shim of a run by its command line.
func shimPID(t *testing.T, runDir string) int {
	t.Helper()
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		data, err := os.ReadFile("/proc/" + e.Name() + "/cmdline")
		if err == nil && strings.Contains(string(data), "shim\x00"+runDir) {
			return pid
		}
	}
	t.Fatalf("no shim for %s", runDir)
	return 0
}

func processAlive(pid int) bool {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	s := string(data)
	i := strings.LastIndexByte(s, ')')
	return i >= 0 && i+2 < len(s) && s[i+2] != 'Z' // a zombie is gone, only not reaped yet
}

// The shim is killed while the daemon is connected, and the agent does not end by itself when its stdin does: the
// run is lost, and the agent must not be left running with nobody to monitor it.
func TestShimKilledStopsAnAgentThatOutlivesIt(t *testing.T) {
	e := newShimEnv(t, nil)
	e.spawn(e.spec("s7", "-ignore-eof", "-hello", "ready"))
	e.waitLines("s7", 1)
	agent := e.wait("s7", model.StateRunning).PID
	if err := syscall.Kill(shimPID(t, filepath.Join(e.state, "runs", "s7")), syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}

	end := e.wait("s7", model.StateExited)
	if end.Exit.Reason != model.ReasonLost {
		t.Fatalf("exit = %+v, want lost", end.Exit)
	}
	deadline := time.Now().Add(5 * time.Second)
	for processAlive(agent) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if processAlive(agent) {
		t.Fatalf("the agent (pid %d) was left running without a shim", agent)
	}
}
