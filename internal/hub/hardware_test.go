package hub

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workdeck/internal/protocol"
)

func TestHardwareInventoryPersistsAndOldAgentsDoNotEraseIt(t *testing.T) {
	x := setup(t)
	x.signIn(t)
	node := randomID()
	if _, err := x.h.store.db.Exec("INSERT INTO nodes(id,name,public_key) VALUES(?,?,?)", node, "hardware node", "key"); err != nil {
		t.Fatal(err)
	}
	hardware := &protocol.NodeHardware{CollectedAt: time.Now().UTC().Format(time.RFC3339), CPUModel: "Example CPU", LogicalCPUs: 8, PhysicalCores: 4, MemoryBytes: 16 << 30, MemoryModules: []protocol.HardwareMemory{{Vendor: "Example Vendor", Model: "Example DIMM", SizeBytes: 16 << 30}}, Disks: []protocol.HardwareDisk{{Name: "nvme0n1", Model: "Example Disk", SizeBytes: 1 << 40}}, GPUs: []protocol.HardwareGPU{{Model: "Example GPU", MemoryBytes: 8 << 30}}}
	x.h.applyInventory(node, protocol.Message{Hardware: hardware})
	x.h.applyInventory(node, protocol.Message{})
	code, state := x.request(t, "GET", "/api/state", nil, false)
	if code != 200 {
		t.Fatal(code)
	}
	nodes := state["nodes"].([]any)
	v := nodes[0].(map[string]any)["hardware"].(map[string]any)
	if v["cpu_model"] != "Example CPU" || int(v["logical_cpus"].(float64)) != 8 || len(v["memory_modules"].([]any)) != 1 || len(v["disks"].([]any)) != 1 || len(v["gpus"].([]any)) != 1 {
		t.Fatalf("unexpected hardware: %+v", v)
	}
	x.h.applyInventory(node, protocol.Message{Hardware: &protocol.NodeHardware{CollectedAt: "invalid", CPUModel: "bad"}})
	var stored string
	if err := x.h.store.db.QueryRow("SELECT hardware FROM nodes WHERE id=?", node).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	var decoded protocol.NodeHardware
	if err := json.Unmarshal([]byte(stored), &decoded); err != nil || decoded.CPUModel != "Example CPU" {
		t.Fatalf("invalid inventory replaced hardware: %s %v", stored, err)
	}
	// A fresh Hub opens the same database with the last known hardware intact.
	cfg := x.h.cfg
	if err := x.h.store.db.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.store.db.Close()
	var after string
	if err := restarted.store.db.QueryRow("SELECT hardware FROM nodes WHERE id=?", node).Scan(&after); err != nil || after != stored {
		t.Fatalf("hardware inventory was not retained after restart: %v", err)
	}
}
func TestHardwareSummarySanitizesUntrustedValues(t *testing.T) {
	h := &protocol.NodeHardware{CollectedAt: time.Now().UTC().Format(time.RFC3339), CPUModel: "CPU\nname", Disks: []protocol.HardwareDisk{{Name: "../../secret", Model: "bad"}, {Name: "nvme0n1", Model: "disk\x00name"}}, GPUs: []protocol.HardwareGPU{{Model: strings.Repeat("x", 300)}}}
	n := cleanHardware(h)
	if n == nil || n.CPUModel != "CPUname" || len(n.Disks) != 1 || n.Disks[0].Name != "nvme0n1" || n.Disks[0].Model != "diskname" || len(n.GPUs[0].Model) != 160 {
		t.Fatalf("not sanitized: %+v", n)
	}
}

func TestLegacyNodeDatabaseMigratesHardwareWithoutLosingIdentity(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "workdeck.db"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,name TEXT NOT NULL,public_key TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,last_seen TEXT NOT NULL DEFAULT '',hostname TEXT NOT NULL DEFAULT '',platform TEXT NOT NULL DEFAULT '',home TEXT NOT NULL DEFAULT '',shell TEXT NOT NULL DEFAULT '',version TEXT NOT NULL DEFAULT ''); INSERT INTO nodes(id,name,public_key) VALUES('node-legacy','legacy','public');`)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	password := filepath.Join(dir, "password")
	if err = os.WriteFile(password, []byte("example123"), 0600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(dir, "admin", password)
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	var name, hardware string
	if err = store.db.QueryRow("SELECT name,hardware FROM nodes WHERE id=?", "node-legacy").Scan(&name, &hardware); err != nil || name != "legacy" || hardware != "" {
		t.Fatalf("legacy node not preserved: %q %q %v", name, hardware, err)
	}
}
