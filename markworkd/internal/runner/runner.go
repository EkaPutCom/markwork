// Package runner starts one agent process and exposes its stdio. It knows nothing about runs, lanes or logs.
package runner

import (
	"bufio"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// Params describes the process to start.
type Params struct {
	Program string   // absolute path
	Args    []string // without argv[0]
	Dir     string
	Env     []string
	Stderr  io.Writer // receives the raw stderr bytes; must not block for long
}

// Line is one stdout line without its LF.
type Line struct {
	Text      string
	Truncated bool // the line was longer than the limit and only its start is kept
}

// Exit is how the process ended.
type Exit struct {
	Code     int  // valid when !Signaled
	Signal   int  // valid when Signaled
	Signaled bool // ended by a signal
}

var (
	ErrStdinClosed  = errors.New("runner: stdin is closed")
	ErrWriteTimeout = errors.New("runner: write to stdin timed out")
)

// Process is a started process.
type Process interface {
	// Stdout delivers the lines of stdout; it is closed once the process exited and the output was drained.
	Stdout() <-chan Line
	// Write sends one line (a LF is added) to stdin. After a timeout stdin is closed, because a half-written line
	// would corrupt the stream.
	Write(line string, timeout time.Duration) error
	CloseStdin() error
	// Signal sends sig to the whole process group. A group that is already gone is not an error.
	Signal(sig syscall.Signal) error
	// Wait blocks until the process exited and stdout and stderr were drained.
	Wait() Exit
	PID() int
}

// Launcher starts processes.
type Launcher interface {
	Start(p Params) (Process, error)
}

// OSLauncher starts real processes.
type OSLauncher struct {
	MaxLine int           // longest stdout line kept; the rest of a longer line is dropped
	Drain   time.Duration // how long to keep reading after the process exited (grandchildren may hold the pipe)
}

const (
	defaultMaxLine = 8 << 20
	defaultDrain   = 1500 * time.Millisecond
)

type osProcess struct {
	cmd    *exec.Cmd
	pid    int
	lines  chan Line
	done   chan struct{}
	exit   Exit
	stdinM sync.Mutex
	stdin  *os.File // nil once closed
}

func (l OSLauncher) Start(p Params) (Process, error) {
	maxLine, drain := l.MaxLine, l.Drain
	if maxLine <= 0 {
		maxLine = defaultMaxLine
	}
	if drain <= 0 {
		drain = defaultDrain
	}
	inR, inW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		return nil, err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		outR.Close()
		outW.Close()
		return nil, err
	}
	cmd := exec.Command(p.Program, p.Args...)
	cmd.Dir = p.Dir
	cmd.Env = p.Env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = inR, outW, errW
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	err = cmd.Start()
	// The child has its own copies now.
	inR.Close()
	outW.Close()
	errW.Close()
	if err != nil {
		inW.Close()
		outR.Close()
		errR.Close()
		return nil, err
	}

	pr := &osProcess{cmd: cmd, pid: cmd.Process.Pid, lines: make(chan Line, 64), done: make(chan struct{}), stdin: inW}

	stdoutDone := make(chan struct{})
	go func() {
		defer close(stdoutDone)
		defer close(pr.lines)
		splitLines(outR, maxLine, func(ln Line) { pr.lines <- ln })
	}()
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		dst := p.Stderr
		if dst == nil {
			dst = io.Discard
		}
		_, _ = io.Copy(dst, errR)
	}()

	go func() {
		err := cmd.Wait()
		pr.exit = exitOf(cmd, err)
		// A grandchild may inherit the pipes and keep them open; do not wait for it indefinitely.
		timer := time.NewTimer(drain)
		defer timer.Stop()
		for _, w := range []struct {
			done <-chan struct{}
			r    *os.File
		}{{stdoutDone, outR}, {stderrDone, errR}} {
			select {
			case <-w.done:
			case <-timer.C:
				w.r.Close() // unblocks the pending read
				<-w.done
				timer.Reset(0)
			}
		}
		outR.Close()
		errR.Close()
		pr.CloseStdin()
		close(pr.done)
	}()
	return pr, nil
}

func exitOf(cmd *exec.Cmd, err error) Exit {
	if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok {
		if ws.Signaled() {
			return Exit{Signal: int(ws.Signal()), Signaled: true}
		}
		return Exit{Code: ws.ExitStatus()}
	}
	if err != nil {
		return Exit{Code: -1}
	}
	return Exit{Code: cmd.ProcessState.ExitCode()}
}

// splitLines reads r, splitting at LF only (matching pi's JSONL framing; U+2028 and friends are not separators).
// A line longer than max keeps its first max bytes, is flagged, and the rest of it is skipped.
func splitLines(r io.Reader, max int, emit func(Line)) {
	br := bufio.NewReaderSize(r, 64<<10)
	var buf []byte
	truncated := false
	for {
		chunk, err := br.ReadSlice('\n')
		if len(chunk) > 0 {
			end := len(chunk)
			complete := chunk[end-1] == '\n'
			if complete {
				end--
			}
			if room := max - len(buf); room < end {
				if room > 0 {
					buf = append(buf, chunk[:room]...)
				}
				truncated = true
			} else {
				buf = append(buf, chunk[:end]...)
			}
			if complete {
				emit(Line{Text: string(buf), Truncated: truncated})
				buf, truncated = buf[:0], false
			}
		}
		if err == nil || errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if len(buf) > 0 || truncated {
			emit(Line{Text: string(buf), Truncated: truncated})
		}
		return
	}
}

func (p *osProcess) Stdout() <-chan Line { return p.lines }
func (p *osProcess) PID() int            { return p.pid }

func (p *osProcess) Wait() Exit {
	<-p.done
	return p.exit
}

func (p *osProcess) Write(line string, timeout time.Duration) error {
	p.stdinM.Lock()
	defer p.stdinM.Unlock()
	if p.stdin == nil {
		return ErrStdinClosed
	}
	if timeout > 0 {
		_ = p.stdin.SetWriteDeadline(time.Now().Add(timeout))
	}
	_, err := p.stdin.Write([]byte(line + "\n"))
	if err == nil {
		return nil
	}
	p.stdin.Close()
	p.stdin = nil
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return ErrWriteTimeout
	}
	return ErrStdinClosed // EPIPE: the process is gone
}

func (p *osProcess) CloseStdin() error {
	p.stdinM.Lock()
	defer p.stdinM.Unlock()
	if p.stdin == nil {
		return nil
	}
	err := p.stdin.Close()
	p.stdin = nil
	return err
}

func (p *osProcess) Signal(sig syscall.Signal) error {
	err := syscall.Kill(-p.pid, sig) // negative: the process group (Setpgid made pgid == pid)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
