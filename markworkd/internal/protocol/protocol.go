// Package protocol defines the wire format of markworkd: newline-delimited JSON requests, responses and events.
package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"sync"

	"github.com/EkaPutCom/markwork/markworkd/internal/model"
)

// Version is the major protocol version. New optional fields and ops do not change it.
const Version = 1

// MaxFrame is the largest accepted inbound frame.
const MaxFrame = 16 << 20

// Operation names.
const (
	OpHello       = "hello"
	OpPing        = "ping"
	OpInfo        = "info"
	OpSpawn       = "spawn"
	OpWrite       = "write"
	OpCloseStdin  = "close_stdin"
	OpStop        = "stop"
	OpSubscribe   = "subscribe"
	OpUnsubscribe = "unsubscribe"
	OpWatch       = "watch"
	OpList        = "list"
	OpGet         = "get"
	OpForget      = "forget"
	OpStderr      = "stderr"
	OpShutdown    = "shutdown"
)

// Event names.
const (
	EvRecord        = "record"
	EvEnd           = "end"
	EvState         = "state"
	EvWatchOverflow = "watch_overflow"
	EvBridge        = "bridge"
)

// Envelope is the part of every request that the daemon reads before knowing the operation.
type Envelope struct {
	ID string `json:"id"`
	Op string `json:"op"`
}

// ---------- request parameters ----------

type HelloParams struct {
	Proto  int    `json:"proto"`
	Client string `json:"client"`
}

// RunParams is shared by the ops that only name a run.
type RunParams struct {
	Run     string `json:"run"`
	GraceMS int    `json:"grace_ms,omitempty"` // stop
}

type WriteParams struct {
	Run  string `json:"run"`
	Line string `json:"line"`
}

type SubscribeParams struct {
	Run     string `json:"run"`
	FromSeq uint64 `json:"from_seq,omitempty"`
}

type StderrParams struct {
	Run       string `json:"run"`
	TailBytes int    `json:"tail_bytes,omitempty"`
}

type ListParams struct {
	State  model.State       `json:"state,omitempty"`
	Lane   string            `json:"lane,omitempty"`
	Labels map[string]string `json:"labels,omitempty"`
}

type ShutdownParams struct {
	Force  bool `json:"force,omitempty"`
	Detach bool `json:"detach,omitempty"` // leave the runs going under their shims (for an upgrade)
}

// ---------- results ----------

type HelloResult struct {
	Proto    int      `json:"proto"`
	Daemon   string   `json:"daemon"`
	Machine  string   `json:"machine"`
	PID      int      `json:"pid"`
	Features []string `json:"features"`
}

type InfoResult struct {
	Daemon        string `json:"daemon"`
	Machine       string `json:"machine"`
	PID           int    `json:"pid"`
	StartedAt     int64  `json:"started_at"`
	StateDir      string `json:"state_dir"`
	Queued        int    `json:"queued"`
	Running       int    `json:"running"`
	Exited        int    `json:"exited"`
	MaxActiveRuns int    `json:"max_active_runs"`
}

type SpawnResult struct {
	Run      string      `json:"run"`
	State    model.State `json:"state"`
	Position int         `json:"position"`
	Existing bool        `json:"existing,omitempty"`
}

type WriteResult struct {
	Seq uint64 `json:"seq"`
}

type SubscribeResult struct {
	FirstSeq uint64      `json:"first_seq"`
	LastSeq  uint64      `json:"last_seq"`
	State    model.State `json:"state"`
}

type StderrResult struct {
	Text        string `json:"text"`
	HeadDropped bool   `json:"head_dropped"`
}

type ListResult struct {
	Runs []model.Summary `json:"runs"`
}

type WatchResult struct {
	Runs []model.Summary `json:"runs"`
}

// ---------- events ----------

type RecordEvent struct {
	Ev  string `json:"ev"`
	Run string `json:"run"`
	model.Record
}

type EndEvent struct {
	Ev      string `json:"ev"`
	Run     string `json:"run"`
	LastSeq uint64 `json:"last_seq"`
}

type StateEvent struct {
	Ev      string      `json:"ev"`
	Run     string      `json:"run"`
	State   model.State `json:"state"`
	Exit    *model.Exit `json:"exit,omitempty"`
	LastSeq uint64      `json:"last_seq"`
}

type BareEvent struct {
	Ev    string `json:"ev"`
	Proto int    `json:"proto,omitempty"`
}

// ---------- response framing ----------

type responseHead struct {
	Re    string       `json:"re"`
	OK    bool         `json:"ok"`
	Error *model.Error `json:"error,omitempty"`
}

// EncodeResponse builds a successful response. result must marshal to a JSON object (or be nil); its fields are
// placed next to "re" and "ok".
func EncodeResponse(re string, result any) ([]byte, error) {
	head, err := json.Marshal(responseHead{Re: re, OK: true})
	if err != nil {
		return nil, err
	}
	if result == nil {
		return head, nil
	}
	body, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if len(body) < 2 || body[0] != '{' {
		return nil, errors.New("protocol: result is not a JSON object")
	}
	if len(body) == 2 { // {}
		return head, nil
	}
	out := make([]byte, 0, len(head)+len(body))
	out = append(out, head[:len(head)-1]...)
	out = append(out, ',')
	out = append(out, body[1:]...)
	return out, nil
}

// EncodeError builds a failed response.
func EncodeError(re string, e *model.Error) []byte {
	b, _ := json.Marshal(responseHead{Re: re, OK: false, Error: e})
	return b
}

// ---------- line codec ----------

// ErrFrameTooLarge is returned by Decoder.Next when a line is longer than the limit.
var ErrFrameTooLarge = errors.New("protocol: frame too large")

// Decoder reads newline-delimited frames.
type Decoder struct {
	r   *bufio.Reader
	max int
	buf []byte
}

func NewDecoder(r io.Reader, max int) *Decoder {
	return &Decoder{r: bufio.NewReaderSize(r, 64<<10), max: max}
}

// Next returns the next non-empty frame without its newline. The slice is valid until the next call.
func (d *Decoder) Next() ([]byte, error) {
	for {
		d.buf = d.buf[:0]
		for {
			chunk, err := d.r.ReadSlice('\n')
			d.buf = append(d.buf, chunk...)
			if len(d.buf) > d.max+1 {
				return nil, ErrFrameTooLarge
			}
			if err == nil {
				break
			}
			if errors.Is(err, bufio.ErrBufferFull) {
				continue
			}
			if err == io.EOF && len(bytes.TrimSpace(d.buf)) > 0 {
				break // a last frame without a newline
			}
			return nil, err
		}
		frame := bytes.TrimRight(d.buf, "\r\n")
		if len(bytes.TrimSpace(frame)) == 0 {
			continue
		}
		return frame, nil
	}
}

// Encoder writes frames; it is safe for concurrent use.
type Encoder struct {
	mu sync.Mutex
	w  io.Writer
}

func NewEncoder(w io.Writer) *Encoder { return &Encoder{w: w} }

// Send writes one frame followed by a newline, in a single Write call.
func (e *Encoder) Send(frame []byte) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]byte, 0, len(frame)+1)
	out = append(out, frame...)
	out = append(out, '\n')
	_, err := e.w.Write(out)
	return err
}

// SendValue marshals v and sends it.
func (e *Encoder) SendValue(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return e.Send(b)
}
