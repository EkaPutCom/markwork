// Package config holds the daemon's paths and its configuration file.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Config is the contents of config.json. Missing keys keep their defaults; unknown keys are an error, so a typo
// cannot silently loosen a limit.
type Config struct {
	Roots             []string          `json:"roots"`
	Programs          map[string]string `json:"programs"`
	EnvAllow          []string          `json:"env_allow"`
	AgentEnv          map[string]string `json:"agent_env"`
	RetentionDays     int               `json:"retention_days"`
	DefaultIdleTTLSec int               `json:"default_idle_ttl_sec"`
	MaxActiveRuns     int               `json:"max_active_runs"`
	MaxLogBytes       int64             `json:"max_log_bytes"`
	MaxLineBytes      int               `json:"max_line_bytes"`
	MaxStderrBytes    int               `json:"max_stderr_bytes"`
}

// Default returns the built-in configuration. With no roots every spawn is refused.
func Default() Config {
	return Config{
		RetentionDays:     14,
		DefaultIdleTTLSec: 86400,
		MaxActiveRuns:     8,
		MaxLogBytes:       512 << 20,
		MaxLineBytes:      8 << 20,
		MaxStderrBytes:    1 << 20,
	}
}

// Load reads path over the defaults. A missing file is not an error.
func Load(path string) (Config, error) {
	c := Default()
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return Default(), fmt.Errorf("%s: %w", path, err)
	}
	if err := c.Validate(); err != nil {
		return Default(), fmt.Errorf("%s: %w", path, err)
	}
	return c, nil
}

// Validate checks the values.
func (c *Config) Validate() error {
	for _, r := range c.Roots {
		if !filepath.IsAbs(r) {
			return fmt.Errorf("root %q must be an absolute path", r)
		}
	}
	for name, path := range c.Programs {
		if name == "" || strings.ContainsRune(name, '/') {
			return fmt.Errorf("program name %q must not be empty or contain '/'", name)
		}
		if !filepath.IsAbs(path) {
			return fmt.Errorf("program %q must map to an absolute path", name)
		}
	}
	for k, v := range c.AgentEnv {
		if !envKey.MatchString(k) || strings.ContainsRune(v, 0) {
			return fmt.Errorf("agent_env entry %q is not a valid variable", k)
		}
	}
	for _, p := range c.EnvAllow {
		if p == "" || strings.Contains(strings.TrimSuffix(p, "*"), "*") {
			return fmt.Errorf("env_allow pattern %q: only a trailing '*' is supported", p)
		}
	}
	switch {
	case c.RetentionDays < 0:
		return errors.New("retention_days must not be negative")
	case c.DefaultIdleTTLSec < 0:
		return errors.New("default_idle_ttl_sec must not be negative")
	case c.MaxActiveRuns < 1:
		return errors.New("max_active_runs must be at least 1")
	case c.MaxLogBytes < 1<<10:
		return errors.New("max_log_bytes must be at least 1024")
	case c.MaxLineBytes < 1<<10:
		return errors.New("max_line_bytes must be at least 1024")
	case c.MaxStderrBytes < 1<<10:
		return errors.New("max_stderr_bytes must be at least 1024")
	}
	return nil
}

var envKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// EnvAllowed reports whether a client may set the environment variable key.
func (c Config) EnvAllowed(key string) bool {
	if !envKey.MatchString(key) {
		return false
	}
	for _, p := range c.EnvAllow {
		if prefix, ok := strings.CutSuffix(p, "*"); ok {
			if strings.HasPrefix(key, prefix) {
				return true
			}
		} else if p == key {
			return true
		}
	}
	return false
}

// extraBinDirs are searched after PATH, relative to the home directory; apps started from a menu often lack them.
var extraBinDirs = []string{".local/bin", ".npm-global/bin", "bin", ".local/share/mise/shims"}

// ResolveProgram maps a program name to an executable. When Programs is not empty it is a strict allowlist;
// otherwise the name is looked up in PATH and the usual per-user bin directories.
func (c Config) ResolveProgram(name string) (string, error) {
	if name == "" || strings.ContainsRune(name, '/') {
		return "", fmt.Errorf("program %q must be a plain name, not a path", name)
	}
	if len(c.Programs) > 0 {
		path, ok := c.Programs[name]
		if !ok {
			return "", fmt.Errorf("program %q is not in the configured programs", name)
		}
		if !isExecutable(path) {
			return "", fmt.Errorf("program %q: %s is not an executable file", name, path)
		}
		return path, nil
	}
	dirs := filepath.SplitList(os.Getenv("PATH"))
	if home, err := os.UserHomeDir(); err == nil {
		for _, d := range extraBinDirs {
			dirs = append(dirs, filepath.Join(home, d))
		}
	}
	for _, d := range dirs {
		if d == "" || !filepath.IsAbs(d) {
			continue
		}
		if p := filepath.Join(d, name); isExecutable(p) {
			return p, nil
		}
	}
	return "", fmt.Errorf("program %q was not found in PATH or the per-user bin directories", name)
}

func isExecutable(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular() && st.Mode().Perm()&0o111 != 0
}

// ResolveCwd checks that cwd is an absolute, existing directory inside one of the roots (after resolving
// symlinks) and returns the resolved path.
func (c Config) ResolveCwd(cwd string) (string, error) {
	if !filepath.IsAbs(cwd) {
		return "", errors.New("cwd must be an absolute path")
	}
	real, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return "", fmt.Errorf("cwd: %w", err)
	}
	st, err := os.Stat(real)
	if err != nil || !st.IsDir() {
		return "", errors.New("cwd is not a directory")
	}
	for _, root := range c.Roots {
		r, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		if real == r || strings.HasPrefix(real, strings.TrimRight(r, "/")+"/") {
			return real, nil
		}
	}
	return "", errors.New("cwd is not inside a configured root")
}
