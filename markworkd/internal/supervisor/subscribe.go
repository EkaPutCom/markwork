package supervisor

import (
	"context"
	"io"
	"sort"
	"sync"
	"sync/atomic"

	"github.com/EkaPutCom/markwork/markworkd/internal/model"
	"github.com/EkaPutCom/markwork/markworkd/internal/store"
)

// Subscription reads a run's log from a position and then follows it. The log is the buffer, so a slow reader
// only lags; it never holds up the run or other readers.
type Subscription struct {
	s       *Supervisor
	r       *run
	log     *store.Log
	cur     store.Cursor
	sawExit bool
	once    sync.Once
}

// Subscribe starts a subscription at fromSeq (0 means the start; beyond the end means only new records).
func (s *Supervisor) Subscribe(id string, fromSeq uint64) (*Subscription, error) {
	s.mu.Lock()
	r, err := s.find(id)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	r.subs++
	s.mu.Unlock()

	sub := &Subscription{s: s, r: r}
	fail := func(err error) (*Subscription, error) {
		sub.Close()
		return nil, model.Errf(model.CodeInternal, "%v", err)
	}
	lg, err := s.logFor(r)
	if err != nil {
		return fail(err)
	}
	sub.log = lg
	if sub.cur, err = lg.Seek(fromSeq); err != nil {
		return fail(err)
	}
	return sub, nil
}

// LastSeq is the newest record at this moment.
func (sub *Subscription) LastSeq() uint64 { return sub.log.LastSeq() }

// State is the run's current state.
func (sub *Subscription) State() model.State {
	sub.s.mu.Lock()
	defer sub.s.mu.Unlock()
	return sub.r.meta.State
}

// Next returns the next records, waiting for some if there are none. After the exit record was delivered it
// returns io.EOF.
func (sub *Subscription) Next(ctx context.Context) ([]model.Record, error) {
	for {
		if sub.sawExit {
			return nil, io.EOF
		}
		wake := sub.log.Notify() // taken before reading, so an append in between is not missed
		recs, err := sub.log.Read(&sub.cur, 256)
		if err != nil {
			return nil, err
		}
		if len(recs) > 0 {
			for _, rec := range recs {
				if rec.Kind == model.KindExit {
					sub.sawExit = true
				}
			}
			return recs, nil
		}
		if sub.log.Finished() && sub.cur.Next > sub.log.LastSeq() {
			return nil, io.EOF
		}
		select {
		case <-wake:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// Close ends the subscription. It is safe to call more than once.
func (sub *Subscription) Close() {
	sub.once.Do(func() {
		s := sub.s
		s.mu.Lock()
		sub.r.subs--
		if sub.r.subs == 0 {
			sub.r.touch(s.opts.Now()) // the idle clock starts when the last reader leaves
		}
		s.mu.Unlock()
	})
}

// Watcher receives a summary whenever a run changes state.
type Watcher struct {
	s        *Supervisor
	ch       chan model.Summary
	overflow atomic.Bool
}

// C delivers the changes. It is closed when the watcher was closed or fell too far behind.
func (w *Watcher) C() <-chan model.Summary { return w.ch }

// Overflowed reports that the channel was closed because the reader fell behind; it must watch again.
func (w *Watcher) Overflowed() bool { return w.overflow.Load() }

// Close stops the watcher.
func (w *Watcher) Close() {
	w.s.mu.Lock()
	defer w.s.mu.Unlock()
	if _, ok := w.s.watchers[w]; ok {
		delete(w.s.watchers, w)
		close(w.ch)
	}
}

const watchBuffer = 1024

// Watch registers for state changes and returns a snapshot taken at the same instant, so no change is missed or
// seen twice.
func (s *Supervisor) Watch() ([]model.Summary, *Watcher) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := &Watcher{s: s, ch: make(chan model.Summary, watchBuffer)}
	s.watchers[w] = struct{}{}
	snap := s.listLocked(Filter{})
	sort.SliceStable(snap, func(i, j int) bool { return snap[i].CreatedAt < snap[j].CreatedAt })
	return snap, w
}

// emitLocked tells the watchers that r changed.
func (s *Supervisor) emitLocked(r *run) {
	if len(s.watchers) == 0 {
		return
	}
	sum := s.summaryLocked(r)
	for w := range s.watchers {
		select {
		case w.ch <- sum:
		default:
			w.overflow.Store(true)
			delete(s.watchers, w)
			close(w.ch)
		}
	}
}
