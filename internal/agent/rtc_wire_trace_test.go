package agent

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"strings"
	"testing"
	"workdeck/internal/protocol"
)

func testSTUN(typ uint16, id byte, username bool) []byte {
	n := 20
	if username {
		n += 8
	}
	b := make([]byte, n)
	binary.BigEndian.PutUint16(b, typ)
	binary.BigEndian.PutUint16(b[2:], uint16(n-20))
	binary.BigEndian.PutUint32(b[4:], 0x2112a442)
	for i := 8; i < 20; i++ {
		b[i] = id
	}
	if username {
		binary.BigEndian.PutUint16(b[20:], 6)
		binary.BigEndian.PutUint16(b[22:], 4)
		copy(b[24:], "hide")
	}
	return b
}
func TestICEWireTraceCountsOnlyMatchingICETransactions(t *testing.T) {
	trace := &iceWireTrace{}
	trace.observe(testSTUN(1, 1, true), true, nil)
	trace.observe(testSTUN(0x101, 1, false), false, nil)
	trace.observe(testSTUN(1, 2, true), false, nil)
	trace.observe(testSTUN(0x101, 2, false), true, nil)
	trace.observe(testSTUN(1, 3, false), true, nil)
	trace.observe(testSTUN(0x101, 3, false), false, nil)
	trace.observe(testSTUN(1, 4, true), true, errors.New("private-address"))
	trace.observe([]byte("private packet content"), false, nil)
	s := trace.snapshot()
	if s.Sent != 1 || s.Received != 1 || s.SuccessSent != 1 || s.SuccessReceived != 1 || s.WriteErrors != 1 {
		t.Fatalf("incorrect counts: %+v", s)
	}
	data, _ := json.Marshal(s)
	for _, v := range []string{"hide", "private", "address"} {
		if strings.Contains(string(data), v) {
			t.Fatal("wire summary leaked packet content")
		}
	}
}

func TestRTCTraceRequiresUnexpiredMarkerAndStoresNumericDataOnly(t *testing.T) {
	dir := t.TempDir()
	if openRTCTrace(dir) != nil {
		t.Fatal("trace enabled without marker")
	}
	marker := filepath.Join(dir, ".ice-trace-until")
	if err := os.WriteFile(marker, []byte(strconv.FormatInt(time.Now().Add(5*time.Minute).Unix(), 10)), 0600); err != nil {
		t.Fatal(err)
	}
	sink := openRTCTrace(dir)
	if sink == nil {
		t.Fatal("valid trace marker rejected")
	}
	var browser protocol.RTCBrowserTrace
	if err := json.Unmarshal([]byte(`{"elapsedMs":123,"requestsSent":9,"address":"192.0.2.19","credential":"private"}`), &browser); err != nil {
		t.Fatal(err)
	}
	sink.write("browser", &browser, nil)
	name := sink.file.Name()
	sink.close()
	info, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("unexpected mode %v", info.Mode())
	}
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"requestsSent":9`) {
		t.Fatal("missing safe counters")
	}
	if strings.Contains(string(data), "192.0.2") || strings.Contains(string(data), "private") {
		t.Fatal("trace leaked untrusted browser fields")
	}
	if err := os.WriteFile(marker, []byte("0"), 0600); err != nil {
		t.Fatal(err)
	}
	if openRTCTrace(dir) != nil {
		t.Fatal("expired marker accepted")
	}
}
