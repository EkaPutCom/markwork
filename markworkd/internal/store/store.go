// Package store is the on-disk layout of markworkd: one directory per run with meta.json, events.jsonl and stderr.log.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"

	"github.com/EkaPutCom/markwork/markworkd/internal/model"
)

// Meta is the state of a run that must survive a restart of the daemon.
type Meta struct {
	Spec        model.SpawnSpec `json:"spec"`
	State       model.State     `json:"state"`
	PID         int             `json:"pid,omitempty"`
	PGID        int             `json:"pgid,omitempty"`
	StartTicks  uint64          `json:"start_ticks,omitempty"` // /proc start time of PID; guards against pid reuse
	CreatedAt   int64           `json:"created_at"`
	StartedAt   int64           `json:"started_at,omitempty"`
	EndedAt     int64           `json:"ended_at,omitempty"`
	Exit        *model.Exit     `json:"exit,omitempty"`
	LastSeq     uint64          `json:"last_seq,omitempty"`
	LogBytes    int64           `json:"log_bytes,omitempty"`
	StderrBytes int64           `json:"stderr_bytes,omitempty"`
}

// Store owns the state directory.
type Store struct {
	root string
}

// Open creates the state directory when needed.
func Open(root string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(root, "runs"), 0o700); err != nil {
		return nil, err
	}
	return &Store{root: root}, nil
}

func (s *Store) Root() string { return s.root }

func (s *Store) runDir(run string) (string, error) {
	if !model.ValidRunID(run) {
		return "", fmt.Errorf("invalid run id %q", run)
	}
	return filepath.Join(s.root, "runs", run), nil
}

// RunDir is the directory of a run.
func (s *Store) RunDir(run string) string {
	d, _ := s.runDir(run)
	return d
}

func (s *Store) LogPath(run string) string {
	d, _ := s.runDir(run)
	return filepath.Join(d, "events.jsonl")
}

func (s *Store) StderrPath(run string) string {
	d, _ := s.runDir(run)
	return filepath.Join(d, "stderr.log")
}

// RunIDs lists the stored runs.
func (s *Store) RunIDs() ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, "runs"))
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, e := range entries {
		if e.IsDir() && model.ValidRunID(e.Name()) {
			ids = append(ids, e.Name())
		}
	}
	sort.Strings(ids)
	return ids, nil
}

// Create makes the directory of a new run. It fails if the run exists.
func (s *Store) Create(run string) error {
	d, err := s.runDir(run)
	if err != nil {
		return err
	}
	return os.Mkdir(d, 0o700)
}

// SaveMeta replaces meta.json atomically (temp file, then rename).
func (s *Store) SaveMeta(run string, m *Meta) error {
	d, err := s.runDir(run)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(d, "meta.json.tmp")
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(d, "meta.json"))
}

// LoadMeta reads meta.json; fs.ErrNotExist means the run has none.
func (s *Store) LoadMeta(run string) (*Meta, error) {
	d, err := s.runDir(run)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(d, "meta.json"))
	if err != nil {
		return nil, err
	}
	var m Meta
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("run %s: meta.json: %w", run, err)
	}
	return &m, nil
}

// Remove deletes a run's directory.
func (s *Store) Remove(run string) error {
	d, err := s.runDir(run)
	if err != nil {
		return err
	}
	return os.RemoveAll(d)
}

// IsNotExist reports whether err means a missing file.
func IsNotExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }
