package fileprotocol

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestControlEnvelopeBoundsAndScope(t *testing.T) {
	id := strings.Repeat("ab", 24)
	valid := Envelope{Version: Version, Type: "file.write.begin", RequestID: id, WorkspaceID: id, RootRevision: 1, RouteEpoch: 1, Payload: json.RawMessage(`{"path":"main.go"}`)}
	data, err := EncodeControl(valid)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeControl(data)
	if err != nil || decoded.RequestID != id || decoded.RouteEpoch != 1 {
		t.Fatal(decoded, err)
	}
	cases := []string{
		strings.Replace(string(data), `"version":1`, `"version":2`, 1),
		strings.Replace(string(data), `"root_revision":1`, `"root_revision":0`, 1),
		strings.Replace(string(data), `"route_epoch":1`, `"route_epoch":0`, 1),
		strings.Replace(string(data), id, strings.Repeat("A", 48), 1),
		strings.TrimSuffix(string(data), "}") + `,"unknown":1}`,
		string(data) + ` {}`,
		strings.Repeat(" ", MaxControl+1),
	}
	for _, value := range cases {
		if _, err := DecodeControl([]byte(value)); err == nil {
			t.Fatalf("accepted invalid control: %.100q", value)
		}
	}
}

func TestChunkDirectionBoundariesAndMalformedFrames(t *testing.T) {
	id := strings.Repeat("12", 24)
	original := Chunk{Kind: UploadChunk, RequestID: id, Offset: 123, RouteEpoch: 42, Data: bytes.Repeat([]byte{0x5a}, MaxChunk)}
	data, err := EncodeChunk(original)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeChunk(data, UploadChunk)
	if err != nil || decoded.RequestID != id || decoded.Offset != 123 || decoded.RouteEpoch != 42 || !bytes.Equal(decoded.Data, original.Data) {
		t.Fatal(decoded, err)
	}
	if _, err = DecodeChunk(data, DownloadChunk); err == nil {
		t.Fatal("accepted wrong direction")
	}
	bad := func(mutate func([]byte)) {
		t.Helper()
		clone := bytes.Clone(data)
		mutate(clone)
		if _, err := DecodeChunk(clone, UploadChunk); err == nil {
			t.Fatal("accepted corrupt frame")
		}
	}
	bad(func(b []byte) { b[0] ^= 1 })
	bad(func(b []byte) { b[4]++ })
	bad(func(b []byte) { b[7] = 1 })
	bad(func(b []byte) { binary.BigEndian.PutUint32(b[40:44], 0) })
	bad(func(b []byte) { binary.BigEndian.PutUint32(b[40:44], MaxChunk+1) })
	bad(func(b []byte) { binary.BigEndian.PutUint32(b[44:48], 0) })
	bad(func(b []byte) { binary.BigEndian.PutUint64(b[32:40], math.MaxInt64) })
	if _, err = DecodeChunk(data[:len(data)-1], UploadChunk); err == nil {
		t.Fatal("accepted truncated frame")
	}
	original.Offset = math.MaxInt64
	if _, err = EncodeChunk(original); err == nil {
		t.Fatal("accepted offset overflow")
	}
	original.Offset = 0
	original.Data = nil
	if _, err = EncodeChunk(original); err == nil {
		t.Fatal("accepted empty chunk")
	}
}

func FuzzDecodeChunk(f *testing.F) {
	encoded, _ := EncodeChunk(Chunk{Kind: UploadChunk, RequestID: strings.Repeat("11", 24), RouteEpoch: 1, Data: []byte("hello")})
	f.Add(encoded)
	f.Add([]byte{})
	f.Fuzz(func(t *testing.T, data []byte) {
		c, err := DecodeChunk(data, UploadChunk)
		if err == nil {
			b, e := EncodeChunk(c)
			if e != nil || !bytes.Equal(b, data) {
				t.Fatal("invalid round trip", e)
			}
		}
	})
}
