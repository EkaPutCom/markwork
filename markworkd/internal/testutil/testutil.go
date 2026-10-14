// Package testutil has helpers for tests that need a real agent process.
package testutil

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
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
}

type buildError struct {
	err error
	out string
}

func (e *buildError) Error() string { return e.err.Error() + "\n" + e.out }
