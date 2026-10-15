package shim

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/runner"
)

// Launcher starts agents under a shim and takes over agents whose shim is still running. It implements
// runner.Launcher and runner.Attacher.
type Launcher struct {
	Exe     string        // the markworkd binary that provides `shim`; the running executable when empty
	MaxLine int           // longest stdout line kept
	Ready   time.Duration // how long to wait for a new shim to answer (default 10 s)
}

var (
	_ runner.Launcher = Launcher{}
	_ runner.Attacher = Launcher{}
)

func (l Launcher) Start(p runner.Params) (runner.Process, error) {
	if p.StateDir == "" {
		return nil, errors.New("shim: no run directory")
	}
	exe := l.Exe
	if exe == "" {
		var err error
		if exe, err = os.Executable(); err != nil {
			return nil, err
		}
	}
	spec := Spec{
		Program: p.Program, Args: p.Args, Dir: p.Dir, Env: p.Env, MaxLine: l.MaxLine,
		StderrMax: p.StderrMax, SpoolMax: p.SpoolMax, LingerSec: p.LingerSec,
	}
	data, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(p.StateDir+"/"+specName, data, 0o600); err != nil {
		return nil, err
	}
	logf, err := os.OpenFile(p.StateDir+"/"+logName, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exe, "shim", p.StateDir)
	cmd.Env = withoutListenFDs(os.Environ())
	cmd.Stdout, cmd.Stderr = logf, logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} // in no session or group of the daemon
	err = cmd.Start()
	logf.Close()
	if err != nil {
		return nil, err
	}
	gone := make(chan struct{})
	go func() { _ = cmd.Wait(); close(gone) }() // the daemon is the shim's parent while it lives: reap it

	wait := l.Ready
	if wait <= 0 {
		wait = 10 * time.Second
	}
	deadline := time.Now().Add(wait)
	for {
		c, err := dial(p.StateDir)
		if err == nil {
			return attach(c, 0, p.Activity)
		}
		select {
		case <-gone:
			return nil, fmt.Errorf("the shim ended before it was ready: %s", lastLines(p.StateDir+"/"+logName))
		case <-time.After(10 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			_ = cmd.Process.Kill()
			return nil, fmt.Errorf("the shim did not answer within %s: %s", wait, lastLines(p.StateDir+"/"+logName))
		}
	}
}

func (l Launcher) Attach(stateDir string, from uint64) (runner.Process, error) {
	c, err := dial(stateDir)
	if err != nil {
		return nil, err
	}
	return attach(c, from, nil)
}

func withoutListenFDs(env []string) []string {
	out := env[:0:0]
	for _, e := range env {
		if !strings.HasPrefix(e, "LISTEN_") {
			out = append(out, e)
		}
	}
	return out
}

func lastLines(path string) string {
	data, err := os.ReadFile(path)
	if err != nil || len(strings.TrimSpace(string(data))) == 0 {
		return "(no output)"
	}
	s := strings.TrimSpace(string(data))
	if len(s) > 400 {
		s = s[len(s)-400:]
	}
	return s
}

// dial connects to the shim of a run. A run directory can be too deep for a socket address, so a long path goes
// through a descriptor of the directory.
func dial(stateDir string) (net.Conn, error) {
	path := stateDir + "/" + sockName
	if len(path) >= 100 {
		d, err := os.Open(stateDir)
		if err != nil {
			return nil, err
		}
		defer d.Close()
		path = fmt.Sprintf("/proc/self/fd/%d/%s", d.Fd(), sockName)
	}
	return net.DialTimeout("unix", path, 2*time.Second)
}

// ---------- the process over the socket ----------

type proc struct {
	c        net.Conn
	wmu      sync.Mutex
	pid      int
	activity func()

	lines chan runner.Line
	done  chan struct{}
	exit  runner.Exit

	mu      sync.Mutex
	nextID  int64
	waiters map[int64]chan string
}

func attach(c net.Conn, from uint64, activity func()) (runner.Process, error) {
	br := bufio.NewReaderSize(c, 64<<10)
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	line, err := br.ReadBytes('\n')
	if err != nil {
		c.Close()
		return nil, fmt.Errorf("reading the shim's hello: %w", err)
	}
	_ = c.SetReadDeadline(time.Time{})
	var hello Frame
	if err := json.Unmarshal(line, &hello); err != nil || hello.Ev != evHello {
		c.Close()
		return nil, errors.New("the shim did not say hello")
	}
	if hello.Proto != Proto {
		c.Close()
		return nil, fmt.Errorf("the shim speaks protocol %d, this daemon %d", hello.Proto, Proto)
	}
	if hello.Error != "" {
		c.Close()
		return nil, errors.New(hello.Error)
	}
	p := &proc{c: c, pid: hello.PID, activity: activity, lines: make(chan runner.Line), done: make(chan struct{}), waiters: map[int64]chan string{}}
	if err := p.send(Frame{Op: opAttach, From: from}); err != nil {
		c.Close()
		return nil, err
	}
	go p.read(br)
	return p, nil
}

func (p *proc) send(f Frame) error {
	data, err := json.Marshal(f)
	if err != nil {
		return err
	}
	p.wmu.Lock()
	defer p.wmu.Unlock()
	_ = p.c.SetWriteDeadline(time.Now().Add(30 * time.Second))
	_, err = p.c.Write(append(data, '\n'))
	return err
}

// read delivers the shim's events. A line is acknowledged when the next one is taken: the channel has no buffer, so
// when line n was received the consumer is through with line n-1, which is then in the log.
func (p *proc) read(br *bufio.Reader) {
	defer func() {
		close(p.lines)
		close(p.done)
		p.mu.Lock()
		for _, w := range p.waiters {
			close(w)
		}
		p.waiters = map[int64]chan string{}
		p.mu.Unlock()
	}()
	for {
		raw, err := br.ReadBytes('\n')
		if err != nil {
			p.exit = runner.Exit{Lost: true}
			return
		}
		var f Frame
		if json.Unmarshal(raw, &f) != nil {
			continue
		}
		switch f.Ev {
		case evOut:
			p.lines <- runner.Line{Text: f.Text, Truncated: f.Truncated}
			_ = p.send(Frame{Op: opAck, N: f.N})
		case evActivity:
			if p.activity != nil {
				p.activity()
			}
		case evWrote:
			p.mu.Lock()
			w := p.waiters[f.ID]
			delete(p.waiters, f.ID)
			p.mu.Unlock()
			if w != nil {
				w <- f.Error
			}
		case evExit:
			p.exit = runner.Exit{Code: f.Code, Signal: f.Signal, Signaled: f.Signaled, Reason: f.Reason, Error: f.Error, Lost: f.Reason == "lost"}
			return
		}
	}
}

func (p *proc) Stdout() <-chan runner.Line { return p.lines }
func (p *proc) PID() int                   { return p.pid }

func (p *proc) Wait() runner.Exit {
	<-p.done
	return p.exit
}

func (p *proc) Write(line string, timeout time.Duration) error {
	reply := make(chan string, 1)
	p.mu.Lock()
	p.nextID++
	id := p.nextID
	select {
	case <-p.done:
		p.mu.Unlock()
		return runner.ErrStdinClosed
	default:
	}
	p.waiters[id] = reply
	p.mu.Unlock()
	if err := p.send(Frame{Op: opWrite, ID: id, Line: line, TimeoutMS: timeout.Milliseconds()}); err != nil {
		return runner.ErrStdinClosed
	}
	select {
	case e, ok := <-reply:
		switch {
		case !ok || e == errStdinClosed:
			return runner.ErrStdinClosed
		case e == errWriteTimeout:
			return runner.ErrWriteTimeout
		}
		return nil
	case <-time.After(timeout + 5*time.Second):
		return runner.ErrWriteTimeout
	}
}

func (p *proc) CloseStdin() error {
	if err := p.send(Frame{Op: opCloseStdin}); err != nil {
		return runner.ErrStdinClosed
	}
	return nil
}

// Signal goes straight to the agent's process group (the agent is its own group leader): it needs no help from the
// shim, so it also works when the connection is gone.
func (p *proc) Signal(sig syscall.Signal) error {
	if p.pid <= 0 {
		return nil
	}
	err := syscall.Kill(-p.pid, sig)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

// Release tells the shim that the end of the run is in the log, so it can go.
func (p *proc) Release() {
	_ = p.send(Frame{Op: opBye})
	p.c.Close()
}
