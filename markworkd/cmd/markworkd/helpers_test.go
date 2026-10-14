package main

import (
	"io"
	"net"
	"testing"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/client"
)

func waitSocket(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if c, err := net.DialTimeout("unix", path, time.Second); err == nil {
			c.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("nothing listens on %s", path)
}

func mustListen(t *testing.T, path string) *net.UnixListener {
	t.Helper()
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	ul := l.(*net.UnixListener)
	ul.SetUnlinkOnClose(false)
	t.Cleanup(func() { ul.Close() })
	return ul
}

type pipeReader struct{ io.Reader }
type pipeWriter struct{ io.Writer }

type rwcCloser struct {
	rw interface {
		io.Reader
		io.Writer
	}
	closeFn func()
}

func (r rwcCloser) Read(p []byte) (int, error)  { return r.rw.Read(p) }
func (r rwcCloser) Write(p []byte) (int, error) { return r.rw.Write(p) }
func (r rwcCloser) Close() error                { r.closeFn(); return nil }

func hello(c *client.Client) (string, error) {
	res, err := c.Hello("e2e-bridge")
	return res.Daemon, err
}
