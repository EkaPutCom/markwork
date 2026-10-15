package store

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"

	"github.com/EkaPutCom/markwork/markworkd/internal/model"
)

// indexEvery is the spacing of the sparse offset index: the offset of record 1, 257, 513, ... is remembered.
const indexEvery = 256

// ErrCorrupt means the log has an unreadable line that is not the last one.
var ErrCorrupt = errors.New("store: event log is corrupt")

// Log is the append-only record log of one run. The log is the buffer between a run and its subscribers: readers
// open the file themselves, so a slow reader never blocks the writer.
type Log struct {
	path     string
	mu       sync.Mutex
	f        *os.File // nil when read-only or closed
	size     int64    // bytes committed
	lastSeq  uint64
	outCount uint64 // records of kind "out": with a shim, the number of agent lines already delivered
	index    []int64
	finished bool // an exit record was written
	notify   chan struct{}
}

// OpenLog scans the file to rebuild the index and the last sequence number. When the file is writable a partial
// last line (a crash during an append) is cut off. A missing file is created empty when writable.
func OpenLog(path string, readOnly bool) (*Log, error) {
	l := &Log{path: path, notify: make(chan struct{})}
	flags := os.O_RDONLY
	if !readOnly {
		flags = os.O_RDWR | os.O_CREATE | os.O_APPEND
	}
	f, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return nil, err
	}
	if err := l.scan(f, readOnly); err != nil {
		f.Close()
		return nil, err
	}
	if readOnly {
		f.Close()
	} else {
		l.f = f
	}
	return l, nil
}

func (l *Log) scan(f *os.File, readOnly bool) error {
	br := bufio.NewReaderSize(f, 256<<10)
	var off int64
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			complete := line[len(line)-1] == '\n'
			var rec model.Record
			bad := !complete || json.Unmarshal(line, &rec) != nil || rec.Seq != l.lastSeq+1
			if bad {
				// Only the last line may be bad (a crash while appending).
				if _, peekErr := br.Peek(1); peekErr == nil {
					return fmt.Errorf("%w: %s at offset %d", ErrCorrupt, l.path, off)
				}
				if !readOnly {
					if err := f.Truncate(off); err != nil {
						return err
					}
				}
				l.size = off
				return nil
			}
			if rec.Seq%indexEvery == 1 {
				l.index = append(l.index, off)
			}
			l.lastSeq = rec.Seq
			if rec.Kind == model.KindOut {
				l.outCount++
			}
			if rec.Kind == model.KindExit {
				l.finished = true
			}
			off += int64(len(line))
		}
		if err == io.EOF {
			l.size = off
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func (l *Log) LastSeq() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastSeq
}

// OutCount is the number of "out" records in the log.
func (l *Log) OutCount() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.outCount
}

func (l *Log) Size() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.size
}

// Finished reports whether the exit record was written.
func (l *Log) Finished() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.finished
}

// Notify returns a channel that is closed by the next append. Take it before reading, so no append is missed.
func (l *Log) Notify() <-chan struct{} {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.notify
}

// ErrReadOnly is returned when appending to a log that is closed or was opened read-only.
var ErrReadOnly = errors.New("store: event log is not writable")

// Append adds a record, assigning its sequence number, and wakes the readers.
func (l *Log) Append(kind model.Kind, line string, truncated bool, tsMillis int64) (model.Record, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return model.Record{}, ErrReadOnly
	}
	rec := model.Record{Seq: l.lastSeq + 1, TS: tsMillis, Kind: kind, Line: line, Truncated: truncated}
	data, err := json.Marshal(rec)
	if err != nil {
		return rec, err
	}
	data = append(data, '\n')
	if n, err := l.f.Write(data); err != nil {
		if n > 0 { // a partial record would corrupt the log; take it back
			_ = l.f.Truncate(l.size)
		}
		return rec, err
	}
	if rec.Seq%indexEvery == 1 {
		l.index = append(l.index, l.size)
	}
	l.size += int64(len(data))
	l.lastSeq = rec.Seq
	if kind == model.KindOut {
		l.outCount++
	}
	if kind == model.KindExit {
		l.finished = true
	}
	close(l.notify)
	l.notify = make(chan struct{})
	return rec, nil
}

// Sync flushes the file to disk.
func (l *Log) Sync() error {
	l.mu.Lock()
	f := l.f
	l.mu.Unlock()
	if f == nil {
		return nil
	}
	return f.Sync()
}

// CloseWriter closes the file handle used for appending; reading keeps working.
func (l *Log) CloseWriter() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}

// Cursor is a position in the log: the offset of record Next.
type Cursor struct {
	Off  int64
	Next uint64
}

// Seek returns a cursor at record seq. seq 0 means the start; a seq beyond the end means "only new records".
func (l *Log) Seek(seq uint64) (Cursor, error) {
	l.mu.Lock()
	last, size := l.lastSeq, l.size
	var start int64
	var k uint64
	if seq < 1 {
		seq = 1
	}
	if seq > last {
		l.mu.Unlock()
		return Cursor{Off: size, Next: last + 1}, nil
	}
	k = (seq - 1) / indexEvery
	start = l.index[k]
	l.mu.Unlock()

	c := Cursor{Off: start, Next: k*indexEvery + 1}
	skip := int(seq - c.Next)
	if skip == 0 {
		return c, nil
	}
	f, err := os.Open(l.path)
	if err != nil {
		return c, err
	}
	defer f.Close()
	br := bufio.NewReaderSize(io.NewSectionReader(f, c.Off, size-c.Off), 64<<10)
	for i := 0; i < skip; i++ {
		line, err := br.ReadBytes('\n')
		if err != nil {
			return c, err
		}
		c.Off += int64(len(line))
		c.Next++
	}
	return c, nil
}

// Read returns up to max records starting at the cursor and advances it. It returns an empty slice at the end.
func (l *Log) Read(c *Cursor, max int) ([]model.Record, error) {
	l.mu.Lock()
	size := l.size
	l.mu.Unlock()
	if c.Off >= size {
		return nil, nil
	}
	f, err := os.Open(l.path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	br := bufio.NewReaderSize(io.NewSectionReader(f, c.Off, size-c.Off), 64<<10)
	var out []model.Record
	for len(out) < max {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			var rec model.Record
			if jerr := json.Unmarshal(bytes.TrimRight(line, "\n"), &rec); jerr != nil {
				return out, fmt.Errorf("%w: %s at offset %d", ErrCorrupt, l.path, c.Off)
			}
			out = append(out, rec)
			c.Off += int64(len(line))
			c.Next = rec.Seq + 1
		}
		if err != nil {
			break
		}
	}
	return out, nil
}
