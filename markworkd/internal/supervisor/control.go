package supervisor

import (
	"errors"
	"sort"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/model"
	"github.com/EkaPutCom/markwork/markworkd/internal/runner"
	"github.com/EkaPutCom/markwork/markworkd/internal/store"
)

func (s *Supervisor) find(id string) (*run, error) {
	r := s.runs[id]
	if r == nil {
		return nil, model.Errf(model.CodeNotFound, "no run %q", id)
	}
	return r, nil
}

// Write sends one line to the run's stdin and returns the sequence number of its "in" record.
func (s *Supervisor) Write(id, line string) (uint64, error) {
	if badLine(line) {
		return 0, model.Errf(model.CodeInvalidLine, "a line must not contain CR or LF")
	}
	s.mu.Lock()
	r, err := s.find(id)
	if err != nil {
		s.mu.Unlock()
		return 0, err
	}
	state, proc := r.meta.State, r.proc
	s.mu.Unlock()
	switch {
	case state == model.StateQueued || proc == nil && state != model.StateExited:
		return 0, model.Errf(model.CodeNotStarted, "run %q has not started", id)
	case state == model.StateExited:
		return 0, model.Errf(model.CodeNotRunning, "run %q has ended", id)
	}
	return s.writeProc(r, proc, line)
}

func (s *Supervisor) writeProc(r *run, proc runner.Process, line string) (uint64, error) {
	if err := proc.Write(line, s.opts.WriteTimeout); err != nil {
		switch {
		case errors.Is(err, runner.ErrWriteTimeout):
			return 0, model.Errf(model.CodeWriteTimeout, "the agent did not read its stdin; stdin was closed")
		default:
			return 0, model.Errf(model.CodeStdinClosed, "stdin is closed")
		}
	}
	rec, err := s.appendRecord(r, model.KindIn, line, false)
	if err != nil {
		return 0, model.Errf(model.CodeInternal, "%v", err)
	}
	return rec.Seq, nil
}

// CloseStdin closes the agent's stdin. It is idempotent.
func (s *Supervisor) CloseStdin(id string) error {
	s.mu.Lock()
	r, err := s.find(id)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	state, proc := r.meta.State, r.proc
	s.mu.Unlock()
	switch {
	case state == model.StateExited:
		return nil
	case proc == nil:
		return model.Errf(model.CodeNotStarted, "run %q has not started", id)
	}
	_ = proc.CloseStdin()
	return nil
}

// Stop ends a run. grace 0 means the default.
func (s *Supervisor) Stop(id string, grace time.Duration) error {
	s.mu.Lock()
	r, err := s.find(id)
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return s.stopRun(r, model.ReasonStopped, "", grace)
}

// Get returns one run.
func (s *Supervisor) Get(id string) (model.Summary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.find(id)
	if err != nil {
		return model.Summary{}, err
	}
	return s.summaryLocked(r), nil
}

// Filter selects runs for List; zero fields match everything.
type Filter struct {
	State  model.State
	Lane   string
	Labels map[string]string
}

func (f Filter) match(sum model.Summary) bool {
	if f.State != "" && sum.State != f.State {
		return false
	}
	if f.Lane != "" && sum.Lane != f.Lane {
		return false
	}
	for k, v := range f.Labels {
		if got, ok := sum.Labels[k]; !ok || got != v {
			return false
		}
	}
	return true
}

// List returns the runs matching f, oldest first.
func (s *Supervisor) List(f Filter) []model.Summary {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.listLocked(f)
}

func (s *Supervisor) listLocked(f Filter) []model.Summary {
	out := make([]model.Summary, 0, len(s.runs))
	for _, r := range s.runs {
		if sum := s.summaryLocked(r); f.match(sum) {
			out = append(out, sum)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt < out[j].CreatedAt
		}
		return out[i].Run < out[j].Run
	})
	return out
}

// Counts returns the number of runs per state.
func (s *Supervisor) Counts() (queued, running, exited int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.runs {
		switch r.meta.State {
		case model.StateQueued:
			queued++
		case model.StateRunning:
			running++
		default:
			exited++
		}
	}
	return
}

// Forget deletes the directory of a finished run.
func (s *Supervisor) Forget(id string) error {
	s.mu.Lock()
	r, err := s.find(id)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	if r.meta.State != model.StateExited {
		s.mu.Unlock()
		return model.Errf(model.CodeNotFinished, "run %q is %s", id, r.meta.State)
	}
	delete(s.runs, id)
	s.mu.Unlock()
	if err := s.st.Remove(id); err != nil {
		return model.Errf(model.CodeInternal, "%v", err)
	}
	return nil
}

// Stderr returns the last tail bytes of the run's stderr and whether earlier output exists that is not included.
func (s *Supervisor) Stderr(id string, tail int) (string, bool, error) {
	if tail <= 0 {
		tail = 8192
	}
	if tail > s.cfg.MaxStderrBytes {
		tail = s.cfg.MaxStderrBytes
	}
	s.mu.Lock()
	r, err := s.find(id)
	if err != nil {
		s.mu.Unlock()
		return "", false, err
	}
	se, size := r.stderr, r.meta.StderrBytes
	s.mu.Unlock()
	var text string
	var partial bool
	if se != nil {
		text, partial, err = se.Tail(tail)
	} else {
		text, partial, err = store.ReadTail(s.st.StderrPath(id), tail, size >= int64(s.cfg.MaxStderrBytes))
	}
	if err != nil {
		return "", false, model.Errf(model.CodeInternal, "%v", err)
	}
	return text, partial, nil
}

// Shutdown prepares the daemon to stop. Without force it refuses while runs are queued or running.
func (s *Supervisor) Shutdown(force bool) error {
	q, r, _ := s.Counts()
	if q+r > 0 && !force {
		return model.Errf(model.CodeRunsActive, "%d runs are active (%d running, %d queued); use force to stop them", q+r, r, q)
	}
	s.StopAll(s.opts.StopGrace)
	return nil
}

// StopAll stops every running run in an orderly way and prevents queued runs from starting. Queued runs stay
// queued on disk and start again with the next daemon.
func (s *Supervisor) StopAll(grace time.Duration) {
	s.mu.Lock()
	s.stopping = true
	var live []*run
	for _, r := range s.runs {
		if r.meta.State == model.StateRunning {
			live = append(live, r)
		}
	}
	s.mu.Unlock()
	for _, r := range live {
		_ = s.stopRun(r, model.ReasonStopped, "daemon stopping", grace)
	}
	deadline := time.After(grace + 3*time.Second)
	for _, r := range live {
		select {
		case <-r.done:
		case <-deadline:
			return
		}
	}
}

// Stopping reports whether StopAll was called.
func (s *Supervisor) Stopping() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopping
}

// summaryLocked builds the public view of a run.
func (s *Supervisor) summaryLocked(r *run) model.Summary {
	m := &r.meta
	sum := model.Summary{
		Run: r.id, State: m.State, Program: m.Spec.Program, Args: m.Spec.Args, Cwd: m.Spec.Cwd, Lane: m.Spec.Lane,
		Labels: m.Spec.Labels, CreatedAt: m.CreatedAt, Exit: m.Exit,
		LastSeq: m.LastSeq, LogBytes: m.LogBytes, StderrBytes: m.StderrBytes,
	}
	if sum.Args == nil {
		sum.Args = []string{}
	}
	if m.StartedAt != 0 {
		v := m.StartedAt
		sum.StartedAt = &v
	}
	if m.EndedAt != 0 {
		v := m.EndedAt
		sum.EndedAt = &v
	}
	if m.State != model.StateExited {
		if m.State == model.StateRunning {
			sum.PID = m.PID
		}
		if r.log != nil {
			sum.LastSeq, sum.LogBytes = r.log.LastSeq(), r.log.Size()
		}
		if r.stderr != nil {
			sum.StderrBytes = r.stderr.Size()
		}
	}
	if m.State == model.StateQueued {
		if l := s.lanes[m.Spec.Lane]; l != nil {
			for i, id := range l.queue {
				if id == r.id {
					sum.QueuePosition = i + 1
				}
			}
		}
	}
	return sum
}
