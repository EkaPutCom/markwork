// Package supervisor is the core of markworkd: the registry of runs, their state machine, the lanes that serialize
// runs, the idle timeout and the recovery after a restart. It knows nothing about sockets.
package supervisor

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"slices"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/config"
	"github.com/EkaPutCom/markwork/markworkd/internal/model"
	"github.com/EkaPutCom/markwork/markworkd/internal/runner"
	"github.com/EkaPutCom/markwork/markworkd/internal/store"
)

// Options configure a Supervisor. Zero durations take their defaults.
type Options struct {
	Config       config.Config
	Store        *store.Store
	Launcher     runner.Launcher
	Logger       *slog.Logger
	IdleUnit     time.Duration // the unit of idle_ttl_sec (default 1s; tests shorten it)
	IdleGrace    time.Duration // after closing stdin of an idle run, how long before it is stopped (30s)
	StopGrace    time.Duration // SIGTERM to SIGKILL when stopping (5s)
	WriteTimeout time.Duration // a write to an agent's stdin (10s)
	Now          func() time.Time
}

type run struct {
	id   string
	meta store.Meta // guarded by Supervisor.mu

	lmu    sync.Mutex
	log    *store.Log
	stderr *store.Stderr // nil for a run loaded from disk that is already exited

	// guarded by Supervisor.mu
	proc       runner.Process
	starting   bool // a lane was granted and the process is being started
	stopReason model.Reason
	stopError  string
	subs       int
	idleTimer  *time.Timer
	killTimer  *time.Timer

	lastActive atomic.Int64 // unix nanoseconds of the last record or stderr activity
	logFull    atomic.Bool
	done       chan struct{} // closed when the run is finalized
}

type lane struct {
	running []string
	queue   []string
}

// slots is how many runs of its lane a run may run beside: each run says so itself, so a client that raises or
// lowers the limit affects the runs it spawns from then on.
func (r *run) slots() int {
	if n := r.meta.Spec.LaneSlots; n > 0 {
		return n
	}
	return 1
}

// Supervisor owns all runs of one daemon.
type Supervisor struct {
	opts Options
	cfg  config.Config
	st   *store.Store
	log  *slog.Logger

	mu       sync.Mutex
	runs     map[string]*run
	lanes    map[string]*lane
	watchers map[*Watcher]struct{}
	stopping bool
}

func New(opts Options) *Supervisor {
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if opts.IdleUnit <= 0 {
		opts.IdleUnit = time.Second
	}
	if opts.IdleGrace <= 0 {
		opts.IdleGrace = 30 * time.Second
	}
	if opts.StopGrace <= 0 {
		opts.StopGrace = 5 * time.Second
	}
	if opts.WriteTimeout <= 0 {
		opts.WriteTimeout = 10 * time.Second
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Supervisor{
		opts: opts, cfg: opts.Config, st: opts.Store, log: opts.Logger,
		runs: map[string]*run{}, lanes: map[string]*lane{}, watchers: map[*Watcher]struct{}{},
	}
}

func (s *Supervisor) nowMS() int64 { return s.opts.Now().UnixMilli() }

func (r *run) touch(now time.Time) { r.lastActive.Store(now.UnixNano()) }

// logFor returns the run's log, opening it read-only for a run that finished before this daemon started.
func (s *Supervisor) logFor(r *run) (*store.Log, error) {
	r.lmu.Lock()
	defer r.lmu.Unlock()
	if r.log == nil {
		l, err := store.OpenLog(s.st.LogPath(r.id), true)
		if err != nil {
			return nil, err
		}
		r.log = l
	}
	return r.log, nil
}

// ---------- spawn ----------

const (
	maxLabelBytes   = 8 << 10
	maxInitialLines = 64
	maxArgs         = 256
	maxLaneName     = 128
	maxLaneSlots    = 64
)

func (s *Supervisor) validate(spec *model.SpawnSpec) error {
	spec.Normalize()
	if !model.ValidRunID(spec.Run) {
		return model.Errf(model.CodeBadRequest, "invalid run id %q", spec.Run)
	}
	if spec.Program == "" {
		return model.Errf(model.CodeBadRequest, "program is required")
	}
	if len(spec.Args) > maxArgs {
		return model.Errf(model.CodeLimitExceeded, "at most %d args", maxArgs)
	}
	for _, a := range spec.Args {
		if containsNUL(a) {
			return model.Errf(model.CodeBadRequest, "args must not contain NUL")
		}
	}
	if len(spec.Lane) > maxLaneName {
		return model.Errf(model.CodeLimitExceeded, "lane name is longer than %d bytes", maxLaneName)
	}
	if spec.LaneSlots < 0 || spec.LaneSlots > maxLaneSlots {
		return model.Errf(model.CodeBadRequest, "lane_slots must be between 0 and %d", maxLaneSlots)
	}
	if spec.IdleTTLSec != nil && *spec.IdleTTLSec < 0 {
		return model.Errf(model.CodeBadRequest, "idle_ttl_sec must not be negative")
	}
	if _, err := s.cfg.ResolveProgram(spec.Program); err != nil {
		return model.Errf(model.CodeProgramNotAllowed, "%v", err)
	}
	if _, err := s.cfg.ResolveCwd(spec.Cwd); err != nil {
		return model.Errf(model.CodeCwdNotAllowed, "%v", err)
	}
	for k, v := range spec.Env {
		if !s.cfg.EnvAllowed(k) {
			return model.Errf(model.CodeEnvNotAllowed, "environment variable %q is not allowed", k)
		}
		if containsNUL(v) {
			return model.Errf(model.CodeBadRequest, "environment values must not contain NUL")
		}
	}
	total := 0
	for k, v := range spec.Labels {
		total += len(k) + len(v)
	}
	if total > maxLabelBytes {
		return model.Errf(model.CodeLimitExceeded, "labels are larger than %d bytes", maxLabelBytes)
	}
	if len(spec.InitialInput) > maxInitialLines {
		return model.Errf(model.CodeLimitExceeded, "at most %d initial input lines", maxInitialLines)
	}
	for _, l := range spec.InitialInput {
		if badLine(l) {
			return model.Errf(model.CodeInvalidLine, "initial input lines must not contain CR or LF")
		}
	}
	return nil
}

func containsNUL(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == 0 {
			return true
		}
	}
	return false
}

func badLine(l string) bool {
	for i := 0; i < len(l); i++ {
		if l[i] == '\n' || l[i] == '\r' {
			return true
		}
	}
	return false
}

// SpawnResult is the outcome of Spawn.
type SpawnResult struct {
	Summary  model.Summary
	Existing bool
}

// Spawn registers a run and starts it, or queues it when its lane is busy. Repeating a spawn with the same id and
// the same parameters returns the existing run.
func (s *Supervisor) Spawn(spec model.SpawnSpec) (SpawnResult, error) {
	if err := s.validate(&spec); err != nil {
		return SpawnResult{}, err
	}
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return SpawnResult{}, model.Errf(model.CodeShuttingDown, "the daemon is shutting down")
	}
	if r, ok := s.runs[spec.Run]; ok {
		if r.meta.Spec.Equal(spec) {
			sum := s.summaryLocked(r)
			s.mu.Unlock()
			return SpawnResult{Summary: sum, Existing: true}, nil
		}
		s.mu.Unlock()
		return SpawnResult{}, model.Errf(model.CodeConflict, "run %q exists with different parameters", spec.Run)
	}
	if s.activeLocked() >= s.cfg.MaxActiveRuns {
		s.mu.Unlock()
		return SpawnResult{}, model.Errf(model.CodeLimitExceeded, "too many active runs (limit %d)", s.cfg.MaxActiveRuns)
	}
	r, err := s.createLocked(spec)
	if err != nil {
		s.mu.Unlock()
		return SpawnResult{}, model.Errf(model.CodeInternal, "%v", err)
	}
	startNow := s.admitLocked(r)
	s.emitLocked(r)
	s.mu.Unlock()
	if startNow {
		s.startRun(r) // returns once the process runs (or failed), so the answer says "running"
	}
	s.mu.Lock()
	sum := s.summaryLocked(r)
	s.mu.Unlock()
	return SpawnResult{Summary: sum}, nil
}

// createLocked makes the on-disk state of a new run and registers it.
func (s *Supervisor) createLocked(spec model.SpawnSpec) (*run, error) {
	if err := s.st.Create(spec.Run); err != nil {
		return nil, err
	}
	cleanup := func(err error) (*run, error) { _ = s.st.Remove(spec.Run); return nil, err }
	lg, err := store.OpenLog(s.st.LogPath(spec.Run), false)
	if err != nil {
		return cleanup(err)
	}
	se, err := store.OpenStderr(s.st.StderrPath(spec.Run), int64(s.cfg.MaxStderrBytes))
	if err != nil {
		return cleanup(err)
	}
	r := &run{id: spec.Run, log: lg, stderr: se, done: make(chan struct{})}
	r.meta = store.Meta{Spec: spec, State: model.StateQueued, CreatedAt: s.nowMS()}
	if err := s.st.SaveMeta(r.id, &r.meta); err != nil {
		return cleanup(err)
	}
	r.touch(s.opts.Now())
	s.runs[r.id] = r
	return r, nil
}

// admitLocked grants the run a slot of its lane or queues it. It reports whether the run may start now. A run that
// comes after others in the queue waits behind them even if a slot is free for it, so the order stays FIFO.
func (s *Supervisor) admitLocked(r *run) bool {
	name := r.meta.Spec.Lane
	if name == "" {
		r.starting = true
		return true
	}
	l := s.lanes[name]
	if l == nil {
		l = &lane{}
		s.lanes[name] = l
	}
	if len(l.queue) == 0 && len(l.running) < r.slots() {
		l.running = append(l.running, r.id)
		r.starting = true
		return true
	}
	l.queue = append(l.queue, r.id)
	return false
}

func (s *Supervisor) activeLocked() int {
	n := 0
	for _, r := range s.runs {
		if r.meta.State != model.StateExited {
			n++
		}
	}
	return n
}

// startRun launches the process of a run that holds its lane.
func (s *Supervisor) startRun(r *run) {
	s.mu.Lock()
	spec := r.meta.Spec
	canceled := r.stopReason != ""
	stopping := s.stopping
	s.mu.Unlock()
	if stopping { // the daemon is going down; the run stays queued for the next one
		return
	}
	if canceled {
		s.finish(r, model.Exit{Reason: model.ReasonCanceled})
		return
	}
	fail := func(err error) {
		s.finish(r, model.Exit{Reason: model.ReasonStartFailed, Error: err.Error()})
	}
	path, err := s.cfg.ResolveProgram(spec.Program)
	if err != nil {
		fail(err)
		return
	}
	cwd, err := s.cfg.ResolveCwd(spec.Cwd)
	if err != nil {
		fail(err)
		return
	}
	env := os.Environ()
	for k, v := range s.cfg.AgentEnv { // fixed for every agent, e.g. a PATH the service manager does not have
		env = append(env, k+"="+v)
	}
	for k, v := range spec.Env {
		env = append(env, k+"="+v)
	}
	proc, err := s.opts.Launcher.Start(runner.Params{Program: path, Args: spec.Args, Dir: cwd, Env: env, Stderr: &activityWriter{r: r, s: s}})
	if err != nil {
		fail(err)
		return
	}
	ticks, _ := procStartTicks(proc.PID())

	s.mu.Lock()
	r.proc = proc
	r.starting = false
	r.meta.State = model.StateRunning
	r.meta.PID, r.meta.PGID, r.meta.StartTicks = proc.PID(), proc.PID(), ticks
	r.meta.StartedAt = s.nowMS()
	s.saveLocked(r)
	s.emitLocked(r)
	pending := r.stopReason
	s.mu.Unlock()

	s.appendRecord(r, model.KindStart, fmt.Sprintf("pid %d", proc.PID()), false)
	s.armIdle(r)
	go s.pump(r, proc)
	if pending != "" { // a stop arrived while the process was starting
		_ = s.stopRun(r, pending, "", 0)
	}
	if len(spec.InitialInput) > 0 { // in the background: the agent may print a lot before it reads its stdin
		go func() {
			for _, line := range spec.InitialInput {
				if _, err := s.writeProc(r, proc, line); err != nil {
					_ = s.stopRun(r, model.ReasonStartFailed, "initial input: "+err.Error(), 0)
					return
				}
			}
		}()
	}
}

// activityWriter forwards the agent's stderr to its file and counts it as activity for the idle timeout.
type activityWriter struct {
	r *run
	s *Supervisor
}

func (w *activityWriter) Write(p []byte) (int, error) {
	w.r.touch(w.s.opts.Now())
	return w.r.stderr.Write(p)
}

// pump copies stdout into the log until the process is gone, then finalizes the run.
func (s *Supervisor) pump(r *run, proc runner.Process) {
	for ln := range proc.Stdout() {
		s.record(r, model.KindOut, ln.Text, ln.Truncated)
	}
	ex := proc.Wait()
	s.mu.Lock()
	reason, errText := r.stopReason, r.stopError
	s.mu.Unlock()
	out := model.Exit{Reason: reason, Error: errText}
	if ex.Signaled {
		sig := ex.Signal
		out.Signal = &sig
		if reason == "" {
			out.Reason = model.ReasonSignaled
		}
	} else {
		code := ex.Code
		out.Code = &code
		if reason == "" {
			out.Reason = model.ReasonExited
		}
	}
	s.finish(r, out)
}

// record appends an agent record unless the log reached its size cap, in which case the run is stopped.
func (s *Supervisor) record(r *run, kind model.Kind, line string, truncated bool) {
	if r.logFull.Load() {
		return
	}
	if r.log.Size()+int64(len(line))+128 > s.cfg.MaxLogBytes {
		if r.logFull.CompareAndSwap(false, true) {
			go func() { _ = s.stopRun(r, model.ReasonLogLimit, "event log reached max_log_bytes", 0) }()
		}
		return
	}
	s.appendRecord(r, kind, line, truncated)
}

func (s *Supervisor) appendRecord(r *run, kind model.Kind, line string, truncated bool) (model.Record, error) {
	rec, err := r.log.Append(kind, line, truncated, s.nowMS())
	if err != nil {
		s.log.Error("append to event log failed", "run", r.id, "err", err)
		if r.logFull.CompareAndSwap(false, true) {
			go func() { _ = s.stopRun(r, model.ReasonLogLimit, "event log write failed: "+err.Error(), 0) }()
		}
		return rec, err
	}
	r.touch(s.opts.Now())
	return rec, nil
}

// finish writes the exit record, marks the run exited, frees its lane and starts the next queued run.
//
// The record and the state change happen under one lock: a client that reads the exit record (and the "end" event
// that follows it) and then asks for the run's state, or asks to shut the daemon down, must already see "exited".
func (s *Supervisor) finish(r *run, exit model.Exit) {
	data, _ := json.Marshal(exit)
	s.mu.Lock()
	if r.meta.State == model.StateExited {
		s.mu.Unlock()
		return
	}
	if _, err := r.log.Append(model.KindExit, string(data), false, s.nowMS()); err != nil {
		s.log.Error("writing the exit record failed", "run", r.id, "err", err)
	}
	r.meta.State = model.StateExited
	r.meta.Exit = &exit
	r.meta.EndedAt = s.nowMS()
	r.meta.LastSeq, r.meta.LogBytes = r.log.LastSeq(), r.log.Size()
	if r.stderr != nil {
		r.meta.StderrBytes = r.stderr.Size()
	}
	r.proc, r.starting = nil, false
	if r.idleTimer != nil {
		r.idleTimer.Stop()
	}
	if r.killTimer != nil {
		r.killTimer.Stop()
	}
	s.saveLocked(r)
	next := s.releaseLaneLocked(r)
	s.emitLocked(r)
	s.mu.Unlock()

	_ = r.log.Sync()
	_ = r.log.CloseWriter()
	if r.stderr != nil {
		_ = r.stderr.Close()
	}
	close(r.done)
	for _, nr := range next {
		go s.startRun(nr)
	}
}

// releaseLaneLocked frees the run's slot of its lane (or removes it from the queue) and returns the runs to start.
func (s *Supervisor) releaseLaneLocked(r *run) []*run {
	name := r.meta.Spec.Lane
	l := s.lanes[name]
	if name == "" || l == nil {
		return nil
	}
	var next []*run
	if i := slices.Index(l.running, r.id); i >= 0 {
		l.running = slices.Delete(l.running, i, i+1)
		for !s.stopping && len(l.queue) > 0 {
			nr := s.runs[l.queue[0]]
			if nr == nil || nr.meta.State != model.StateQueued {
				l.queue = l.queue[1:]
				continue
			}
			if len(l.running) >= nr.slots() {
				break
			}
			l.queue = l.queue[1:]
			l.running = append(l.running, nr.id)
			nr.starting = true
			next = append(next, nr)
		}
	} else if i := slices.Index(l.queue, r.id); i >= 0 {
		l.queue = slices.Delete(l.queue, i, i+1)
	}
	if len(l.running) == 0 && len(l.queue) == 0 {
		delete(s.lanes, name)
	}
	return next
}

func (s *Supervisor) saveLocked(r *run) {
	if err := s.st.SaveMeta(r.id, &r.meta); err != nil {
		s.log.Error("saving meta.json failed", "run", r.id, "err", err)
	}
}

// ---------- idle timeout ----------

func (s *Supervisor) idleTTL(r *run) time.Duration {
	sec := s.cfg.DefaultIdleTTLSec
	if r.meta.Spec.IdleTTLSec != nil {
		sec = *r.meta.Spec.IdleTTLSec
	}
	return time.Duration(sec) * s.opts.IdleUnit
}

func (s *Supervisor) armIdle(r *run) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ttl := s.idleTTL(r)
	if ttl <= 0 || r.meta.State != model.StateRunning {
		return
	}
	r.idleTimer = time.AfterFunc(ttl, func() { s.idleCheck(r) })
}

func (s *Supervisor) idleCheck(r *run) {
	s.mu.Lock()
	if r.meta.State != model.StateRunning || r.proc == nil {
		s.mu.Unlock()
		return
	}
	ttl := s.idleTTL(r)
	wait := ttl
	if r.subs == 0 {
		idle := s.opts.Now().Sub(time.Unix(0, r.lastActive.Load()))
		if idle >= ttl {
			if r.stopReason == "" {
				r.stopReason = model.ReasonIdleTimeout
			}
			proc := r.proc
			s.mu.Unlock()
			_ = proc.CloseStdin()
			time.AfterFunc(s.opts.IdleGrace, func() {
				select {
				case <-r.done:
				default:
					_ = s.stopRun(r, model.ReasonIdleTimeout, "", 0)
				}
			})
			return
		}
		wait = ttl - idle
	}
	r.idleTimer = time.AfterFunc(wait, func() { s.idleCheck(r) })
	s.mu.Unlock()
}

// ---------- stop ----------

// stopRun ends a run: a queued one is canceled, a running one gets SIGTERM and, after the grace, SIGKILL.
// The first reason given is the one recorded. grace 0 means the default.
func (s *Supervisor) stopRun(r *run, reason model.Reason, errText string, grace time.Duration) error {
	if grace <= 0 {
		grace = s.opts.StopGrace
	}
	s.mu.Lock()
	switch r.meta.State {
	case model.StateExited:
		s.mu.Unlock()
		return nil
	case model.StateQueued:
		if r.stopReason == "" {
			r.stopReason = model.ReasonCanceled
		}
		if r.starting { // startRun will notice
			s.mu.Unlock()
			return nil
		}
		next := s.releaseLaneLocked(r)
		s.mu.Unlock()
		s.finish(r, model.Exit{Reason: model.ReasonCanceled})
		_ = next // a queued run holds no slot, so there is nothing to promote
		return nil
	}
	if r.stopReason == "" {
		r.stopReason, r.stopError = reason, errText
	}
	proc := r.proc
	if proc != nil && r.killTimer == nil {
		r.killTimer = time.AfterFunc(grace, func() { _ = proc.Signal(syscall.SIGKILL) })
	}
	s.mu.Unlock()
	if proc != nil {
		return proc.Signal(syscall.SIGTERM)
	}
	return nil
}
