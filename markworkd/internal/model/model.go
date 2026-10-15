// Package model holds the types shared by every part of markworkd. The JSON tags are the wire format.
package model

import (
	"reflect"
	"regexp"
)

type State string

const (
	StateQueued  State = "queued"
	StateRunning State = "running"
	StateExited  State = "exited"
)

// Reason says why a run is in the exited state.
type Reason string

const (
	ReasonExited      Reason = "exited"
	ReasonSignaled    Reason = "signaled"
	ReasonStopped     Reason = "stopped"
	ReasonCanceled    Reason = "canceled"
	ReasonStartFailed Reason = "start_failed"
	ReasonIdleTimeout Reason = "idle_timeout"
	ReasonLogLimit    Reason = "log_limit"
	ReasonLost        Reason = "lost"
)

// Kind is the kind of a log record.
type Kind string

const (
	KindStart Kind = "start"
	KindIn    Kind = "in"
	KindOut   Kind = "out"
	KindExit  Kind = "exit"
)

// Record is one entry of a run's log.
type Record struct {
	Seq       uint64 `json:"seq"`
	TS        int64  `json:"ts"`
	Kind      Kind   `json:"kind"`
	Line      string `json:"line"`
	Truncated bool   `json:"truncated,omitempty"`
}

// Exit describes how a run ended.
type Exit struct {
	Reason Reason `json:"reason"`
	Code   *int   `json:"code,omitempty"`
	Signal *int   `json:"signal,omitempty"`
	Error  string `json:"error,omitempty"`
}

// SpawnSpec is what a client asks for. It is also stored as is, so a queued run can be started after a restart.
type SpawnSpec struct {
	Run          string            `json:"run"`
	Program      string            `json:"program"`
	Args         []string          `json:"args"`
	Cwd          string            `json:"cwd"`
	Lane         string            `json:"lane,omitempty"`
	LaneSlots    int               `json:"lane_slots,omitempty"` // how many runs of the lane may run at once with this one; 0 = 1
	Env          map[string]string `json:"env,omitempty"`
	Labels       map[string]string `json:"labels,omitempty"`
	InitialInput []string          `json:"initial_input,omitempty"`
	IdleTTLSec   *int              `json:"idle_ttl_sec,omitempty"`
}

// Normalize makes nil and empty collections equal, so two specs can be compared.
func (s *SpawnSpec) Normalize() {
	if s.Args == nil {
		s.Args = []string{}
	}
	if len(s.Env) == 0 {
		s.Env = nil
	}
	if len(s.Labels) == 0 {
		s.Labels = nil
	}
	if len(s.InitialInput) == 0 {
		s.InitialInput = nil
	}
}

// Equal reports whether two specs ask for the same run (used for idempotent spawn).
func (s SpawnSpec) Equal(o SpawnSpec) bool {
	s.Normalize()
	o.Normalize()
	return reflect.DeepEqual(s, o)
}

// Summary is the public view of a run.
type Summary struct {
	Run           string            `json:"run"`
	State         State             `json:"state"`
	Program       string            `json:"program"`
	Args          []string          `json:"args"`
	Cwd           string            `json:"cwd"`
	Lane          string            `json:"lane,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
	PID           int               `json:"pid,omitempty"`
	CreatedAt     int64             `json:"created_at"`
	StartedAt     *int64            `json:"started_at"`
	EndedAt       *int64            `json:"ended_at"`
	Exit          *Exit             `json:"exit"`
	LastSeq       uint64            `json:"last_seq"`
	LogBytes      int64             `json:"log_bytes"`
	StderrBytes   int64             `json:"stderr_bytes"`
	QueuePosition int               `json:"queue_position"`
}

var runIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)

// ValidRunID reports whether s is acceptable as a run id (it becomes a directory name).
func ValidRunID(s string) bool { return runIDPattern.MatchString(s) }
