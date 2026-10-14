// Package bridge connects a stdio pair (typically the far end of an SSH session) to the daemon's Unix socket.
package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/protocol"
)

// Run dials the socket, starting the daemon with ensure if nobody answers, prints the sentinel line and copies bytes
// both ways until either side ends. The sentinel lets a client skip anything a login shell printed before it.
func Run(socket string, ensure func() error, in io.Reader, out io.Writer) error {
	conn, err := dial(socket, ensure)
	if err != nil {
		return err
	}
	defer conn.Close()
	banner, _ := json.Marshal(protocol.BareEvent{Ev: protocol.EvBridge, Proto: protocol.Version})
	if _, err := out.Write(append(banner, '\n')); err != nil {
		return err
	}
	done := make(chan error, 2)
	go func() { _, err := io.Copy(conn, in); done <- err }()
	go func() { _, err := io.Copy(out, conn); done <- err }()
	// The first side to finish ends the bridge: stdin closing means the SSH session is over, the socket closing
	// means the daemon went away. Runs are unaffected either way.
	err = <-done
	if errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}

func dial(socket string, ensure func() error) (net.Conn, error) {
	conn, err := net.DialTimeout("unix", socket, 2*time.Second)
	if err == nil {
		return conn, nil
	}
	if ensure == nil {
		return nil, err
	}
	if err := ensure(); err != nil {
		return nil, fmt.Errorf("starting the daemon: %w", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		conn, err = net.DialTimeout("unix", socket, 2*time.Second)
		if err == nil {
			return conn, nil
		}
		if time.Now().After(deadline) {
			return nil, err
		}
		time.Sleep(50 * time.Millisecond)
	}
}
