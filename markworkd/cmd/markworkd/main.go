// Command markworkd supervises the agent processes that Markwork orchestrates, so they keep running when Markwork
// is closed. See docs/design/markworkd.md.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/config"
	"github.com/EkaPutCom/markwork/markworkd/internal/shim"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.1.0-dev"

const usage = `markworkd: supervisor for Markwork's agent processes

Usage: markworkd <command> [flags]

Commands:
  serve            run the daemon in the foreground (for systemd)
  start            start the daemon in the background if it is not running
  stop [--force|--detach]  stop the daemon (refused while runs are active, unless --force, which
                   stops them, or --detach, which leaves them running under their shims)
  shim <dir>       internal: the helper that holds one agent (started by the daemon)
  status           show whether the daemon runs and what it holds
  bridge           connect stdin/stdout to the daemon's socket (use through ssh)
  list             list runs
  logs <run>       print a run's log (--from N, --follow)
  version          print the version

Common flags: --socket, --state-dir, --config (defaults follow the XDG directories).
`

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "serve":
		return cmdServe(rest)
	case "start":
		return cmdStart(rest)
	case "stop":
		return cmdStop(rest)
	case "status":
		return cmdStatus(rest)
	case "bridge":
		return cmdBridge(rest)
	case "list":
		return cmdList(rest)
	case "logs":
		return cmdLogs(rest)
	case "shim": // started by the daemon, one per run (docs/design/markworkd.md, section 17)
		if len(rest) != 1 {
			fmt.Fprintln(os.Stderr, "markworkd shim <run directory>")
			return 2
		}
		return shim.Main(rest[0])
	case "version", "--version", "-v":
		fmt.Println("markworkd", version)
		return 0
	case "help", "--help", "-h":
		fmt.Print(usage)
		return 0
	}
	fmt.Fprintf(os.Stderr, "markworkd: unknown command %q\n\n%s", cmd, usage)
	return 2
}

// common holds the flags every command shares.
type common struct {
	paths config.Paths
}

func newFlags(name string) (*flag.FlagSet, *common) {
	c := &common{paths: config.DefaultPaths()}
	fs := flag.NewFlagSet("markworkd "+name, flag.ContinueOnError)
	fs.StringVar(&c.paths.Socket, "socket", c.paths.Socket, "path of the Unix socket")
	fs.StringVar(&c.paths.StateDir, "state-dir", c.paths.StateDir, "directory for runs and logs")
	fs.StringVar(&c.paths.ConfigFile, "config", c.paths.ConfigFile, "path of config.json")
	return fs, c
}

// commonArgs rebuilds the flags to pass on to a background daemon.
func (c *common) args() []string {
	return []string{"--socket", c.paths.Socket, "--state-dir", c.paths.StateDir, "--config", c.paths.ConfigFile}
}

func fail(format string, args ...any) int {
	fmt.Fprintf(os.Stderr, "markworkd: "+format+"\n", args...)
	return 1
}

func shortTime(ms int64) string {
	if ms == 0 {
		return "-"
	}
	return time.UnixMilli(ms).Format("2006-01-02 15:04:05")
}

func logPath(c *common) string { return filepath.Join(c.paths.StateDir, "daemon.log") }
