package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/config"
	"github.com/EkaPutCom/markwork/markworkd/internal/daemonize"
	"github.com/EkaPutCom/markwork/markworkd/internal/runner"
	"github.com/EkaPutCom/markwork/markworkd/internal/server"
	"github.com/EkaPutCom/markwork/markworkd/internal/store"
	"github.com/EkaPutCom/markwork/markworkd/internal/supervisor"
)

func cmdServe(args []string) int {
	fs, c := newFlags("serve")
	hostname, _ := os.Hostname()
	machine := fs.String("machine", hostname, "name this machine reports to clients")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg, err := config.Load(c.paths.ConfigFile)
	if err != nil {
		return fail("%v", err)
	}
	if err := os.MkdirAll(c.paths.StateDir, 0o700); err != nil {
		return fail("%v", err)
	}
	lock, err := daemonize.Lock(filepath.Join(c.paths.StateDir, "lock"))
	if err != nil {
		return fail("%v", err)
	}
	defer lock.Close()

	st, err := store.Open(c.paths.StateDir)
	if err != nil {
		return fail("%v", err)
	}
	sup := supervisor.New(supervisor.Options{
		Config: cfg, Store: st, Logger: log,
		Launcher: runner.OSLauncher{MaxLine: cfg.MaxLineBytes},
	})
	if err := sup.Recover(); err != nil {
		return fail("recovering runs: %v", err)
	}
	activated := os.Getenv("LISTEN_FDS") != "" // Listen takes it out of the environment
	ln, err := server.Listen(c.paths.Socket)
	if err != nil {
		return fail("%v", err)
	}
	srv := server.New(server.Options{
		Supervisor: sup, Logger: log, Version: version, Machine: *machine,
		StateDir: c.paths.StateDir, MaxActiveRuns: cfg.MaxActiveRuns,
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go sup.RunSweeper(ctx)
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	where := c.paths.Socket
	if activated {
		where = "inherited from the service manager"
	}
	log.Info("markworkd started", "version", version, "socket", where, "state", c.paths.StateDir, "roots", len(cfg.Roots))
	if len(cfg.Roots) == 0 {
		log.Warn("no roots are configured, so every spawn will be refused; set \"roots\" in " + c.paths.ConfigFile)
	}

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	code := 0
	select {
	case s := <-sigs:
		log.Info("stopping", "signal", s.String())
	case <-srv.ShutdownRequested():
		log.Info("stopping on request")
	case err := <-served:
		if err != nil {
			log.Error("the listener failed", "err", err)
			code = 1
		}
	}
	// Active runs are stopped in an orderly way, so they end as "stopped" with a complete log, not as "lost".
	sup.StopAll(5 * time.Second)
	srv.Close()
	log.Info("markworkd stopped")
	return code
}

func ensureDaemon(c *common) error {
	if cl, err := dial(c); err == nil {
		cl.Close()
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(c.paths.StateDir, 0o700); err != nil {
		return err
	}
	if err := daemonize.Start(exe, append([]string{"serve"}, c.args()...), logPath(c)); err != nil {
		return err
	}
	if err := daemonize.WaitForSocket(c.paths.Socket, 10*time.Second); err != nil {
		return fmt.Errorf("%w (see %s)", err, logPath(c))
	}
	return nil
}
