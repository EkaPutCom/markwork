// Command fakeagent is a stand-in for a real agent in tests. It reads lines from stdin and reacts to them.
//
//	exit N        exit with status N
//	big N         print one stdout line of N 'x' characters
//	err TEXT      print TEXT to stderr
//	out TEXT      print TEXT to stdout
//	env NAME      print the value of an environment variable, or "<unset>"
//	sockets       print how many socket descriptors the process has open
//	crlf          print a line ending in CRLF
//	sleep MS      sleep
//	after MS TEXT print TEXT to stdout after MS milliseconds, without waiting
//	exitafter MS N exit with status N after MS milliseconds, without waiting
//	anything else is echoed as "echo:<line>"
//
// Flags: -ignore-term ignores SIGTERM, -hold starts a background child that keeps stdout open for 30 s,
// -ignore-eof keeps running when stdin ends, -hello TEXT prints a line at startup, -stderr TEXT prints to stderr at startup.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	ignoreTerm := flag.Bool("ignore-term", false, "ignore SIGTERM")
	ignoreEOF := flag.Bool("ignore-eof", false, "keep running when stdin ends")
	hold := flag.Bool("hold", false, "start a child that holds stdout open")
	holdChild := flag.Bool("hold-child", false, "internal")
	hello := flag.String("hello", "", "print this at startup")
	stderrText := flag.String("stderr", "", "print this to stderr at startup")
	flag.Parse()

	if *holdChild {
		time.Sleep(30 * time.Second)
		return
	}
	if *ignoreTerm {
		signal.Ignore(syscall.SIGTERM)
	}
	if *hold {
		c := exec.Command(os.Args[0], "-hold-child")
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		if err := c.Start(); err != nil {
			fmt.Fprintln(os.Stderr, "hold:", err)
		}
	}
	if *hello != "" {
		fmt.Println(*hello)
	}
	if *stderrText != "" {
		fmt.Fprintln(os.Stderr, *stderrText)
	}
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, err := in.ReadString('\n')
		line = strings.TrimRight(line, "\n")
		if line != "" {
			cmd, arg, _ := strings.Cut(line, " ")
			switch cmd {
			case "exit":
				n, _ := strconv.Atoi(arg)
				os.Exit(n)
			case "big":
				n, _ := strconv.Atoi(arg)
				fmt.Println(strings.Repeat("x", n))
			case "err":
				fmt.Fprintln(os.Stderr, arg)
			case "out":
				fmt.Println(arg)
			case "env":
				if v, ok := os.LookupEnv(arg); ok {
					fmt.Println("env:" + v)
				} else {
					fmt.Println("env:<unset>")
				}
			case "sockets":
				n := 0
				entries, _ := os.ReadDir("/proc/self/fd")
				for _, e := range entries {
					if target, err := os.Readlink("/proc/self/fd/" + e.Name()); err == nil && strings.HasPrefix(target, "socket:") {
						n++
					}
				}
				fmt.Printf("sockets:%d\n", n)
			case "crlf":
				fmt.Print("with-cr\r\n")
			case "after":
				ms, text, _ := strings.Cut(arg, " ")
				n, _ := strconv.Atoi(ms)
				go func() { time.Sleep(time.Duration(n) * time.Millisecond); fmt.Println(text) }()
			case "exitafter":
				ms, code, _ := strings.Cut(arg, " ")
				n, _ := strconv.Atoi(ms)
				c, _ := strconv.Atoi(code)
				go func() { time.Sleep(time.Duration(n) * time.Millisecond); os.Exit(c) }()
			case "sleep":
				n, _ := strconv.Atoi(arg)
				time.Sleep(time.Duration(n) * time.Millisecond)
			default:
				fmt.Println("echo:" + line)
			}
		}
		if err != nil {
			if *ignoreEOF {
				time.Sleep(time.Hour)
			}
			fmt.Println("eof")
			return
		}
	}
}
