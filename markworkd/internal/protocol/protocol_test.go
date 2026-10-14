package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/EkaPutCom/markwork/markworkd/internal/model"
)

func TestEncodeResponseMergesResult(t *testing.T) {
	b, err := EncodeResponse("7", WriteResult{Seq: 5})
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"re":"7","ok":true,"seq":5}` {
		t.Fatalf("got %s", b)
	}
	b, _ = EncodeResponse("8", nil)
	if string(b) != `{"re":"8","ok":true}` {
		t.Fatalf("got %s", b)
	}
	b, _ = EncodeResponse("9", struct{}{})
	if string(b) != `{"re":"9","ok":true}` {
		t.Fatalf("got %s", b)
	}
	if _, err := EncodeResponse("1", []int{1}); err == nil {
		t.Fatal("a non-object result must be rejected")
	}
}

func TestEncodeError(t *testing.T) {
	b := EncodeError("3", model.Errf(model.CodeNotFound, "no run %q", "x"))
	var got struct {
		Re    string
		OK    bool
		Error model.Error
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got.Re != "3" || got.OK || got.Error.Code != "not_found" || !strings.Contains(got.Error.Message, "x") {
		t.Fatalf("got %+v", got)
	}
}

func TestRecordEventFlattensRecord(t *testing.T) {
	b, _ := json.Marshal(RecordEvent{Ev: EvRecord, Run: "r", Record: model.Record{Seq: 2, TS: 9, Kind: model.KindOut, Line: "x"}})
	if string(b) != `{"ev":"record","run":"r","seq":2,"ts":9,"kind":"out","line":"x"}` {
		t.Fatalf("got %s", b)
	}
}

func TestDecoderFramesAndLimits(t *testing.T) {
	d := NewDecoder(strings.NewReader("{\"a\":1}\n\n  \n{\"b\":2}\r\n{\"c\":3}"), 100)
	for _, want := range []string{`{"a":1}`, `{"b":2}`, `{"c":3}`} {
		got, err := d.Next()
		if err != nil || string(got) != want {
			t.Fatalf("got %q, %v; want %q", got, err, want)
		}
	}
	if _, err := d.Next(); err == nil {
		t.Fatal("expected EOF")
	}

	d = NewDecoder(strings.NewReader(strings.Repeat("x", 200)+"\n"), 100)
	if _, err := d.Next(); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("got %v, want ErrFrameTooLarge", err)
	}

	big := strings.Repeat("y", 200000)
	d = NewDecoder(strings.NewReader(big+"\nnext\n"), 1<<20)
	got, err := d.Next()
	if err != nil || len(got) != len(big) {
		t.Fatalf("long frame: len %d, %v", len(got), err)
	}
}

func TestEncoderWritesOneLine(t *testing.T) {
	var buf bytes.Buffer
	e := NewEncoder(&buf)
	if err := e.SendValue(map[string]int{"a": 1}); err != nil {
		t.Fatal(err)
	}
	if buf.String() != "{\"a\":1}\n" {
		t.Fatalf("got %q", buf.String())
	}
}
