package config

import (
	"fmt"
	"os"
	"path/filepath"
)

// Paths are the locations the daemon uses. Every field can be overridden by a flag.
type Paths struct {
	Socket     string
	StateDir   string
	ConfigFile string
}

// DefaultPaths follows the XDG base directories.
func DefaultPaths() Paths {
	uid := os.Getuid()
	runtime := os.Getenv("XDG_RUNTIME_DIR")
	var sockDir string
	if runtime != "" {
		sockDir = filepath.Join(runtime, "markworkd")
	} else {
		sockDir = fmt.Sprintf("/tmp/markworkd-%d", uid)
	}
	home, _ := os.UserHomeDir()
	state := os.Getenv("XDG_STATE_HOME")
	if state == "" {
		state = filepath.Join(home, ".local", "state")
	}
	conf := os.Getenv("XDG_CONFIG_HOME")
	if conf == "" {
		conf = filepath.Join(home, ".config")
	}
	return Paths{
		Socket:     filepath.Join(sockDir, "markworkd.sock"),
		StateDir:   filepath.Join(state, "markworkd"),
		ConfigFile: filepath.Join(conf, "markworkd", "config.json"),
	}
}
