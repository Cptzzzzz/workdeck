package hub

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type testBrowser interface {
	ReadJSON(any) error
	WriteJSON(any) error
	ReadMessage() (int, []byte, error)
	Close() error
}
type testHTTPBrowser struct {
	x        *testHub
	t        *testing.T
	response *http.Response
	reader   *bufio.Scanner
	id       string
}

func (x *testHub) dialHTTPBrowser(t *testing.T, path string) *testHTTPBrowser {
	t.Helper()
	req, _ := http.NewRequest("GET", x.s.URL+path, nil)
	req.Header.Set("Origin", x.s.URL)
	req.Header.Set("X-Workdeck-CSRF", x.csrf)
	res, e := x.client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	if res.StatusCode != 200 {
		res.Body.Close()
		t.Fatal("stream GET", res.StatusCode)
	}
	b := &testHTTPBrowser{x: x, t: t, response: res, reader: bufio.NewScanner(res.Body), id: res.Header.Get("X-Workdeck-Stream")}
	b.reader.Buffer(make([]byte, 4096), 2<<20)
	primed := make(chan bool, 1)
	go func() { primed <- b.reader.Scan() && b.reader.Text() == ": connected" }()
	select {
	case ok := <-primed:
		if !ok {
			res.Body.Close()
			t.Fatal("stream lacks initial body chunk")
		}
	case <-time.After(2 * time.Second):
		res.Body.Close()
		t.Fatal("stream did not prime proxy before terminal selection")
	}

	t.Cleanup(func() { b.Close() })
	return b
}
func (b *testHTTPBrowser) Close() error { return b.response.Body.Close() }
func (b *testHTTPBrowser) ReadMessage() (int, []byte, error) {
	for b.reader.Scan() {
		l := b.reader.Text()
		if !strings.HasPrefix(l, "data: ") {
			continue
		}
		var p streamPacket
		if e := json.Unmarshal([]byte(l[6:]), &p); e != nil {
			return 0, nil, e
		}
		if p.Kind == 0 {
			continue
		}
		return p.Kind, p.Data, nil
	}
	return 0, nil, io.EOF
}
func (b *testHTTPBrowser) ReadJSON(v any) error {
	_, data, e := b.ReadMessage()
	if e != nil {
		return e
	}
	return json.Unmarshal(data, v)
}
func (b *testHTTPBrowser) WriteJSON(v any) error {
	data, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return b.send(1, data)
}
func (b *testHTTPBrowser) send(kind int, data []byte) error {
	code, _ := b.x.request(b.t, "POST", "/api/terminal-streams/"+b.id+"/input", map[string]any{"packets": []streamPacket{{kind, data}}}, true)
	if code != 200 {
		return fmt.Errorf("stream input status %d", code)
	}
	return nil
}

func TestHTTPStreamRequiresAuthenticationAndCSRF(t *testing.T) {
	x := setup(t)
	path := "/api/terminals/" + randomID() + "/stream"
	req, _ := http.NewRequest("GET", x.s.URL+path, nil)
	res, e := x.client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatal(res.StatusCode)
	}
	x.signIn(t)
	req, _ = http.NewRequest("GET", x.s.URL+path, nil)
	req.Header.Set("Origin", x.s.URL)
	res, e = x.client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal(res.StatusCode)
	}
	if code, _ := x.request(t, "POST", "/api/terminal-streams/"+randomID()+"/input", map[string]any{}, false); code != 403 {
		t.Fatal(code)
	}
}
