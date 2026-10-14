package server

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

// Listen returns the daemon's listener: the socket passed by systemd (LISTEN_FDS) when there is one, otherwise a new
// Unix socket at path. The directory is created 0700 and the socket 0600.
func Listen(path string) (net.Listener, error) {
	if ln, err := inheritedListener(); ln != nil || err != nil {
		return ln, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if _, err := os.Lstat(path); err == nil {
		// Something is there: a live daemon, or a stale socket from one that died.
		if c, err := net.DialTimeout("unix", path, time.Second); err == nil {
			c.Close()
			return nil, fmt.Errorf("a daemon is already listening on %s", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

// inheritedListener implements the receiving side of systemd socket activation (sd_listen_fds(3)): the first
// socket is file descriptor 3, announced by LISTEN_PID and LISTEN_FDS.
func inheritedListener() (net.Listener, error) {
	pid, fds := os.Getenv("LISTEN_PID"), os.Getenv("LISTEN_FDS")
	if pid == "" || fds == "" {
		return nil, nil
	}
	// The variables must not leak into the agents we start.
	defer os.Unsetenv("LISTEN_PID")
	defer os.Unsetenv("LISTEN_FDS")
	defer os.Unsetenv("LISTEN_FDNAMES")
	if p, err := strconv.Atoi(pid); err != nil || p != os.Getpid() {
		return nil, nil
	}
	if n, err := strconv.Atoi(fds); err != nil || n < 1 {
		return nil, nil
	}
	const first = 3
	syscall.CloseOnExec(first)
	f := os.NewFile(first, "systemd-socket")
	if f == nil {
		return nil, errors.New("LISTEN_FDS is set but fd 3 is not open")
	}
	defer f.Close() // FileListener duplicates the descriptor
	return net.FileListener(f)
}
