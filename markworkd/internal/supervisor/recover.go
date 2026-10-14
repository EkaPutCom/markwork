package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/model"
	"github.com/EkaPutCom/markwork/markworkd/internal/store"
)

// procStartTicks returns the start time of a process in clock ticks since boot (field 22 of /proc/<pid>/stat).
// Together with the pid it identifies a process, so a recycled pid is not mistaken for an old agent.
func procStartTicks(pid int) (uint64, error) {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, err
	}
	s := string(data)
	i := strings.LastIndexByte(s, ')') // the command name may contain spaces and parentheses
	if i < 0 {
		return 0, errors.New("unexpected /proc stat format")
	}
	fields := strings.Fields(s[i+1:]) // fields[0] is field 3 (state)
	if len(fields) < 20 {
		return 0, errors.New("unexpected /proc stat format")
	}
	return strconv.ParseUint(fields[19], 10, 64)
}

// Recover loads the runs from disk after a restart. Runs that were running are ended as "lost" (their pipes ended
// with the previous daemon, so any surviving process is an unmonitored orphan and is stopped); queued runs
// are queued again in their original order.
func (s *Supervisor) Recover() error {
	ids, err := s.st.RunIDs()
	if err != nil {
		return err
	}
	var running, queued []*run
	for _, id := range ids {
		meta, err := s.st.LoadMeta(id)
		if errors.Is(err, fs.ErrNotExist) { // the daemon died while creating the run
			_ = s.st.Remove(id)
			continue
		}
		if err != nil {
			s.log.Error("skipping a run whose meta.json cannot be read", "run", id, "err", err)
			continue
		}
		r := &run{id: id, meta: *meta, done: make(chan struct{})}
		if meta.State == model.StateExited {
			close(r.done)
			s.runs[id] = r
			continue
		}
		lg, err := store.OpenLog(s.st.LogPath(id), false)
		if err != nil {
			s.log.Error("the event log of an unfinished run is unreadable; ending it as lost", "run", id, "err", err)
			r.done = make(chan struct{})
			close(r.done)
			r.meta.State = model.StateExited
			r.meta.Exit = &model.Exit{Reason: model.ReasonLost, Error: "event log unreadable: " + err.Error()}
			r.meta.EndedAt = s.nowMS()
			s.saveLocked(r)
			s.runs[id] = r
			if meta.State == model.StateRunning {
				killOrphan(meta)
			}
			continue
		}
		if meta.State == model.StateRunning && lg.Finished() {
			// The daemon died after writing the exit record but before saving meta.json: the log knows the truth.
			if exit, at, ok := lastExit(lg); ok {
				_ = lg.CloseWriter()
				r.meta.State, r.meta.Exit, r.meta.EndedAt = model.StateExited, &exit, at
				r.meta.LastSeq, r.meta.LogBytes = lg.LastSeq(), lg.Size()
				s.saveLocked(r)
				close(r.done)
				s.runs[id] = r
				killOrphan(meta)
				continue
			}
		}
		r.log = lg
		if r.stderr, err = store.OpenStderr(s.st.StderrPath(id), int64(s.cfg.MaxStderrBytes)); err != nil {
			s.log.Error("cannot open stderr.log", "run", id, "err", err)
		}
		r.touch(s.opts.Now())
		s.runs[id] = r
		if meta.State == model.StateRunning {
			running = append(running, r)
		} else {
			queued = append(queued, r)
		}
	}

	s.stopOrphans(running)
	for _, r := range running {
		s.finish(r, model.Exit{Reason: model.ReasonLost, Error: "the daemon restarted while the run was active"})
	}

	sort.Slice(queued, func(i, j int) bool { return queued[i].meta.CreatedAt < queued[j].meta.CreatedAt })
	for _, r := range queued {
		s.mu.Lock()
		start := s.admitLocked(r)
		s.mu.Unlock()
		if start {
			go s.startRun(r)
		}
	}
	return nil
}

// orphanTarget returns the process group of an agent from a previous daemon, or 0 if it is gone or not ours.
func orphanTarget(m *store.Meta) int {
	if m.PGID <= 0 || m.PID <= 0 || m.StartTicks == 0 {
		return 0
	}
	if ticks, err := procStartTicks(m.PID); err != nil || ticks != m.StartTicks {
		return 0
	}
	return m.PGID
}

func killOrphan(m *store.Meta) {
	if g := orphanTarget(m); g != 0 {
		_ = syscall.Kill(-g, syscall.SIGKILL)
	}
}

// stopOrphans sends SIGTERM to the process groups of runs from a previous daemon and SIGKILL after two seconds.
func (s *Supervisor) stopOrphans(runs []*run) {
	var groups []int
	for _, r := range runs {
		if g := orphanTarget(&r.meta); g != 0 {
			groups = append(groups, g)
			s.log.Warn("stopping an agent left over from a previous daemon", "run", r.id, "pgid", g)
			_ = syscall.Kill(-g, syscall.SIGTERM)
		}
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(groups) > 0 && time.Now().Before(deadline) {
		alive := groups[:0]
		for _, g := range groups {
			if syscall.Kill(-g, 0) == nil {
				alive = append(alive, g)
			}
		}
		groups = alive
		time.Sleep(50 * time.Millisecond)
	}
	for _, g := range groups {
		_ = syscall.Kill(-g, syscall.SIGKILL)
	}
}

// Sweep removes finished runs older than the retention period and returns how many were removed.
func (s *Supervisor) Sweep() int {
	days := s.cfg.RetentionDays
	if days <= 0 {
		return 0
	}
	cutoff := s.opts.Now().Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
	s.mu.Lock()
	var old []string
	for id, r := range s.runs {
		if r.meta.State == model.StateExited && r.subs == 0 && r.meta.EndedAt != 0 && r.meta.EndedAt < cutoff {
			old = append(old, id)
			delete(s.runs, id)
		}
	}
	s.mu.Unlock()
	for _, id := range old {
		if err := s.st.Remove(id); err != nil {
			s.log.Error("removing an expired run failed", "run", id, "err", err)
		}
	}
	return len(old)
}

// RunSweeper calls Sweep now and then every hour until ctx ends.
func (s *Supervisor) RunSweeper(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if n := s.Sweep(); n > 0 {
			s.log.Info("removed expired runs", "count", n)
		}
		select {
		case <-t.C:
		case <-ctx.Done():
			return
		}
	}
}

// lastExit reads the exit record at the end of a finished log.
func lastExit(l *store.Log) (model.Exit, int64, bool) {
	cur, err := l.Seek(l.LastSeq())
	if err != nil {
		return model.Exit{}, 0, false
	}
	recs, err := l.Read(&cur, 1)
	if err != nil || len(recs) != 1 || recs[0].Kind != model.KindExit {
		return model.Exit{}, 0, false
	}
	var exit model.Exit
	if json.Unmarshal([]byte(recs[0].Line), &exit) != nil {
		return model.Exit{}, 0, false
	}
	return exit, recs[0].TS, true
}
