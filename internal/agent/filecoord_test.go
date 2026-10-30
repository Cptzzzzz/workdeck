package agent

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

// A fake pipe peer lets the test hold a worker request at its completion
// barrier while another account issues a request through the same Agent.
func fakeCoordinatedWorker(gate chan struct{}, started chan<- string, release <-chan struct{}) *fileWorkerClient {
	w := &fileWorkerClient{commitGate: gate, pending: map[string]chan workerResponse{}, writes: make(chan workerWrite, 8), stopping: make(chan struct{}), done: make(chan struct{})}
	go func() {
		for {
			select {
			case item := <-w.writes:
				var request struct {
					ID     string `json:"id"`
					Method string `json:"method"`
				}
				_ = json.Unmarshal(item.data, &request)
				item.done <- nil
				go func() {
					if request.Method == "write.commit" || request.Method == "entry.rename" || request.Method == "operation.status" {
						started <- request.Method
						select {
						case <-release:
						case <-w.done:
							return
						}
					}
					w.mu.Lock()
					response := w.pending[request.ID]
					w.mu.Unlock()
					if response != nil {
						response <- workerResponse{ID: request.ID}
					}
				}()
			case <-w.done:
				return
			}
		}
	}()
	return w
}

func TestFileCommitGateAcrossWorkers(t *testing.T) {
	a := &Agent{}
	if newFileWorkerPool(a).agent.commitGate() != newFileWorkerPool(a).agent.commitGate() {
		t.Fatal("reconnect created a different gate")
	}
	started := make(chan string, 4)
	release := make(chan struct{}, 4)
	w1 := fakeCoordinatedWorker(a.commitGate(), started, release)
	w2 := fakeCoordinatedWorker(a.commitGate(), started, release)
	defer close(w1.done)
	defer close(w2.done)
	result := make(chan error, 3)
	go func() { result <- w1.Call(context.Background(), "write.commit", "", 0, nil, nil) }()
	if got := <-started; got != "write.commit" {
		t.Fatal(got)
	}
	go func() { result <- w2.Call(context.Background(), "entry.rename", "", 0, nil, nil) }()
	select {
	case got := <-started:
		t.Fatalf("overlapping mutation: %s", got)
	case <-time.After(100 * time.Millisecond):
	}
	// Read operations bypass the gate even while a commit is held.
	readCtx, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	if err := w2.Call(readCtx, "read.open", "", 0, nil, nil); err != nil {
		t.Fatal(err)
	}
	waitCtx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := w2.Call(waitCtx, "operation.status", "", 0, nil, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	release <- struct{}{}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-started:
		if got != "entry.rename" {
			t.Fatal(got)
		}
	case <-time.After(time.Second):
		t.Fatal("second mutation remained blocked")
	}
	release <- struct{}{}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestFileCommitGateWaitsForStoppedWorker(t *testing.T) {
	gate := make(chan struct{}, 1)
	started := make(chan string, 2)
	release := make(chan struct{}, 1)
	w1 := fakeCoordinatedWorker(gate, started, release)
	w2 := fakeCoordinatedWorker(gate, started, release)
	var once sync.Once
	defer once.Do(func() { close(w1.done) })
	defer close(w2.done)
	first := make(chan error, 1)
	go func() { first <- w1.Call(context.Background(), "write.commit", "", 0, nil, nil) }()
	<-started
	close(w1.stopping)
	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	blocked, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := w2.Call(blocked, "entry.rename", "", 0, nil, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("released before worker exit: %v", err)
	}
	once.Do(func() { close(w1.done) })
	second := make(chan error, 1)
	go func() { second <- w2.Call(context.Background(), "entry.rename", "", 0, nil, nil) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("gate not released after worker exit")
	}
	release <- struct{}{}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
}
