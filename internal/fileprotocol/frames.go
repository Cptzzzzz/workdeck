// Package fileprotocol defines bounded wire frames for workspace file traffic.
// It is independent of the terminal transport and carries no authorization.
package fileprotocol

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
)

const (
	Version       = 1
	HeaderSize    = 48
	MaxChunk      = 32 << 10
	MaxControl    = 32 << 10
	UploadChunk   = 1
	DownloadChunk = 2
)

var ErrFrame = errors.New("invalid file protocol frame")
var magic = [4]byte{'W', 'D', 'F', '1'}

type Envelope struct {
	Version      int             `json:"version"`
	Type         string          `json:"type"`
	RequestID    string          `json:"request_id"`
	WorkspaceID  string          `json:"workspace_id"`
	RootRevision int64           `json:"root_revision"`
	RouteEpoch   uint32          `json:"route_epoch"`
	Payload      json.RawMessage `json:"payload,omitempty"`
}

func validID(id string) bool {
	if len(id) != 48 {
		return false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func (e Envelope) Validate() error {
	if e.Version != Version || !validID(e.RequestID) || !validID(e.WorkspaceID) || e.RootRevision < 1 || e.RouteEpoch < 1 || len(e.Type) < 1 || len(e.Type) > 64 {
		return ErrFrame
	}
	for _, c := range e.Type {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '_') {
			return ErrFrame
		}
	}
	if len(e.Payload) > 0 && !json.Valid(e.Payload) {
		return ErrFrame
	}
	return nil
}

func DecodeControl(data []byte) (Envelope, error) {
	var e Envelope
	if len(data) == 0 || len(data) > MaxControl {
		return e, ErrFrame
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&e) != nil {
		return Envelope{}, ErrFrame
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return Envelope{}, ErrFrame
	}
	if err := e.Validate(); err != nil {
		return Envelope{}, err
	}
	return e, nil
}

func EncodeControl(e Envelope) ([]byte, error) {
	if err := e.Validate(); err != nil {
		return nil, err
	}
	data, err := json.Marshal(e)
	if err != nil || len(data) > MaxControl {
		return nil, ErrFrame
	}
	return data, nil
}

type Chunk struct {
	Kind       byte
	RequestID  string
	Offset     int64
	RouteEpoch uint32
	Data       []byte
}

// The 48-byte network-order header is: magic (4), version (1), kind (1),
// reserved flags (2), request ID (24), offset (8), payload size (4), epoch (4).
func EncodeChunk(c Chunk) ([]byte, error) {
	if (c.Kind != UploadChunk && c.Kind != DownloadChunk) || !validID(c.RequestID) || c.Offset < 0 || c.RouteEpoch == 0 || len(c.Data) == 0 || len(c.Data) > MaxChunk || c.Offset > math.MaxInt64-int64(len(c.Data)) {
		return nil, ErrFrame
	}
	out := make([]byte, HeaderSize+len(c.Data))
	copy(out, magic[:])
	out[4] = Version
	out[5] = c.Kind
	id, err := hex.DecodeString(c.RequestID)
	if err != nil {
		return nil, ErrFrame
	}
	copy(out[8:32], id)
	binary.BigEndian.PutUint64(out[32:40], uint64(c.Offset))
	binary.BigEndian.PutUint32(out[40:44], uint32(len(c.Data)))
	binary.BigEndian.PutUint32(out[44:48], c.RouteEpoch)
	copy(out[48:], c.Data)
	return out, nil
}

// DecodeChunk validates direction, exact length and bounds before exposing data.
// The returned slice aliases the input; callers must copy before reusing it.
func DecodeChunk(data []byte, expectedKind byte) (Chunk, error) {
	if len(data) < HeaderSize || len(data) > HeaderSize+MaxChunk || !bytes.Equal(data[:4], magic[:]) || data[4] != Version || data[5] != expectedKind || (expectedKind != UploadChunk && expectedKind != DownloadChunk) || data[6] != 0 || data[7] != 0 {
		return Chunk{}, ErrFrame
	}
	size := binary.BigEndian.Uint32(data[40:44])
	epoch := binary.BigEndian.Uint32(data[44:48])
	offset := binary.BigEndian.Uint64(data[32:40])
	if size == 0 || size > MaxChunk || int(size) != len(data)-HeaderSize || epoch == 0 || offset > math.MaxInt64 || offset+uint64(size) > math.MaxInt64 {
		return Chunk{}, ErrFrame
	}
	return Chunk{Kind: expectedKind, RequestID: hex.EncodeToString(data[8:32]), Offset: int64(offset), RouteEpoch: epoch, Data: data[48:]}, nil
}
