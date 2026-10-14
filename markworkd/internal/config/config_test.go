package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadMissingFileGivesDefaults(t *testing.T) {
	c, err := Load(filepath.Join(t.TempDir(), "nope.json"))
	if err != nil || c.RetentionDays != 14 || c.DefaultIdleTTLSec != 86400 || len(c.Roots) != 0 {
		t.Fatalf("got %+v, %v", c, err)
	}
}

func TestLoadKeepsDefaultsForMissingKeysAndRejectsUnknown(t *testing.T) {
	dir := t.TempDir()
	c, err := Load(write(t, dir, "a.json", `{"roots":["/srv/p"],"max_active_runs":3}`))
	if err != nil || c.MaxActiveRuns != 3 || c.RetentionDays != 14 || c.Roots[0] != "/srv/p" {
		t.Fatalf("got %+v, %v", c, err)
	}
	if _, err := Load(write(t, dir, "b.json", `{"max_active_run":3}`)); err == nil {
		t.Fatal("an unknown key must be rejected")
	}
	if _, err := Load(write(t, dir, "c.json", `{"roots":["relative"]}`)); err == nil {
		t.Fatal("a relative root must be rejected")
	}
	if _, err := Load(write(t, dir, "d.json", `{"env_allow":["A*B"]}`)); err == nil {
		t.Fatal("a wildcard in the middle must be rejected")
	}
	if c, err := Load(write(t, dir, "f.json", `{"agent_env":{"PATH":"/a:/b"}}`)); err != nil || c.AgentEnv["PATH"] != "/a:/b" {
		t.Fatalf("agent_env: %+v, %v", c, err)
	}
	if _, err := Load(write(t, dir, "g.json", `{"agent_env":{"BAD KEY":"x"}}`)); err == nil {
		t.Fatal("an invalid agent_env key must be rejected")
	}
	if _, err := Load(write(t, dir, "e.json", `{"max_active_runs":0}`)); err == nil {
		t.Fatal("max_active_runs 0 must be rejected")
	}
}

func TestEnvAllowed(t *testing.T) {
	c := Config{EnvAllow: []string{"PI_*", "HOME_DIR"}}
	for key, want := range map[string]bool{"PI_X": true, "PI_": true, "HOME_DIR": true, "HOME": false, "PATH": false, "PI X": false, "": false} {
		if got := c.EnvAllowed(key); got != want {
			t.Errorf("EnvAllowed(%q) = %v, want %v", key, got, want)
		}
	}
	if (Config{}).EnvAllowed("ANY") {
		t.Error("an empty allowlist must allow nothing")
	}
}

func TestResolveCwd(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "proj")
	outside := t.TempDir()
	for _, d := range []string{inside} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	// A sibling whose name starts with the root's name must not match by prefix.
	sibling := root + "-other"
	if err := os.Mkdir(sibling, 0o755); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(sibling)

	c := Config{Roots: []string{root}}
	if got, err := c.ResolveCwd(inside); err != nil || !strings.HasSuffix(got, "proj") {
		t.Fatalf("inside: %q, %v", got, err)
	}
	if _, err := c.ResolveCwd(root); err != nil {
		t.Fatalf("the root itself must be allowed: %v", err)
	}
	for name, path := range map[string]string{
		"symlink escape": filepath.Join(root, "escape"),
		"outside":        outside,
		"sibling prefix": sibling,
		"relative":       "proj",
		"missing":        filepath.Join(root, "nope"),
	} {
		if _, err := c.ResolveCwd(path); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	if _, err := (Config{}).ResolveCwd(inside); err == nil {
		t.Error("no roots must refuse everything")
	}
}

func TestResolveProgram(t *testing.T) {
	dir := t.TempDir()
	exe := write(t, dir, "tool", "#!/bin/sh\n")
	if err := os.Chmod(exe, 0o755); err != nil {
		t.Fatal(err)
	}
	plain := write(t, dir, "plain", "x")

	t.Setenv("PATH", dir)
	c := Config{}
	if got, err := c.ResolveProgram("tool"); err != nil || got != exe {
		t.Fatalf("PATH lookup: %q, %v", got, err)
	}
	if _, err := c.ResolveProgram("plain"); err == nil {
		t.Fatal("a non-executable file must not resolve")
	}
	if _, err := c.ResolveProgram("../tool"); err == nil {
		t.Fatal("a path must be rejected")
	}

	strict := Config{Programs: map[string]string{"pi": exe, "bad": plain}}
	if got, err := strict.ResolveProgram("pi"); err != nil || got != exe {
		t.Fatalf("allowlist: %q, %v", got, err)
	}
	if _, err := strict.ResolveProgram("tool"); err == nil {
		t.Fatal("with an allowlist, PATH lookup must be refused")
	}
	if _, err := strict.ResolveProgram("bad"); err == nil {
		t.Fatal("a configured but non-executable program must be refused")
	}
}
