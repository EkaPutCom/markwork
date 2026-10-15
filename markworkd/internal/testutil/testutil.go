// Package testutil has helpers for tests that need a real agent process.
package testutil

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"testing"
)

var (
	once    sync.Once
	binPath string
	binErr  error
	binDir  string
)

// FakeAgent builds testdata/fakeagent once per test binary and returns its path.
func FakeAgent(t testing.TB) string {
	t.Helper()
	once.Do(func() {
		_, file, _, _ := runtime.Caller(0)
		module := filepath.Join(filepath.Dir(file), "..", "..")
		binDir, binErr = os.MkdirTemp("", "markworkd-fakeagent-")
		if binErr != nil {
			return
		}
		binPath = filepath.Join(binDir, "fakeagent")
		cmd := exec.Command("go", "build", "-o", binPath, "./testdata/fakeagent")
		cmd.Dir = module
		if out, err := cmd.CombinedOutput(); err != nil {
			binErr = &buildError{err: err, out: string(out)}
		}
	})
	if binErr != nil {
		t.Fatalf("building fakeagent: %v", binErr)
	}
	return binPath
}

var (
	daemonOnce sync.Once
	daemonPath string
	daemonErr  error
)

// Markworkd builds cmd/markworkd once per test binary and returns its path; shims need the real binary.
func Markworkd(t testing.TB) string {
	t.Helper()
	daemonOnce.Do(func() {
		_, file, _, _ := runtime.Caller(0)
		module := filepath.Join(filepath.Dir(file), "..", "..")
		dir, err := os.MkdirTemp("", "markworkd-bin-")
		if err != nil {
			daemonErr = err
			return
		}
		daemonDir = dir
		daemonPath = filepath.Join(dir, "markworkd")
		cmd := exec.Command("go", "build", "-o", daemonPath, "./cmd/markworkd")
		cmd.Dir = module
		if out, err := cmd.CombinedOutput(); err != nil {
			daemonErr = &buildError{err: err, out: string(out)}
		}
	})
	if daemonErr != nil {
		t.Fatalf("building markworkd: %v", daemonErr)
	}
	return daemonPath
}

var daemonDir string

// KillAgents kills the process groups of runs that a test left running in the state directory. Agents that live under
// shims outlive a daemon that was killed on purpose; their shims end by themselves once the agent is gone.
func KillAgents(stateDir string) {
	metas, _ := filepath.Glob(filepath.Join(stateDir, "runs", "*", "meta.json"))
	for _, path := range metas {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var m struct {
			State string `json:"state"`
			PGID  int    `json:"pgid"`
		}
		if json.Unmarshal(data, &m) == nil && m.State == "running" && m.PGID > 1 {
			_ = syscall.Kill(-m.PGID, syscall.SIGKILL)
		}
	}
}

// Main runs the tests of a package and removes the built agent afterwards. Call it from TestMain.
func Main(m *testing.M) {
	code := m.Run()
	Cleanup()
	os.Exit(code)
}

// Cleanup removes the built agent; for packages that have their own TestMain.
func Cleanup() {
	if binDir != "" {
		os.RemoveAll(binDir)
	}
	if daemonDir != "" {
		os.RemoveAll(daemonDir)
	}
}

type buildError struct {
	err error
	out string
}

func (e *buildError) Error() string { return e.err.Error() + "\n" + e.out }
