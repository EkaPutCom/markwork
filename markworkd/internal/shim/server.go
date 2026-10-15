package shim

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/runner"
	"github.com/EkaPutCom/markwork/markworkd/internal/store"
)

const (
	spoolShrinkAbove = 1 << 20 // the spool is emptied when everything is acknowledged and it is larger than this
	startFailGrace   = 30 * time.Second
)

// ent is where a produced line sits in the spool.
type ent struct {
	off int64
	n   int
}

type shim struct {
	log  *slog.Logger
	spec Spec

	mu     sync.Mutex
	cond   *sync.Cond
	spool  *os.File
	size   int64 // end of the spool file
	base   uint64
	total  uint64
	ents   []ent // ents[i] is line base+i
	full   bool  // the spool reached its cap: later lines are dropped and the agent was stopped
	exited bool
	exit   Frame
	conn   *conn

	proc    runner.Process // nil when the agent could not be started
	startEr string

	dirty atomic.Bool // stderr had output since the last activity event
	quit  chan struct{}
	qonce sync.Once
}

// Main is `markworkd shim <run directory>`. It returns the process exit code.
func Main(dir string) int {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	data, err := os.ReadFile(dir + "/" + specName)
	if err != nil {
		log.Error("reading the spec", "err", err)
		return 1
	}
	_ = os.Remove(dir + "/" + specName) // it holds the agent's environment
	var spec Spec
	if err := json.Unmarshal(data, &spec); err != nil {
		log.Error("parsing the spec", "err", err)
		return 1
	}
	// The socket path is relative: a run directory can be too deep for the 108 bytes of a Unix socket address.
	if err := os.Chdir(dir); err != nil {
		log.Error("entering the run directory", "err", err)
		return 1
	}
	s := &shim{log: log, spec: spec, quit: make(chan struct{})}
	s.cond = sync.NewCond(&s.mu)
	return s.run()
}

func (s *shim) run() int {
	spool, err := os.OpenFile(spoolName, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		s.log.Error("opening the spool", "err", err)
		return 1
	}
	s.spool = spool
	_ = os.Remove(sockName)
	ln, err := net.Listen("unix", sockName)
	if err != nil {
		s.log.Error("listening", "err", err)
		return 1
	}
	_ = os.Chmod(sockName, 0o600)
	defer func() {
		ln.Close()
		_ = os.Remove(sockName)
		_ = os.Remove(spoolName)
	}()

	se, err := store.OpenStderr(stderrLog, s.spec.StderrMax)
	if err != nil {
		s.log.Error("opening stderr.log", "err", err)
		return 1
	}
	proc, err := runner.OSLauncher{MaxLine: s.spec.MaxLine}.Start(runner.Params{
		Program: s.spec.Program, Args: s.spec.Args, Dir: s.spec.Dir, Env: s.spec.Env,
		Stderr: &activityWriter{w: se, dirty: &s.dirty},
	})
	if err != nil {
		s.startEr = err.Error()
		time.AfterFunc(startFailGrace, s.stop)
	} else {
		s.proc = proc
		go s.produce()
	}

	go s.accept(ln)
	go s.activityTicker()
	<-s.quit
	return 0
}

func (s *shim) stop() { s.qonce.Do(func() { close(s.quit) }) }

type activityWriter struct {
	w     *store.Stderr
	dirty *atomic.Bool
}

func (a *activityWriter) Write(p []byte) (int, error) {
	a.dirty.Store(true)
	return a.w.Write(p)
}

// activityTicker tells the daemon at most once a second that the agent wrote to stderr (which counts as activity
// for the idle timeout, and which the daemon cannot see because the shim writes that file).
func (s *shim) activityTicker() {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			if s.dirty.Swap(false) {
				s.mu.Lock()
				c := s.conn
				s.mu.Unlock()
				if c != nil {
					_ = c.send(Frame{Ev: evActivity})
				}
			}
		case <-s.quit:
			return
		}
	}
}

// produce spools the agent's stdout lines, then records how it ended.
func (s *shim) produce() {
	for ln := range s.proc.Stdout() {
		s.append(ln)
	}
	ex := s.proc.Wait()
	s.mu.Lock()
	f := Frame{Ev: evExit, Code: ex.Code, Signal: ex.Signal, Signaled: ex.Signaled}
	if s.full {
		f.Reason, f.Error = "log_limit", "the daemon was away and the spooled output reached shim_spool_max_bytes"
	}
	s.exit, s.exited = f, true
	s.cond.Broadcast()
	s.mu.Unlock()
	if data, err := json.Marshal(f); err == nil {
		_ = os.WriteFile(exitName, data, 0o600)
	}
	time.AfterFunc(time.Duration(s.spec.LingerSec)*time.Second, s.stop)
}

func (s *shim) append(ln runner.Line) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.full {
		return
	}
	data, err := json.Marshal(Frame{Ev: evOut, N: s.total, Text: ln.Text, Truncated: ln.Truncated})
	if err != nil {
		return
	}
	data = append(data, '\n')
	if len(s.ents) > 0 && s.size-s.ents[0].off+int64(len(data)) > s.spec.SpoolMax {
		s.full = true
		_ = s.proc.Signal(syscall.SIGKILL)
		return
	}
	if _, err := s.spool.WriteAt(data, s.size); err != nil {
		s.log.Error("writing the spool", "err", err)
		s.full = true
		_ = s.proc.Signal(syscall.SIGKILL)
		return
	}
	s.ents = append(s.ents, ent{off: s.size, n: len(data)})
	s.size += int64(len(data))
	s.total++
	s.cond.Broadcast()
}

// ack: lines below n are in the daemon's log and no longer needed here.
func (s *shim) ack(n uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n > s.total {
		n = s.total
	}
	if n <= s.base {
		return
	}
	s.ents = s.ents[n-s.base:]
	s.base = n
	if s.base == s.total && s.size > spoolShrinkAbove {
		if err := s.spool.Truncate(0); err == nil {
			s.size = 0
			s.ents = nil
		}
	}
}

// ---------- connections ----------

type conn struct {
	c    net.Conn
	wmu  sync.Mutex
	dead atomic.Bool
}

func (c *conn) send(f Frame) error {
	data, err := json.Marshal(f)
	if err != nil {
		return err
	}
	return c.sendRaw(append(data, '\n'))
}

func (c *conn) sendRaw(data []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.c.SetWriteDeadline(time.Now().Add(30 * time.Second))
	_, err := c.c.Write(data)
	if err != nil {
		c.close()
	}
	return err
}

func (c *conn) close() {
	if c.dead.CompareAndSwap(false, true) {
		_ = c.c.Close()
	}
}

func (s *shim) accept(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			select {
			case <-s.quit:
			default:
				s.log.Error("accepting", "err", err)
			}
			return
		}
		go s.serve(&conn{c: c})
	}
}

// serve handles one daemon connection. A newer connection replaces an older one.
func (s *shim) serve(c *conn) {
	s.mu.Lock()
	old := s.conn
	s.conn = c
	hello := Frame{Ev: evHello, Proto: Proto, Lines: s.total, Acked: s.base, Exited: s.exited, Error: s.startEr}
	if s.proc != nil {
		hello.PID = s.proc.PID()
	}
	s.mu.Unlock()
	if old != nil {
		old.close()
		s.cond.Broadcast()
	}
	defer func() {
		c.close()
		s.mu.Lock()
		if s.conn == c {
			s.conn = nil
		}
		s.cond.Broadcast()
		s.mu.Unlock()
	}()
	if c.send(hello) != nil {
		return
	}
	br := bufio.NewReaderSize(c.c, 64<<10)
	attached := false
	for {
		line, err := br.ReadBytes('\n')
		if err != nil {
			return
		}
		var f Frame
		if json.Unmarshal(line, &f) != nil {
			continue
		}
		switch f.Op {
		case opAttach:
			if !attached {
				attached = true
				go s.send(c, f.From)
			}
		case opAck:
			s.ack(f.N)
		case opWrite:
			go s.write(c, f)
		case opCloseStdin:
			if s.proc != nil {
				_ = s.proc.CloseStdin()
			}
		case opBye:
			s.mu.Lock()
			done := s.exited || s.proc == nil
			s.mu.Unlock()
			if done {
				s.stop()
			}
			return
		}
	}
}

// send replays the spooled lines from `from`, then streams new ones, then reports how the agent ended.
func (s *shim) send(c *conn, from uint64) {
	pos := from
	for {
		s.mu.Lock()
		for !c.dead.Load() && pos >= s.total && !s.exited {
			s.cond.Wait()
		}
		if c.dead.Load() {
			s.mu.Unlock()
			return
		}
		if pos < s.total {
			if pos < s.base {
				msg := fmt.Sprintf("output lines %d..%d are no longer kept by the shim", pos, s.base)
				s.mu.Unlock()
				_ = c.send(Frame{Ev: evExit, Reason: "lost", Error: msg})
				c.close()
				return
			}
			e := s.ents[pos-s.base]
			buf := make([]byte, e.n)
			_, err := s.spool.ReadAt(buf, e.off)
			s.mu.Unlock()
			if err != nil && !errors.Is(err, io.EOF) {
				s.log.Error("reading the spool", "err", err)
				c.close()
				return
			}
			if c.sendRaw(buf) != nil {
				return
			}
			pos++
			continue
		}
		exit := s.exit // everything was sent and the agent ended
		s.mu.Unlock()
		_ = c.send(exit)
		return
	}
}

func (s *shim) write(c *conn, f Frame) {
	reply := Frame{Ev: evWrote, ID: f.ID}
	if s.proc == nil {
		reply.Error = errStdinClosed
	} else if err := s.proc.Write(f.Line, time.Duration(f.TimeoutMS)*time.Millisecond); err != nil {
		reply.Error = errStdinClosed
		if errors.Is(err, runner.ErrWriteTimeout) {
			reply.Error = errWriteTimeout
		}
	}
	_ = c.send(reply)
}
