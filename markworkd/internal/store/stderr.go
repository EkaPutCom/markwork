package store

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"
)

// Stderr is a bounded file of raw stderr bytes. When it reaches twice max it is rewritten to keep the last max
// bytes, so the end of the output (where errors usually are) is what survives.
type Stderr struct {
	path    string
	max     int64
	mu      sync.Mutex
	f       *os.File
	size    int64
	rotated bool
	failed  bool
}

var _ io.Writer = (*Stderr)(nil)

func OpenStderr(path string, max int64) (*Stderr, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	return &Stderr{path: path, max: max, f: f, size: st.Size(), rotated: st.Size() > max}, nil
}

// Write appends p. It never returns an error: a failing disk must not make the copy from the agent's stderr stop,
// because the agent would then block on a full pipe.
func (e *Stderr) Write(p []byte) (int, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.f == nil || e.failed {
		return len(p), nil
	}
	n, err := e.f.Write(p)
	e.size += int64(n)
	if err != nil {
		e.failed = true
		return len(p), nil
	}
	if e.size >= 2*e.max {
		e.rotate()
	}
	return len(p), nil
}

func (e *Stderr) rotate() {
	tail := make([]byte, e.max)
	n, err := e.f.ReadAt(tail, e.size-e.max)
	if err != nil && err != io.EOF {
		e.failed = true
		return
	}
	tmp := filepath.Join(filepath.Dir(e.path), "stderr.log.tmp")
	if err := os.WriteFile(tmp, tail[:n], 0o600); err != nil {
		e.failed = true
		return
	}
	if err := os.Rename(tmp, e.path); err != nil {
		e.failed = true
		return
	}
	nf, err := os.OpenFile(e.path, os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		e.failed = true
		return
	}
	e.f.Close()
	e.f = nf
	e.size = int64(n)
	e.rotated = true
}

func (e *Stderr) Size() int64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.size
}

// Close stops writing; the file stays readable.
func (e *Stderr) Close() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.f == nil {
		return nil
	}
	err := e.f.Close()
	e.f = nil
	return err
}

// ReadTail returns the last n bytes of the file at path as text, and whether earlier output exists that is not
// included. The cut is made at a character boundary.
func ReadTail(path string, n int, rotated bool) (string, bool, error) {
	f, err := os.Open(path)
	if err != nil {
		if IsNotExist(err) {
			return "", false, nil
		}
		return "", false, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", false, err
	}
	size := st.Size()
	start := size - int64(n)
	if start < 0 {
		start = 0
	}
	buf := make([]byte, size-start)
	if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
		return "", false, err
	}
	if start > 0 {
		for len(buf) > 0 && !utf8.RuneStart(buf[0]) {
			buf = buf[1:]
		}
	}
	return strings.ToValidUTF8(string(buf), "�"), start > 0 || rotated, nil
}

// Tail returns the last n bytes written so far (see ReadTail).
func (e *Stderr) Tail(n int) (string, bool, error) {
	e.mu.Lock()
	rotated := e.rotated
	e.mu.Unlock()
	if int64(n) > e.max {
		n = int(e.max)
	}
	return ReadTail(e.path, n, rotated)
}
