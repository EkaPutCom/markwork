// Package client is a Go client of the markworkd protocol. The command line tools, the SSH bridge tests and the
// integration tests use it.
package client

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/model"
	"github.com/EkaPutCom/markwork/markworkd/internal/protocol"
)

// ErrClosed is returned by calls on a connection that has ended.
var ErrClosed = errors.New("client: connection closed")

// Options configure a Client.
type Options struct {
	// ExpectBridge makes the client ignore everything before the bridge's sentinel line, so text printed by a
	// login shell on the remote machine does not matter.
	ExpectBridge bool
	// Timeout for one request (default 60s).
	Timeout time.Duration
}

type reply struct {
	frame []byte
	ok    bool
	err   *model.Error
}

// Client is one connection. It is safe for concurrent use.
type Client struct {
	rwc     io.ReadWriteCloser
	enc     *protocol.Encoder
	timeout time.Duration

	mu      sync.Mutex
	nextID  int
	pending map[string]chan reply
	subs    map[string]*Subscription
	watch   *WatchStream
	banner  bool // still waiting for the bridge sentinel
	err     error
	closed  chan struct{}
}

// New starts reading from rwc. Call Hello before anything else.
func New(rwc io.ReadWriteCloser, opts Options) *Client {
	if opts.Timeout <= 0 {
		opts.Timeout = 60 * time.Second
	}
	c := &Client{
		rwc: rwc, enc: protocol.NewEncoder(rwc), timeout: opts.Timeout,
		pending: map[string]chan reply{}, subs: map[string]*Subscription{}, banner: opts.ExpectBridge, closed: make(chan struct{}),
	}
	go c.readLoop()
	return c
}

// Dial connects to a Unix socket and says hello.
func Dial(path, clientName string) (*Client, error) {
	conn, err := net.DialTimeout("unix", path, 5*time.Second)
	if err != nil {
		return nil, err
	}
	c := New(conn, Options{})
	if _, err := c.Hello(clientName); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

// Close ends the connection. Runs are not affected.
func (c *Client) Close() error {
	err := c.rwc.Close()
	<-c.closed
	return err
}

// Done is closed when the connection ended.
func (c *Client) Done() <-chan struct{} { return c.closed }

// Err is why the connection ended, or nil while it is open.
func (c *Client) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *Client) readLoop() {
	dec := protocol.NewDecoder(c.rwc, protocol.MaxFrame)
	var final error
	for {
		frame, err := dec.Next()
		if err != nil {
			final = err
			break
		}
		var head struct {
			Re    string       `json:"re"`
			Ev    string       `json:"ev"`
			OK    bool         `json:"ok"`
			Error *model.Error `json:"error"`
			Run   string       `json:"run"`
		}
		if json.Unmarshal(frame, &head) != nil {
			continue // not ours: noise before the bridge sentinel, or garbage
		}
		c.mu.Lock()
		if c.banner {
			if head.Ev == protocol.EvBridge {
				c.banner = false
			}
			c.mu.Unlock()
			continue
		}
		c.mu.Unlock()
		switch {
		case head.Re != "":
			c.mu.Lock()
			ch := c.pending[head.Re]
			delete(c.pending, head.Re)
			c.mu.Unlock()
			if ch != nil {
				ch <- reply{frame: append([]byte(nil), frame...), ok: head.OK, err: head.Error}
			}
		case head.Ev == protocol.EvRecord:
			var ev protocol.RecordEvent
			if json.Unmarshal(frame, &ev) == nil {
				c.mu.Lock()
				sub := c.subs[ev.Run]
				c.mu.Unlock()
				if sub != nil {
					sub.push(ev.Record)
				}
			}
		case head.Ev == protocol.EvEnd:
			c.mu.Lock()
			sub := c.subs[head.Run]
			delete(c.subs, head.Run)
			c.mu.Unlock()
			if sub != nil {
				sub.finish(nil)
			}
		case head.Ev == protocol.EvState:
			var ev protocol.StateEvent
			if json.Unmarshal(frame, &ev) == nil {
				c.mu.Lock()
				w := c.watch
				c.mu.Unlock()
				if w != nil {
					w.push(ev)
				}
			}
		case head.Ev == protocol.EvWatchOverflow:
			c.mu.Lock()
			w := c.watch
			c.watch = nil
			c.mu.Unlock()
			if w != nil {
				w.overflowed = true
				w.finish()
			}
		}
	}
	if final == nil || errors.Is(final, io.EOF) {
		final = ErrClosed
	}
	c.mu.Lock()
	c.err = final
	pending, subs, w := c.pending, c.subs, c.watch
	c.pending, c.subs, c.watch = map[string]chan reply{}, map[string]*Subscription{}, nil
	c.mu.Unlock()
	for _, ch := range pending {
		close(ch)
	}
	for _, s := range subs {
		s.finish(final)
	}
	if w != nil {
		w.finish()
	}
	close(c.closed)
}

// call sends a request and decodes the successful response's fields into result (if not nil).
func (c *Client) call(op string, params any, result any) error {
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return err
	}
	c.nextID++
	id := strconv.Itoa(c.nextID)
	ch := make(chan reply, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	body := map[string]json.RawMessage{}
	if params != nil {
		raw, err := json.Marshal(params)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			return err
		}
	}
	body["id"], _ = json.Marshal(id)
	body["op"], _ = json.Marshal(op)
	if err := c.enc.SendValue(body); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return err
	}
	timer := time.NewTimer(c.timeout)
	defer timer.Stop()
	select {
	case r, ok := <-ch:
		if !ok {
			return c.Err()
		}
		if !r.ok {
			if r.err == nil {
				return fmt.Errorf("%s failed", op)
			}
			return r.err
		}
		if result != nil {
			return json.Unmarshal(r.frame, result)
		}
		return nil
	case <-timer.C:
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return fmt.Errorf("client: %s timed out", op)
	}
}

// ---------- operations ----------

func (c *Client) Hello(name string) (protocol.HelloResult, error) {
	var r protocol.HelloResult
	err := c.call(protocol.OpHello, protocol.HelloParams{Proto: protocol.Version, Client: name}, &r)
	return r, err
}

func (c *Client) Ping() error { return c.call(protocol.OpPing, nil, nil) }

func (c *Client) Info() (protocol.InfoResult, error) {
	var r protocol.InfoResult
	err := c.call(protocol.OpInfo, nil, &r)
	return r, err
}

func (c *Client) Spawn(spec model.SpawnSpec) (protocol.SpawnResult, error) {
	var r protocol.SpawnResult
	err := c.call(protocol.OpSpawn, spec, &r)
	return r, err
}

func (c *Client) Write(run, line string) (uint64, error) {
	var r protocol.WriteResult
	err := c.call(protocol.OpWrite, protocol.WriteParams{Run: run, Line: line}, &r)
	return r.Seq, err
}

func (c *Client) CloseStdin(run string) error {
	return c.call(protocol.OpCloseStdin, protocol.RunParams{Run: run}, nil)
}

func (c *Client) Stop(run string, grace time.Duration) error {
	return c.call(protocol.OpStop, protocol.RunParams{Run: run, GraceMS: int(grace / time.Millisecond)}, nil)
}

func (c *Client) Forget(run string) error {
	return c.call(protocol.OpForget, protocol.RunParams{Run: run}, nil)
}

func (c *Client) Get(run string) (model.Summary, error) {
	var r model.Summary
	err := c.call(protocol.OpGet, protocol.RunParams{Run: run}, &r)
	return r, err
}

func (c *Client) List(p protocol.ListParams) ([]model.Summary, error) {
	var r protocol.ListResult
	err := c.call(protocol.OpList, p, &r)
	return r.Runs, err
}

func (c *Client) Stderr(run string, tail int) (protocol.StderrResult, error) {
	var r protocol.StderrResult
	err := c.call(protocol.OpStderr, protocol.StderrParams{Run: run, TailBytes: tail}, &r)
	return r, err
}

func (c *Client) Shutdown(force bool) error {
	return c.call(protocol.OpShutdown, protocol.ShutdownParams{Force: force}, nil)
}

// ---------- subscriptions ----------

// Subscription delivers a run's records. The consumer must keep reading Records: delivery blocks the connection's
// reader when the buffer is full.
type Subscription struct {
	Result  protocol.SubscribeResult
	Records <-chan model.Record

	c    *Client
	run  string
	ch   chan model.Record
	stop chan struct{} // closed first by finish, so a push blocked on a full buffer lets go
	once sync.Once
	pmu  sync.Mutex // held by push while it sends; finish takes it before closing ch
	done bool
	mu   sync.Mutex
	err  error
}

func (s *Subscription) push(r model.Record) {
	s.pmu.Lock()
	defer s.pmu.Unlock()
	if s.done {
		return
	}
	select {
	case s.ch <- r:
	case <-s.stop:
	}
}

func (s *Subscription) finish(err error) {
	s.once.Do(func() {
		close(s.stop)
		s.pmu.Lock()
		s.done = true
		s.mu.Lock()
		s.err = err
		s.mu.Unlock()
		close(s.ch)
		s.pmu.Unlock()
	})
}

// Err is nil when the stream ended normally (after the exit record) and otherwise why it ended.
func (s *Subscription) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

// Close stops the subscription on the daemon.
func (s *Subscription) Close() error {
	s.c.mu.Lock()
	if s.c.subs[s.run] == s {
		delete(s.c.subs, s.run)
	}
	s.c.mu.Unlock()
	s.finish(nil)
	return s.c.call(protocol.OpUnsubscribe, protocol.RunParams{Run: s.run}, nil)
}

// Subscribe replays the run's log from fromSeq (0 = the start) and follows it.
func (c *Client) Subscribe(run string, fromSeq uint64) (*Subscription, error) {
	ch := make(chan model.Record, 1024)
	sub := &Subscription{c: c, run: run, ch: ch, Records: ch, stop: make(chan struct{})}
	c.mu.Lock()
	if old := c.subs[run]; old != nil { // a new subscription replaces the old one, also on the daemon
		old.finish(nil)
	}
	c.subs[run] = sub
	c.mu.Unlock()
	if err := c.call(protocol.OpSubscribe, protocol.SubscribeParams{Run: run, FromSeq: fromSeq}, &sub.Result); err != nil {
		c.mu.Lock()
		if c.subs[run] == sub {
			delete(c.subs, run)
		}
		c.mu.Unlock()
		sub.finish(err)
		return nil, err
	}
	return sub, nil
}

// ---------- watch ----------

// WatchStream delivers state changes of all runs.
type WatchStream struct {
	Events <-chan protocol.StateEvent

	ch         chan protocol.StateEvent
	stop       chan struct{}
	once       sync.Once
	pmu        sync.Mutex
	done       bool
	overflowed bool
}

func (w *WatchStream) push(e protocol.StateEvent) {
	w.pmu.Lock()
	defer w.pmu.Unlock()
	if w.done {
		return
	}
	select {
	case w.ch <- e:
	case <-w.stop:
	}
}

func (w *WatchStream) finish() {
	w.once.Do(func() {
		close(w.stop)
		w.pmu.Lock()
		w.done = true
		close(w.ch)
		w.pmu.Unlock()
	})
}

// Overflowed reports that the daemon ended the stream because the client fell behind; watch again.
func (w *WatchStream) Overflowed() bool { return w.overflowed }

// Watch returns every run now and then the changes after that moment.
func (c *Client) Watch() ([]model.Summary, *WatchStream, error) {
	ch := make(chan protocol.StateEvent, 1024)
	w := &WatchStream{ch: ch, Events: ch, stop: make(chan struct{})}
	c.mu.Lock()
	if c.watch != nil {
		c.watch.finish()
	}
	c.watch = w
	c.mu.Unlock()
	var r protocol.WatchResult
	if err := c.call(protocol.OpWatch, nil, &r); err != nil {
		c.mu.Lock()
		if c.watch == w {
			c.watch = nil
		}
		c.mu.Unlock()
		w.finish()
		return nil, nil, err
	}
	return r.Runs, w, nil
}
