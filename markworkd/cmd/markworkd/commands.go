package main

import (
	"fmt"
	"net"
	"os"
	"text/tabwriter"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/bridge"
	"github.com/EkaPutCom/markwork/markworkd/internal/client"
	"github.com/EkaPutCom/markwork/markworkd/internal/model"
	"github.com/EkaPutCom/markwork/markworkd/internal/protocol"
)

func dial(c *common) (*client.Client, error) {
	return client.Dial(c.paths.Socket, "markworkd-cli/"+version)
}

func cmdStart(args []string) int {
	fs, c := newFlags("start")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if err := ensureDaemon(c); err != nil {
		return fail("%v", err)
	}
	fmt.Println("markworkd is running on", c.paths.Socket)
	return 0
}

func cmdStop(args []string) int {
	fs, c := newFlags("stop")
	force := fs.Bool("force", false, "stop active runs too")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	cl, err := dial(c)
	if err != nil {
		fmt.Println("markworkd is not running")
		return 0
	}
	defer cl.Close()
	if err := cl.Shutdown(*force); err != nil {
		return fail("%v", err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("unix", c.paths.Socket, time.Second)
		if err != nil {
			fmt.Println("markworkd stopped")
			return 0
		}
		conn.Close()
		time.Sleep(100 * time.Millisecond)
	}
	return fail("the daemon is still answering after 15 seconds")
}

func cmdStatus(args []string) int {
	fs, c := newFlags("status")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	cl, err := dial(c)
	if err != nil {
		fmt.Println("markworkd is not running")
		return 1
	}
	defer cl.Close()
	info, err := cl.Info()
	if err != nil {
		return fail("%v", err)
	}
	fmt.Printf("%s on %s (pid %d)\n", info.Daemon, info.Machine, info.PID)
	fmt.Printf("started   %s\nstate     %s\nsocket    %s\n", shortTime(info.StartedAt), info.StateDir, c.paths.Socket)
	fmt.Printf("runs      %d running, %d queued, %d finished (limit %d active)\n", info.Running, info.Queued, info.Exited, info.MaxActiveRuns)
	return 0
}

func cmdBridge(args []string) int {
	fs, c := newFlags("bridge")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if err := bridge.Run(c.paths.Socket, func() error { return ensureDaemon(c) }, os.Stdin, os.Stdout); err != nil {
		return fail("%v", err)
	}
	return 0
}

func cmdList(args []string) int {
	fs, c := newFlags("list")
	state := fs.String("state", "", "only runs in this state (queued, running, exited)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	cl, err := dial(c)
	if err != nil {
		return fail("%v", err)
	}
	defer cl.Close()
	runs, err := cl.List(protocol.ListParams{State: model.State(*state)})
	if err != nil {
		return fail("%v", err)
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "RUN\tSTATE\tLANE\tPROGRAM\tSTARTED\tEXIT")
	for _, r := range runs {
		exit := "-"
		if r.Exit != nil {
			exit = string(r.Exit.Reason)
			if r.Exit.Code != nil {
				exit += fmt.Sprintf(" (%d)", *r.Exit.Code)
			}
		}
		started := "-"
		if r.StartedAt != nil {
			started = shortTime(*r.StartedAt)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", r.Run, r.State, r.Lane, r.Program, started, exit)
	}
	tw.Flush()
	return 0
}

func cmdLogs(args []string) int {
	fs, c := newFlags("logs")
	from := fs.Uint64("from", 0, "first record to print (default: the start)")
	follow := fs.Bool("follow", false, "keep printing until the run ends")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: markworkd logs [--from N] [--follow] <run>")
		return 2
	}
	run := fs.Arg(0)
	cl, err := dial(c)
	if err != nil {
		return fail("%v", err)
	}
	defer cl.Close()
	sub, err := cl.Subscribe(run, *from)
	if err != nil {
		return fail("%v", err)
	}
	for rec := range sub.Records {
		fmt.Printf("%6d  %s  %-5s  %s\n", rec.Seq, time.UnixMilli(rec.TS).Format("15:04:05.000"), rec.Kind, rec.Line)
		if !*follow && rec.Seq >= sub.Result.LastSeq {
			return 0
		}
	}
	if err := sub.Err(); err != nil {
		return fail("%v", err)
	}
	return 0
}
