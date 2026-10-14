package model

import "fmt"

// Error codes carried in failed responses. Clients branch on the code, not the message.
const (
	CodeBadRequest        = "bad_request"
	CodeUnknownOp         = "unknown_op"
	CodeUnsupportedProto  = "unsupported_proto"
	CodeFrameTooLarge     = "frame_too_large"
	CodeNotFound          = "not_found"
	CodeConflict          = "conflict"
	CodeProgramNotAllowed = "program_not_allowed"
	CodeCwdNotAllowed     = "cwd_not_allowed"
	CodeEnvNotAllowed     = "env_not_allowed"
	CodeInvalidLine       = "invalid_line"
	CodeNotStarted        = "not_started"
	CodeNotRunning        = "not_running"
	CodeStdinClosed       = "stdin_closed"
	CodeWriteTimeout      = "write_timeout"
	CodeNotFinished       = "not_finished"
	CodeRunsActive        = "runs_active"
	CodeLimitExceeded     = "limit_exceeded"
	CodeInternal          = "internal"
)

// Error is a protocol error: a stable code and a message for people.
type Error struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Supported []int  `json:"supported,omitempty"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Errf builds an Error with a formatted message.
func Errf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// CodeShuttingDown is returned for new work while the daemon is stopping.
const CodeShuttingDown = "shutting_down"
