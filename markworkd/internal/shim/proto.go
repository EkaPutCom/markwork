// Package shim keeps an agent alive when the daemon goes away. For every run the daemon starts `markworkd shim`,
// a small helper that owns the agent's pipes and serves them on a Unix socket in the run's directory; the daemon
// (this one or the next) talks to the shim instead of to the agent. See docs/design/markworkd.md, section 17.
package shim

// Proto is the version of the protocol between a daemon and a shim.
const Proto = 1

// File names inside a run's directory.
const (
	sockName  = "shim.sock"
	specName  = "shim.json"
	spoolName = "shim-out.log"
	exitName  = "shim-exit.json"
	logName   = "shim.log"
	stderrLog = "stderr.log"
)

// Events a shim sends and ops a daemon sends.
const (
	evHello    = "hello"
	evOut      = "out"
	evActivity = "activity"
	evWrote    = "wrote"
	evExit     = "exit"

	opAttach     = "attach"
	opAck        = "ack"
	opWrite      = "write"
	opCloseStdin = "close_stdin"
	opBye        = "bye"
)

// Errors a shim reports for a write; the daemon maps them to the runner's errors.
const (
	errStdinClosed  = "stdin_closed"
	errWriteTimeout = "write_timeout"
)

// Frame is one line of the protocol, in either direction. Only the fields of its event or op are set.
type Frame struct {
	Ev string `json:"ev,omitempty"`
	Op string `json:"op,omitempty"`

	// hello
	Proto  int    `json:"proto,omitempty"`
	PID    int    `json:"pid,omitempty"`
	Lines  uint64 `json:"lines,omitempty"`  // lines produced so far
	Acked  uint64 `json:"acked,omitempty"`  // lines below this are no longer kept
	Exited bool   `json:"exited,omitempty"` // the agent has ended

	// out (n is also the line number an ack or an attach refers to)
	N         uint64 `json:"n"`
	Text      string `json:"text,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`

	// attach
	From uint64 `json:"from"`

	// write / wrote
	ID        int64  `json:"id,omitempty"`
	Line      string `json:"line,omitempty"`
	TimeoutMS int64  `json:"timeout_ms,omitempty"`

	// exit
	Code     int    `json:"code,omitempty"`
	Signal   int    `json:"signal,omitempty"`
	Signaled bool   `json:"signaled,omitempty"`
	Reason   string `json:"reason,omitempty"` // set when the shim itself ended the agent (log_limit)

	Error string `json:"error,omitempty"`
}

// Spec is what the daemon hands the shim in shim.json.
type Spec struct {
	Program   string   `json:"program"`
	Args      []string `json:"args"`
	Dir       string   `json:"dir"`
	Env       []string `json:"env"`
	MaxLine   int      `json:"max_line"`
	StderrMax int64    `json:"stderr_max"`
	SpoolMax  int64    `json:"spool_max"`
	LingerSec int      `json:"linger_sec"`
}
