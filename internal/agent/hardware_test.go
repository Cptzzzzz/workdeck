package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func hardwareFixture(t *testing.T, root, path, text string) {
	t.Helper()
	p := filepath.Join(root, path)
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestHardwareCollectionUsesNonUniqueLinuxDescriptions(t *testing.T) {
	root := t.TempDir()
	proc := filepath.Join(root, "proc")
	sys := filepath.Join(root, "sys")
	hardwareFixture(t, proc, "cpuinfo", "processor: 0\nCPU implementer: 0x41\nCPU part: 0xd42\nSerial: private-secret\n")
	hardwareFixture(t, proc, "meminfo", "MemTotal:       16777216 kB\nMemAvailable: 1 kB\n")
	for _, c := range []struct{ name, pkg, core, online string }{{"cpu0", "0", "0", "1"}, {"cpu1", "0", "0", "1"}, {"cpu2", "0", "1", "1"}, {"cpu3", "0", "2", "0"}} {
		hardwareFixture(t, sys, "devices/system/cpu/"+c.name+"/topology/physical_package_id", c.pkg)
		hardwareFixture(t, sys, "devices/system/cpu/"+c.name+"/topology/core_id", c.core)
		hardwareFixture(t, sys, "devices/system/cpu/"+c.name+"/online", c.online)
	}
	// SMBIOS structure with manufacturer, serial, asset and part strings.
	// Serial/asset values must not enter the returned inventory.
	dmi := make([]byte, 0x20)
	dmi[0], dmi[1] = 17, 0x20
	dmi[0x0c], dmi[0x0d] = 0x00, 0x40 // 16 GiB, encoded in MiB.
	dmi[0x17], dmi[0x18], dmi[0x19], dmi[0x1a] = 1, 2, 3, 4
	dmi = append(dmi, []byte("Example Vendor\x00private-serial\x00private-asset\x00Example Part\x00\x00")...)
	dmiPath := filepath.Join(sys, "firmware/dmi/entries/17-0/raw")
	if err := os.MkdirAll(filepath.Dir(dmiPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dmiPath, dmi, 0600); err != nil {
		t.Fatal(err)
	}
	hardwareFixture(t, sys, "block/nvme0n1/device/model", "Example NVMe\n")
	hardwareFixture(t, sys, "block/nvme0n1/size", "2097152\n")
	hardwareFixture(t, sys, "block/nvme0n1/device/serial", "private-disk-serial\n")
	hardwareFixture(t, sys, "block/loop0/size", "1000\n")
	hardwareFixture(t, sys, "block/mmcblk0boot0/size", "1000\n")
	h := collectHardware(context.Background(), proc, sys)
	if h.CPUModel != "ARM Cortex-A78AE" || h.LogicalCPUs != 3 || h.PhysicalCores != 2 || h.MemoryBytes != 16*1024*1024*1024 {
		t.Fatalf("unexpected CPU or memory: %+v", h)
	}
	if len(h.MemoryModules) != 1 || h.MemoryModules[0].Vendor != "Example Vendor" || h.MemoryModules[0].Model != "Example Part" || h.MemoryModules[0].SizeBytes != 16*1024*1024*1024 {
		t.Fatalf("unexpected memory: %+v", h.MemoryModules)
	}
	encoded, _ := json.Marshal(h)
	if strings.Contains(string(encoded), "private-") {
		t.Fatal("hardware inventory leaked serial or asset data")
	}
	if len(h.Disks) != 1 || h.Disks[0].Model != "Example NVMe" || h.Disks[0].SizeBytes != 1024*1024*1024 {
		t.Fatalf("unexpected disks: %+v", h.Disks)
	}
}
func TestHardwareFallbacksDoNotInventValues(t *testing.T) {
	root := t.TempDir()
	h := collectHardware(context.Background(), filepath.Join(root, "proc"), filepath.Join(root, "sys"))
	if h.CPUModel != "" || h.MemoryBytes != 0 || len(h.Disks) != 0 || h.PhysicalCores != 0 {
		t.Fatalf("unexpected information: %+v", h)
	}
	if got := cpuModel("model name : Example CPU\n"); got != "Example CPU" {
		t.Fatal(got)
	}
}

func TestNvidiaHardwareReportsModelAndMemoryWithoutExtraFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nvidia-smi")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf 'Example GPU, 32607\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	g := nvidiaGPUs(context.Background())
	if len(g) != 1 || g[0].Model != "Example GPU" || g[0].MemoryBytes != 32607*1024*1024 {
		t.Fatalf("unexpected GPUs: %+v", g)
	}
}
