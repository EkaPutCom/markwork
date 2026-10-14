package runner

import (
	"bytes"
	"errors"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/testutil"
)

func TestMain(m *testing.M) { testutil.Main(m) }

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func start(t *testing.T, l OSLauncher, stderr *syncBuffer, args ...string) Process {
	t.Helper()
	p := Params{Program: testutil.FakeAgent(t), Args: args, Dir: t.TempDir(), Env: []string{"PATH=/usr/bin:/bin"}}
	if stderr != nil {
		p.Stderr = stderr
	}
	proc, err := l.Start(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { proc.Signal(syscall.SIGKILL); proc.Wait() })
	return proc
}

func collect(t *testing.T, proc Process) []Line {
	t.Helper()
	var out []Line
	timeout := time.After(10 * time.Second)
	for {
		select {
		case ln, ok := <-proc.Stdout():
			if !ok {
				return out
			}
			out = append(out, ln)
		case <-timeout:
			t.Fatal("timed out reading stdout")
		}
	}
}

func TestEchoAndCleanExit(t *testing.T) {
	proc := start(t, OSLauncher{}, nil, "-hello", "ready")
	if err := proc.Write("hello", time.Second); err != nil {
		t.Fatal(err)
	}
	if err := proc.Write("exit 3", time.Second); err != nil {
		t.Fatal(err)
	}
	lines := collect(t, proc)
	if len(lines) != 2 || lines[0].Text != "ready" || lines[1].Text != "echo:hello" {
		t.Fatalf("got %+v", lines)
	}
	if ex := proc.Wait(); ex.Signaled || ex.Code != 3 {
		t.Fatalf("exit %+v", ex)
	}
	if err := proc.Write("late", time.Second); !errors.Is(err, ErrStdinClosed) {
		t.Fatalf("write after exit: %v", err)
	}
}

func TestCloseStdinEndsTheAgent(t *testing.T) {
	proc := start(t, OSLauncher{}, nil)
	proc.Write("a", time.Second)
	if err := proc.CloseStdin(); err != nil {
		t.Fatal(err)
	}
	if err := proc.CloseStdin(); err != nil {
		t.Fatalf("closing twice must be fine: %v", err)
	}
	lines := collect(t, proc)
	if len(lines) != 2 || lines[1].Text != "eof" {
		t.Fatalf("got %+v", lines)
	}
	if ex := proc.Wait(); ex.Code != 0 || ex.Signaled {
		t.Fatalf("exit %+v", ex)
	}
}

func TestSplitsAtLFOnly(t *testing.T) {
	proc := start(t, OSLauncher{}, nil)
	// U+2028 inside a JSON string must not split the line; CR stays for the client to strip.
	proc.Write("out a b", time.Second)
	proc.Write("crlf", time.Second)
	proc.CloseStdin()
	lines := collect(t, proc)
	if len(lines) != 3 || lines[0].Text != "a b" || lines[1].Text != "with-cr\r" || lines[2].Text != "eof" {
		t.Fatalf("got %+v", lines)
	}
}

func TestLongLineIsTruncatedNotSplit(t *testing.T) {
	proc := start(t, OSLauncher{MaxLine: 1000}, nil)
	proc.Write("big 50000", time.Second)
	proc.Write("out after", time.Second)
	proc.CloseStdin()
	lines := collect(t, proc)
	if len(lines) != 3 {
		t.Fatalf("got %d lines", len(lines))
	}
	if !lines[0].Truncated || len(lines[0].Text) != 1000 || strings.Trim(lines[0].Text, "x") != "" {
		t.Fatalf("first line: truncated=%v len=%d", lines[0].Truncated, len(lines[0].Text))
	}
	if lines[1].Text != "after" || lines[1].Truncated {
		t.Fatalf("the line after the long one must be intact: %+v", lines[1])
	}
}

func TestStderrGoesToTheWriterSeparately(t *testing.T) {
	var errs syncBuffer
	proc := start(t, OSLauncher{}, &errs, "-stderr", "boot problem")
	proc.Write("err something broke", time.Second)
	proc.Write("out visible", time.Second)
	proc.CloseStdin()
	lines := collect(t, proc)
	proc.Wait()
	for _, ln := range lines {
		if strings.Contains(ln.Text, "broke") || strings.Contains(ln.Text, "boot") {
			t.Fatalf("stderr leaked into stdout: %q", ln.Text)
		}
	}
	if got := errs.String(); got != "boot problem\nsomething broke\n" {
		t.Fatalf("stderr: %q", got)
	}
}

func TestSignalTerminatesTheProcessGroup(t *testing.T) {
	proc := start(t, OSLauncher{}, nil, "-hold")
	time.Sleep(100 * time.Millisecond) // let the child start
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	collect(t, proc)
	ex := proc.Wait()
	if !ex.Signaled || ex.Signal != int(syscall.SIGTERM) {
		t.Fatalf("exit %+v", ex)
	}
	// The group is gone, so signalling it again is not an error.
	if err := proc.Signal(syscall.SIGKILL); err != nil {
		t.Fatalf("signal after exit: %v", err)
	}
}

func TestIgnoredTermNeedsKill(t *testing.T) {
	proc := start(t, OSLauncher{}, nil, "-ignore-term")
	time.Sleep(100 * time.Millisecond)
	proc.Signal(syscall.SIGTERM)
	select {
	case <-time.After(300 * time.Millisecond):
	case <-func() chan struct{} { c := make(chan struct{}); go func() { proc.Wait(); close(c) }(); return c }():
		t.Fatal("the process should have ignored SIGTERM")
	}
	proc.Signal(syscall.SIGKILL)
	collect(t, proc)
	if ex := proc.Wait(); !ex.Signaled || ex.Signal != int(syscall.SIGKILL) {
		t.Fatalf("exit %+v", ex)
	}
}

// A grandchild that inherited stdout keeps the pipe open after the agent exited. The run must still finish.
func TestGrandchildHoldingThePipeDoesNotBlock(t *testing.T) {
	proc := start(t, OSLauncher{Drain: 200 * time.Millisecond}, nil, "-hold")
	proc.Write("exit 0", time.Second)
	begin := time.Now()
	collect(t, proc)
	ex := proc.Wait()
	if elapsed := time.Since(begin); elapsed > 5*time.Second {
		t.Fatalf("took %v", elapsed)
	}
	if ex.Signaled || ex.Code != 0 {
		t.Fatalf("exit %+v", ex)
	}
	proc.Signal(syscall.SIGKILL) // the holder lives in the same group
}

func TestStartFailure(t *testing.T) {
	_, err := OSLauncher{}.Start(Params{Program: "/nonexistent/prog", Dir: t.TempDir()})
	if err == nil {
		t.Fatal("expected an error")
	}
	_, err = OSLauncher{}.Start(Params{Program: testutil.FakeAgent(t), Dir: "/nonexistent/dir"})
	if err == nil {
		t.Fatal("expected an error for a missing working directory")
	}
}

func TestWriteTimeoutClosesStdin(t *testing.T) {
	proc := start(t, OSLauncher{}, nil)
	proc.Write("sleep 5000", time.Second) // the agent stops reading
	big := strings.Repeat("y", 1<<20)
	var err error
	for i := 0; i < 8 && err == nil; i++ {
		err = proc.Write(big, 200*time.Millisecond)
	}
	if !errors.Is(err, ErrWriteTimeout) {
		t.Fatalf("got %v, want a write timeout", err)
	}
	if err := proc.Write("again", time.Second); !errors.Is(err, ErrStdinClosed) {
		t.Fatalf("after a timeout stdin must be closed, got %v", err)
	}
}

func TestSplitLinesUnit(t *testing.T) {
	var got []Line
	splitLines(strings.NewReader("a\nbbbbbb\nlast"), 4, func(l Line) { got = append(got, l) })
	want := []Line{{"a", false}, {"bbbb", true}, {"last", false}}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("line %d: got %+v want %+v", i, got[i], want[i])
		}
	}
}
