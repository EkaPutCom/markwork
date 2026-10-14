// Package server serves the markworkd protocol on a listener.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"sync"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/model"
	"github.com/EkaPutCom/markwork/markworkd/internal/protocol"
	"github.com/EkaPutCom/markwork/markworkd/internal/supervisor"
)

// Options configure a Server.
type Options struct {
	Supervisor    *supervisor.Supervisor
	Logger        *slog.Logger
	Version       string // shown as "markworkd <version>"
	Machine       string
	StateDir      string
	MaxActiveRuns int
	MaxFrame      int           // default protocol.MaxFrame
	WriteTimeout  time.Duration // a stalled client is disconnected after this (default 30s)
	AnyUser       bool          // skip the peer uid check (tests over a non-socket transport)
}

// Server accepts connections and runs one session per connection.
type Server struct {
	opts      Options
	sup       *supervisor.Supervisor
	log       *slog.Logger
	startedAt time.Time

	mu       sync.Mutex
	ln       net.Listener
	conns    map[net.Conn]struct{}
	closed   bool
	shutdown chan struct{}
	shutOnce sync.Once
	wg       sync.WaitGroup
}

func New(o Options) *Server {
	if o.Logger == nil {
		o.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if o.MaxFrame <= 0 {
		o.MaxFrame = protocol.MaxFrame
	}
	if o.WriteTimeout <= 0 {
		o.WriteTimeout = 30 * time.Second
	}
	return &Server{opts: o, sup: o.Supervisor, log: o.Logger, startedAt: time.Now(), conns: map[net.Conn]struct{}{}, shutdown: make(chan struct{})}
}

// ShutdownRequested is closed when a client asked the daemon to stop (the shutdown op was accepted).
func (s *Server) ShutdownRequested() <-chan struct{} { return s.shutdown }

func (s *Server) requestShutdown() { s.shutOnce.Do(func() { close(s.shutdown) }) }

// Serve accepts connections until the listener is closed. It returns nil after Close.
func (s *Server) Serve(ln net.Listener) error {
	s.mu.Lock()
	s.ln = ln
	s.mu.Unlock()
	for {
		c, err := ln.Accept()
		if err != nil {
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if closed || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			c.Close()
			return nil
		}
		s.conns[c] = struct{}{}
		s.wg.Add(1)
		s.mu.Unlock()
		go func() {
			defer s.wg.Done()
			s.serveConn(c)
			s.mu.Lock()
			delete(s.conns, c)
			s.mu.Unlock()
		}()
	}
}

// Close stops accepting, disconnects every client and waits for the sessions to end. Runs are not affected.
func (s *Server) Close() {
	s.mu.Lock()
	s.closed = true
	if s.ln != nil {
		s.ln.Close()
	}
	for c := range s.conns {
		c.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
}

func (s *Server) serveConn(c net.Conn) {
	defer c.Close()
	defer func() {
		if r := recover(); r != nil {
			s.log.Error("session panicked", "panic", r)
		}
	}()
	if !s.opts.AnyUser {
		if err := checkPeer(c); err != nil {
			s.log.Warn("connection refused", "err", err)
			return
		}
	}
	newSession(s, c).run()
}

// ---------- session ----------

type deadlineWriter struct {
	c       net.Conn
	timeout time.Duration
}

func (w deadlineWriter) Write(p []byte) (int, error) {
	_ = w.c.SetWriteDeadline(time.Now().Add(w.timeout))
	return w.c.Write(p)
}

type subState struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type session struct {
	srv     *Server
	conn    net.Conn
	enc     *protocol.Encoder
	dec     *protocol.Decoder
	ctx     context.Context
	cancel  context.CancelFunc
	helloed bool

	mu    sync.Mutex
	subs  map[string]*subState
	watch *supervisor.Watcher
	wg    sync.WaitGroup
}

func newSession(s *Server, c net.Conn) *session {
	ctx, cancel := context.WithCancel(context.Background())
	return &session{
		srv: s, conn: c, ctx: ctx, cancel: cancel, subs: map[string]*subState{},
		enc: protocol.NewEncoder(deadlineWriter{c: c, timeout: s.opts.WriteTimeout}),
		dec: protocol.NewDecoder(c, s.opts.MaxFrame),
	}
}

func (ss *session) run() {
	defer ss.cleanup()
	for {
		frame, err := ss.dec.Next()
		if err != nil {
			if errors.Is(err, protocol.ErrFrameTooLarge) {
				ss.fail("", model.Errf(model.CodeFrameTooLarge, "a frame is larger than %d bytes", ss.srv.opts.MaxFrame))
			}
			return
		}
		var env protocol.Envelope
		if err := json.Unmarshal(frame, &env); err != nil || env.Op == "" {
			ss.fail(env.ID, model.Errf(model.CodeBadRequest, "a request is a JSON object with an op"))
			continue
		}
		if !ss.helloed && env.Op != protocol.OpHello {
			ss.fail(env.ID, model.Errf(model.CodeBadRequest, "hello must be the first request"))
			return
		}
		if !ss.dispatch(env, frame) {
			return
		}
	}
}

func (ss *session) cleanup() {
	ss.cancel()
	ss.mu.Lock()
	w := ss.watch
	ss.watch = nil
	ss.mu.Unlock()
	if w != nil {
		w.Close()
	}
	ss.conn.Close()
	ss.wg.Wait()
}

func (ss *session) ok(id string, result any) {
	b, err := protocol.EncodeResponse(id, result)
	if err != nil {
		ss.fail(id, model.Errf(model.CodeInternal, "%v", err))
		return
	}
	ss.send(b)
}

func (ss *session) fail(id string, err error) {
	var me *model.Error
	if !errors.As(err, &me) {
		me = model.Errf(model.CodeInternal, "%v", err)
	}
	ss.send(protocol.EncodeError(id, me))
}

func (ss *session) send(frame []byte) {
	if err := ss.enc.Send(frame); err != nil {
		ss.conn.Close() // the reader loop then ends
	}
}

func (ss *session) event(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		ss.srv.log.Error("encoding an event failed", "err", err)
		return
	}
	ss.send(b)
}

// parse decodes the request's parameters; unknown fields are ignored so newer clients keep working.
func parse[T any](ss *session, id string, frame []byte) (T, bool) {
	var p T
	if err := json.Unmarshal(frame, &p); err != nil {
		ss.fail(id, model.Errf(model.CodeBadRequest, "invalid parameters: %v", err))
		return p, false
	}
	return p, true
}

// dispatch handles one request. It returns false when the connection should be closed.
func (ss *session) dispatch(env protocol.Envelope, frame []byte) bool {
	sup := ss.srv.sup
	id := env.ID
	switch env.Op {
	case protocol.OpHello:
		p, ok := parse[protocol.HelloParams](ss, id, frame)
		if !ok {
			return true
		}
		if p.Proto != protocol.Version {
			e := model.Errf(model.CodeUnsupportedProto, "protocol %d is not supported", p.Proto)
			e.Supported = []int{protocol.Version}
			ss.fail(id, e)
			return false
		}
		ss.helloed = true
		ss.ok(id, protocol.HelloResult{
			Proto: protocol.Version, Daemon: "markworkd " + ss.srv.opts.Version, Machine: ss.srv.opts.Machine,
			PID: os.Getpid(), Features: []string{"watch", "stderr", "lanes"},
		})
	case protocol.OpPing:
		ss.ok(id, nil)
	case protocol.OpInfo:
		q, r, x := sup.Counts()
		ss.ok(id, protocol.InfoResult{
			Daemon: "markworkd " + ss.srv.opts.Version, Machine: ss.srv.opts.Machine, PID: os.Getpid(),
			StartedAt: ss.srv.startedAt.UnixMilli(), StateDir: ss.srv.opts.StateDir,
			Queued: q, Running: r, Exited: x, MaxActiveRuns: ss.srv.opts.MaxActiveRuns,
		})
	case protocol.OpSpawn:
		spec, ok := parse[model.SpawnSpec](ss, id, frame)
		if !ok {
			return true
		}
		res, err := sup.Spawn(spec)
		if err != nil {
			ss.fail(id, err)
			return true
		}
		ss.ok(id, protocol.SpawnResult{Run: res.Summary.Run, State: res.Summary.State, Position: res.Summary.QueuePosition, Existing: res.Existing})
	case protocol.OpWrite:
		p, ok := parse[protocol.WriteParams](ss, id, frame)
		if !ok {
			return true
		}
		seq, err := sup.Write(p.Run, p.Line)
		if err != nil {
			ss.fail(id, err)
			return true
		}
		ss.ok(id, protocol.WriteResult{Seq: seq})
	case protocol.OpCloseStdin:
		p, ok := parse[protocol.RunParams](ss, id, frame)
		if !ok {
			return true
		}
		ss.reply(id, sup.CloseStdin(p.Run))
	case protocol.OpStop:
		p, ok := parse[protocol.RunParams](ss, id, frame)
		if !ok {
			return true
		}
		ss.reply(id, sup.Stop(p.Run, time.Duration(p.GraceMS)*time.Millisecond))
	case protocol.OpForget:
		p, ok := parse[protocol.RunParams](ss, id, frame)
		if !ok {
			return true
		}
		ss.reply(id, sup.Forget(p.Run))
	case protocol.OpGet:
		p, ok := parse[protocol.RunParams](ss, id, frame)
		if !ok {
			return true
		}
		sum, err := sup.Get(p.Run)
		if err != nil {
			ss.fail(id, err)
			return true
		}
		ss.ok(id, sum)
	case protocol.OpList:
		p, ok := parse[protocol.ListParams](ss, id, frame)
		if !ok {
			return true
		}
		ss.ok(id, protocol.ListResult{Runs: sup.List(supervisor.Filter{State: p.State, Lane: p.Lane, Labels: p.Labels})})
	case protocol.OpStderr:
		p, ok := parse[protocol.StderrParams](ss, id, frame)
		if !ok {
			return true
		}
		text, partial, err := sup.Stderr(p.Run, p.TailBytes)
		if err != nil {
			ss.fail(id, err)
			return true
		}
		ss.ok(id, protocol.StderrResult{Text: text, HeadDropped: partial})
	case protocol.OpSubscribe:
		p, ok := parse[protocol.SubscribeParams](ss, id, frame)
		if !ok {
			return true
		}
		ss.subscribe(id, p)
	case protocol.OpUnsubscribe:
		p, ok := parse[protocol.RunParams](ss, id, frame)
		if !ok {
			return true
		}
		ss.cancelSub(p.Run)
		ss.ok(id, nil)
	case protocol.OpWatch:
		ss.startWatch(id)
	case protocol.OpShutdown:
		p, ok := parse[protocol.ShutdownParams](ss, id, frame)
		if !ok {
			return true
		}
		if err := sup.Shutdown(p.Force); err != nil {
			ss.fail(id, err)
			return true
		}
		ss.ok(id, nil)
		ss.srv.requestShutdown()
	default:
		ss.fail(id, model.Errf(model.CodeUnknownOp, "unknown op %q", env.Op))
	}
	return true
}

func (ss *session) reply(id string, err error) {
	if err != nil {
		ss.fail(id, err)
		return
	}
	ss.ok(id, nil)
}

// ---------- subscriptions ----------

func (ss *session) cancelSub(run string) {
	ss.mu.Lock()
	st := ss.subs[run]
	delete(ss.subs, run)
	ss.mu.Unlock()
	if st != nil {
		st.cancel()
		<-st.done
	}
}

func (ss *session) subscribe(id string, p protocol.SubscribeParams) {
	ss.cancelSub(p.Run) // a new subscription replaces the old one
	sub, err := ss.srv.sup.Subscribe(p.Run, p.FromSeq)
	if err != nil {
		ss.fail(id, err)
		return
	}
	ctx, cancel := context.WithCancel(ss.ctx)
	st := &subState{cancel: cancel, done: make(chan struct{})}
	ss.mu.Lock()
	ss.subs[p.Run] = st
	ss.mu.Unlock()
	ss.ok(id, protocol.SubscribeResult{FirstSeq: 1, LastSeq: sub.LastSeq(), State: sub.State()})
	ss.wg.Add(1)
	go ss.pumpSub(ctx, sub, p.Run, st) // started after the reply, so the records always follow it
}

func (ss *session) pumpSub(ctx context.Context, sub *supervisor.Subscription, run string, st *subState) {
	defer ss.wg.Done()
	defer close(st.done)
	defer sub.Close()
	for {
		recs, err := sub.Next(ctx)
		for _, rec := range recs {
			ss.event(protocol.RecordEvent{Ev: protocol.EvRecord, Run: run, Record: rec})
		}
		switch {
		case err == nil:
		case errors.Is(err, io.EOF):
			ss.event(protocol.EndEvent{Ev: protocol.EvEnd, Run: run, LastSeq: sub.LastSeq()})
			ss.mu.Lock()
			if ss.subs[run] == st {
				delete(ss.subs, run)
			}
			ss.mu.Unlock()
			return
		case ctx.Err() != nil:
			return
		default:
			ss.srv.log.Error("reading the event log failed", "run", run, "err", err)
			ss.conn.Close()
			return
		}
	}
}

// ---------- watch ----------

func (ss *session) startWatch(id string) {
	ss.mu.Lock()
	old := ss.watch
	ss.watch = nil
	ss.mu.Unlock()
	if old != nil {
		old.Close()
	}
	snap, w := ss.srv.sup.Watch()
	ss.mu.Lock()
	ss.watch = w
	ss.mu.Unlock()
	ss.ok(id, protocol.WatchResult{Runs: snap})
	ss.wg.Add(1)
	go func() {
		defer ss.wg.Done()
		for sum := range w.C() {
			ss.event(protocol.StateEvent{Ev: protocol.EvState, Run: sum.Run, State: sum.State, Exit: sum.Exit, LastSeq: sum.LastSeq})
		}
		if w.Overflowed() {
			ss.event(protocol.BareEvent{Ev: protocol.EvWatchOverflow})
		}
	}()
}
