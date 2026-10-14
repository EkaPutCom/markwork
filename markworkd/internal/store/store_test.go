package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/EkaPutCom/markwork/markworkd/internal/model"
)

func appendN(t *testing.T, l *Log, n int) {
	t.Helper()
	for i := 1; i <= n; i++ {
		if _, err := l.Append(model.KindOut, fmt.Sprintf("line %d", i), false, int64(i)); err != nil {
			t.Fatal(err)
		}
	}
}

func readAll(t *testing.T, l *Log, from uint64) []model.Record {
	t.Helper()
	c, err := l.Seek(from)
	if err != nil {
		t.Fatal(err)
	}
	var all []model.Record
	for {
		recs, err := l.Read(&c, 100)
		if err != nil {
			t.Fatal(err)
		}
		if len(recs) == 0 {
			return all
		}
		all = append(all, recs...)
	}
}

func TestMetaRoundTripAndAtomicReplace(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Create("r1"); err != nil {
		t.Fatal(err)
	}
	if err := s.Create("r1"); err == nil {
		t.Fatal("creating an existing run must fail")
	}
	if err := s.Create("../x"); err == nil {
		t.Fatal("an invalid run id must be refused")
	}
	m := &Meta{Spec: model.SpawnSpec{Run: "r1", Program: "pi", Args: []string{"a"}, Cwd: "/x"}, State: model.StateQueued, CreatedAt: 5}
	if err := s.SaveMeta("r1", m); err != nil {
		t.Fatal(err)
	}
	m.State = model.StateRunning
	if err := s.SaveMeta("r1", m); err != nil {
		t.Fatal(err)
	}
	got, err := s.LoadMeta("r1")
	if err != nil || got.State != model.StateRunning || got.Spec.Program != "pi" {
		t.Fatalf("got %+v, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(s.Root(), "runs", "r1", "meta.json.tmp")); err == nil {
		t.Fatal("the temp file must not remain")
	}
	if _, err := s.LoadMeta("nope"); !IsNotExist(err) {
		t.Fatalf("want not-exist, got %v", err)
	}
	ids, _ := s.RunIDs()
	if len(ids) != 1 || ids[0] != "r1" {
		t.Fatalf("ids %v", ids)
	}
	if err := s.Remove("r1"); err != nil {
		t.Fatal(err)
	}
	if ids, _ = s.RunIDs(); len(ids) != 0 {
		t.Fatalf("ids after remove %v", ids)
	}
}

func TestLogAppendReadAndSeek(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	l, err := OpenLog(path, false)
	if err != nil {
		t.Fatal(err)
	}
	const n = 1000 // several index spans
	appendN(t, l, n)
	if l.LastSeq() != n {
		t.Fatalf("last %d", l.LastSeq())
	}
	for _, from := range []uint64{0, 1, 2, 255, 256, 257, 258, 513, 999, 1000} {
		first := from
		if first == 0 {
			first = 1
		}
		recs := readAll(t, l, from)
		if uint64(len(recs)) != n-first+1 || recs[0].Seq != first || recs[len(recs)-1].Seq != n {
			t.Fatalf("from %d: got %d records starting at %v", from, len(recs), recs[0].Seq)
		}
		for i, r := range recs {
			if r.Seq != first+uint64(i) || r.Line != fmt.Sprintf("line %d", r.Seq) {
				t.Fatalf("from %d: record %d is %+v", from, i, r)
			}
		}
	}
	if recs := readAll(t, l, n+50); len(recs) != 0 {
		t.Fatalf("beyond the end must give no records, got %d", len(recs))
	}
	c, _ := l.Seek(n + 50)
	if c.Next != n+1 {
		t.Fatalf("cursor beyond the end should wait for record %d, got %d", n+1, c.Next)
	}
	if _, err := l.Append(model.KindExit, `{"reason":"exited"}`, false, 1); err != nil {
		t.Fatal(err)
	}
	if !l.Finished() {
		t.Fatal("exit record must finish the log")
	}
	if recs := readAll(t, l, c.Next); len(recs) != 1 || recs[0].Kind != model.KindExit {
		t.Fatalf("a reader waiting at the end must see the exit record, got %+v", recs)
	}
	if err := l.CloseWriter(); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Append(model.KindOut, "x", false, 1); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("append after close: %v", err)
	}
	if got := readAll(t, l, 1); len(got) != n+1 {
		t.Fatal("reading must keep working after the writer closed")
	}

	// Reopen: the scan rebuilds the index and the numbering.
	l2, err := OpenLog(path, true)
	if err != nil {
		t.Fatal(err)
	}
	if l2.LastSeq() != n+1 || !l2.Finished() {
		t.Fatalf("reopen: last %d finished %v", l2.LastSeq(), l2.Finished())
	}
	if recs := readAll(t, l2, 700); len(recs) != n+1-700+1 {
		t.Fatalf("reopen seek: %d", len(recs))
	}
}

func TestLogNotifyWakesOnAppend(t *testing.T) {
	l, _ := OpenLog(filepath.Join(t.TempDir(), "e.jsonl"), false)
	ch := l.Notify()
	select {
	case <-ch:
		t.Fatal("notified before an append")
	default:
	}
	go func() {
		time.Sleep(10 * time.Millisecond)
		l.Append(model.KindOut, "x", false, 1)
	}()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("not notified")
	}
	if ch2 := l.Notify(); ch2 == ch {
		t.Fatal("a fresh channel is expected after an append")
	}
}

// A crash can cut the last append at any byte. Recovery must keep every complete record and drop the rest,
// whatever the cut position.
func TestLogRecoveryFromEveryTruncationPoint(t *testing.T) {
	dir := t.TempDir()
	full := filepath.Join(dir, "full.jsonl")
	l, _ := OpenLog(full, false)
	appendN(t, l, 5)
	l.CloseWriter()
	data, _ := os.ReadFile(full)
	lines := strings.SplitAfter(string(data), "\n")
	lines = lines[:5]

	for cut := 0; cut <= len(data); cut++ {
		p := filepath.Join(dir, fmt.Sprintf("cut%d.jsonl", cut))
		os.WriteFile(p, data[:cut], 0o600)
		want := 0
		acc := 0
		for _, ln := range lines {
			if acc+len(ln) <= cut {
				acc += len(ln)
				want++
			}
		}
		rl, err := OpenLog(p, false)
		if err != nil {
			t.Fatalf("cut %d: %v", cut, err)
		}
		if int(rl.LastSeq()) != want {
			t.Fatalf("cut %d: last seq %d, want %d", cut, rl.LastSeq(), want)
		}
		if st, _ := os.Stat(p); st.Size() != int64(acc) {
			t.Fatalf("cut %d: file is %d bytes after recovery, want %d", cut, st.Size(), acc)
		}
		// Numbering continues without a gap.
		rec, err := rl.Append(model.KindOut, "after", false, 1)
		if err != nil || int(rec.Seq) != want+1 {
			t.Fatalf("cut %d: appended %+v, %v", cut, rec, err)
		}
		rl.CloseWriter()
	}
}

func TestLogCorruptionInTheMiddleIsAnError(t *testing.T) {
	p := filepath.Join(t.TempDir(), "e.jsonl")
	l, _ := OpenLog(p, false)
	appendN(t, l, 3)
	l.CloseWriter()
	data, _ := os.ReadFile(p)
	bad := strings.Replace(string(data), `"seq":2`, `"seq":9`, 1)
	os.WriteFile(p, []byte(bad), 0o600)
	if _, err := OpenLog(p, false); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("want ErrCorrupt, got %v", err)
	}
}

func TestLogKeepsLongAndTruncatedLines(t *testing.T) {
	l, _ := OpenLog(filepath.Join(t.TempDir(), "e.jsonl"), false)
	long := strings.Repeat("é", 300000)
	l.Append(model.KindOut, long, true, 1)
	recs := readAll(t, l, 1)
	if len(recs) != 1 || recs[0].Line != long || !recs[0].Truncated {
		t.Fatal("long line was not preserved")
	}
}

func TestStderrBoundedKeepsTheEnd(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "stderr.log")
	e, err := OpenStderr(p, 1024)
	if err != nil {
		t.Fatal(err)
	}
	var want strings.Builder
	for i := 0; i < 500; i++ {
		s := fmt.Sprintf("error number %04d\n", i)
		want.WriteString(s)
		if n, err := e.Write([]byte(s)); err != nil || n != len(s) {
			t.Fatalf("write: %d, %v", n, err)
		}
	}
	if e.Size() >= 2048 {
		t.Fatalf("file grew to %d bytes, want below 2048", e.Size())
	}
	text, partial, err := e.Tail(500)
	if err != nil || !partial {
		t.Fatalf("tail: partial=%v err=%v", partial, err)
	}
	if !strings.HasSuffix(want.String(), text) || !strings.HasSuffix(text, "error number 0499\n") || len(text) != 500 {
		t.Fatalf("tail is not the end of the output: %q", text)
	}
	// Asking for more than the cap gives at most the cap.
	if text, _, _ := e.Tail(1 << 20); len(text) > 1024 {
		t.Fatalf("tail longer than the cap: %d", len(text))
	}
	e.Close()
	if _, _, err := ReadTail(p, 10, true); err != nil {
		t.Fatal(err)
	}
}

func TestStderrTailIsCutAtACharacter(t *testing.T) {
	p := filepath.Join(t.TempDir(), "stderr.log")
	e, _ := OpenStderr(p, 1<<20)
	e.Write([]byte(strings.Repeat("é", 100))) // 2 bytes each
	text, partial, _ := e.Tail(51)            // would cut inside a character
	if !partial || strings.ContainsRune(text, '�') || len([]rune(text)) != 25 {
		t.Fatalf("got %q (%d runes)", text, len([]rune(text)))
	}
	if text, partial, _ := e.Tail(1000); partial || len([]rune(text)) != 100 {
		t.Fatalf("whole output expected, partial=%v len=%d", partial, len([]rune(text)))
	}
}
