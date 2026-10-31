package agent

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"workdeck/internal/fileprotocol"
)

func TestFileRateConfiguration(t *testing.T) {
	for _, tc := range []struct {
		input string
		want  int
		valid bool
	}{
		{"", defaultFileRate, true},
		{strconv.Itoa(minFileRate), minFileRate, true},
		{strconv.Itoa(maxFileRate), maxFileRate, true},
		{"0", 0, false},
		{"262143", 0, false},
		{"1073741825", 0, false},
		{"1MiB", 0, false},
		{"-1", 0, false},
	} {
		got, err := configuredFileRate(tc.input)
		if (err == nil) != tc.valid || (tc.valid && got != tc.want) {
			t.Fatalf("configuredFileRate(%q) = %d, %v", tc.input, got, err)
		}
	}
}

func TestFileRateIsSharedPerAccountAndCancelable(t *testing.T) {
	a := &Agent{fileRateBytes: minFileRate}
	first := &fileWorkerClient{fileLimiter: a.fileLimiter("1001")}
	second := &fileWorkerClient{fileLimiter: a.fileLimiter("1001")}
	other := &fileWorkerClient{fileLimiter: a.fileLimiter("1002")}
	if first.fileLimiter != second.fileLimiter || first.fileLimiter == other.fileLimiter {
		t.Fatal("connections do not share an account-specific limiter")
	}
	ctx := context.Background()
	// Both directions consume the same shared bucket.
	if err := first.waitFileBytes(ctx, fileprotocol.MaxChunk); err != nil {
		t.Fatal(err)
	}
	if err := second.waitFileBytes(ctx, fileprotocol.MaxChunk); err != nil {
		t.Fatal(err)
	}
	if err := other.waitFileBytes(ctx, fileprotocol.MaxChunk); err != nil {
		t.Fatal(err)
	}
	short, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	err := second.waitFileBytes(short, fileprotocol.MaxChunk)
	if err == nil || time.Since(start) > 100*time.Millisecond {
		t.Fatalf("blocked request was not bounded by its context: %v", err)
	}
	start = time.Now()
	if err := second.waitFileBytes(ctx, fileprotocol.MaxChunk); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed < 70*time.Millisecond {
		t.Fatalf("same-account connections exceeded the aggregate limit: %v", elapsed)
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	if err := first.waitFileBytes(canceled, fileprotocol.MaxChunk); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled link continued waiting: %v", err)
	}
}
