package agent

import (
	"bufio"
	"context"
	"encoding/binary"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"workdeck/internal/protocol"
)

const hardwareRefreshInterval = 5 * time.Minute

func (a *Agent) hardwareSnapshot() *protocol.NodeHardware {
	a.hardwareMu.RLock()
	defer a.hardwareMu.RUnlock()
	return a.hardware
}
func (a *Agent) hardwareLoop(ctx context.Context) {
	refresh := func() {
		h := collectHardware(ctx, "/proc", "/sys")
		a.hardwareMu.Lock()
		a.hardware = h
		a.hardwareMu.Unlock()
	}
	refresh()
	ticker := time.NewTicker(hardwareRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refresh()
		}
	}
}
func readText(path string) string {
	b, e := os.ReadFile(path)
	if e != nil {
		return ""
	}
	return cleanHardwareText(string(b))
}
func cleanHardwareText(s string) string {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r == 0 || unicode.IsControl(r) {
			return -1
		}
		return r
	}, s))
	r := []rune(s)
	if len(r) > 160 {
		s = string(r[:160])
	}
	return s
}
func cpuModel(cpuInfo string) string {
	models := []string{}
	for _, block := range strings.Split(cpuInfo, "\n\n") {
		model := cpuBlockModel(block)
		if model == "" {
			continue
		}
		found := false
		for _, existing := range models {
			if existing == model {
				found = true
				break
			}
		}
		if !found {
			models = append(models, model)
		}
		if len(models) >= 4 {
			break
		}
	}
	return cleanHardwareText(strings.Join(models, " / "))
}
func cpuBlockModel(cpuInfo string) string {
	fields := map[string]string{}
	for _, line := range strings.Split(cpuInfo, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = cleanHardwareText(value)
		if value != "" && fields[key] == "" {
			fields[key] = value
		}
	}
	for _, key := range []string{"model name", "Processor", "cpu model"} {
		if v := fields[key]; v != "" {
			return v
		}
	}
	// Linux arm64 exposes MIDR implementer/part instead of a product string.
	if strings.EqualFold(fields["CPU implementer"], "0x41") {
		names := map[string]string{"0xd03": "ARM Cortex-A53", "0xd05": "ARM Cortex-A55", "0xd07": "ARM Cortex-A57", "0xd08": "ARM Cortex-A72", "0xd09": "ARM Cortex-A73", "0xd0a": "ARM Cortex-A75", "0xd0b": "ARM Cortex-A76", "0xd0c": "ARM Neoverse N1", "0xd0d": "ARM Cortex-A77", "0xd40": "ARM Neoverse V1", "0xd41": "ARM Cortex-A78", "0xd42": "ARM Cortex-A78AE", "0xd46": "ARM Cortex-A510", "0xd47": "ARM Cortex-A710", "0xd49": "ARM Neoverse N2"}
		if v := names[strings.ToLower(fields["CPU part"])]; v != "" {
			return v
		}
	}
	return ""
}
func cpuCounts(sys string) (int, int) {
	entries, err := os.ReadDir(filepath.Join(sys, "devices/system/cpu"))
	if err != nil {
		return 0, 0
	}
	logical := 0
	cores := map[string]bool{}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "cpu") || len(name) <= 3 {
			continue
		}
		if _, err := strconv.Atoi(name[3:]); err != nil {
			continue
		}
		base := filepath.Join(sys, "devices/system/cpu", name)
		if readText(filepath.Join(base, "online")) == "0" {
			continue
		}
		logical++
		pkg := readText(filepath.Join(base, "topology/physical_package_id"))
		core := readText(filepath.Join(base, "topology/core_id"))
		if pkg != "" && core != "" && pkg != "-1" && core != "-1" {
			cores[pkg+":"+core] = true
		}
	}
	// Report physical cores only when topology is available for every CPU.
	if logical == 0 {
		return 0, 0
	}
	valid := true
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "cpu") || len(name) <= 3 {
			continue
		}
		if _, err := strconv.Atoi(name[3:]); err != nil {
			continue
		}
		base := filepath.Join(sys, "devices/system/cpu", name)
		if readText(filepath.Join(base, "online")) == "0" {
			continue
		}
		pkg := readText(filepath.Join(base, "topology/physical_package_id"))
		core := readText(filepath.Join(base, "topology/core_id"))
		if pkg == "" || core == "" || pkg == "-1" || core == "-1" {
			valid = false
			break
		}
	}
	if !valid {
		return logical, 0
	}
	return logical, len(cores)
}
func memoryTotal(memInfo string) uint64 {
	scanner := bufio.NewScanner(strings.NewReader(memInfo))
	for scanner.Scan() {
		f := strings.Fields(scanner.Text())
		if len(f) >= 3 && f[0] == "MemTotal:" && f[2] == "kB" {
			n, e := strconv.ParseUint(f[1], 10, 64)
			if e == nil && n <= math.MaxUint64/1024 {
				return n * 1024
			}
		}
	}
	return 0
}

// readMemoryModule reads only the manufacturer and part-number strings from an
// SMBIOS type-17 table. Serial and asset strings are skipped, never retained.
func readMemoryModule(path string) (protocol.HardwareMemory, bool) {
	f, err := os.Open(path)
	if err != nil {
		return protocol.HardwareMemory{}, false
	}
	defer f.Close()
	header := make([]byte, 4)
	if _, err = io.ReadFull(f, header); err != nil || header[0] != 17 || header[1] < 0x1b {
		return protocol.HardwareMemory{}, false
	}
	formatted := make([]byte, int(header[1]))
	copy(formatted, header)
	if _, err = io.ReadFull(f, formatted[4:]); err != nil {
		return protocol.HardwareMemory{}, false
	}
	size := binary.LittleEndian.Uint16(formatted[0x0c:0x0e])
	if size == 0 {
		return protocol.HardwareMemory{}, false
	}
	module := protocol.HardwareMemory{}
	switch {
	case size == 0xffff:
	case size == 0x7fff:
		if len(formatted) >= 0x20 {
			module.SizeBytes = uint64(binary.LittleEndian.Uint32(formatted[0x1c:0x20])&0x7fffffff) * 1024 * 1024
		}
	case size&0x8000 != 0:
		module.SizeBytes = uint64(size&0x7fff) * 1024
	default:
		module.SizeBytes = uint64(size) * 1024 * 1024
	}
	manufacturer, serial, asset, part := formatted[0x17], formatted[0x18], formatted[0x19], formatted[0x1a]
	idx := byte(1)
	var text []byte
	prevNul := false
	one := []byte{0}
	for i := 0; i < 8192; i++ {
		if _, err = f.Read(one); err != nil {
			break
		}
		c := one[0]
		if c == 0 {
			if prevNul {
				break
			}
			if idx != serial && idx != asset {
				v := cleanHardwareText(string(text))
				if idx == manufacturer {
					module.Vendor = v
				}
				if idx == part {
					module.Model = v
				}
			}
			idx++
			text = nil
			prevNul = true
			continue
		}
		prevNul = false
		if idx != serial && idx != asset && (idx == manufacturer || idx == part) && len(text) < 512 {
			text = append(text, c)
		}
	}
	if strings.EqualFold(module.Vendor, "unknown") || strings.EqualFold(module.Vendor, "not specified") {
		module.Vendor = ""
	}
	if strings.EqualFold(module.Model, "unknown") || strings.EqualFold(module.Model, "not specified") {
		module.Model = ""
	}
	return module, true
}
func memoryModules(sys string) []protocol.HardwareMemory {
	entries, _ := filepath.Glob(filepath.Join(sys, "firmware/dmi/entries/17-*/raw"))
	sort.Strings(entries)
	out := []protocol.HardwareMemory{}
	for _, path := range entries {
		if module, ok := readMemoryModule(path); ok {
			out = append(out, module)
			if len(out) >= 64 {
				break
			}
		}
	}
	return out
}

func blockDevices(sys string) []protocol.HardwareDisk {
	root := filepath.Join(sys, "block")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	out := []protocol.HardwareDisk{}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") || strings.HasPrefix(name, "zram") || strings.HasPrefix(name, "dm-") || strings.HasPrefix(name, "md") || strings.Contains(name, "boot") || strings.Contains(name, "rpmb") {
			continue
		}
		base := filepath.Join(root, name)
		model := readText(filepath.Join(base, "device/model"))
		if model == "" {
			model = readText(filepath.Join(base, "device/name"))
		}
		vendor := readText(filepath.Join(base, "device/vendor"))
		sectors, _ := strconv.ParseUint(readText(filepath.Join(base, "size")), 10, 64)
		size := uint64(0)
		if sectors <= math.MaxUint64/512 {
			size = sectors * 512
		}
		if size == 0 && model == "" {
			continue
		}
		out = append(out, protocol.HardwareDisk{Name: cleanHardwareText(name), Model: model, Vendor: vendor, SizeBytes: size})
		if len(out) >= 64 {
			break
		}
	}
	return out
}
func nvidiaGPUs(ctx context.Context) []protocol.HardwareGPU {
	path, err := exec.LookPath("nvidia-smi")
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits")
	stdout, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		return nil
	}
	b, readErr := io.ReadAll(io.LimitReader(stdout, 16385))
	waitErr := cmd.Wait()
	if readErr != nil || waitErr != nil || len(b) > 16384 {
		return nil
	}
	out := []protocol.HardwareGPU{}
	for _, line := range strings.Split(string(b), "\n") {
		name, mem, ok := strings.Cut(line, ",")
		if !ok {
			continue
		}
		name = cleanHardwareText(name)
		n, err := strconv.ParseUint(strings.TrimSpace(mem), 10, 64)
		if name == "" {
			continue
		}
		g := protocol.HardwareGPU{Model: name}
		if err == nil && n <= math.MaxUint64/(1024*1024) {
			g.MemoryBytes = n * 1024 * 1024
		}
		out = append(out, g)
		if len(out) >= 32 {
			break
		}
	}
	return out
}
func collectHardware(ctx context.Context, proc, sys string) *protocol.NodeHardware {
	cpuData, _ := os.ReadFile(filepath.Join(proc, "cpuinfo"))
	memData, _ := os.ReadFile(filepath.Join(proc, "meminfo"))
	logical, cores := cpuCounts(sys)
	if logical == 0 && proc == "/proc" {
		logical = runtime.NumCPU()
	}
	disks := blockDevices(sys)
	sort.Slice(disks, func(i, j int) bool { return disks[i].Name < disks[j].Name })
	h := &protocol.NodeHardware{CollectedAt: time.Now().UTC().Format(time.RFC3339), CPUModel: cpuModel(string(cpuData)), LogicalCPUs: logical, PhysicalCores: cores, MemoryBytes: memoryTotal(string(memData)), MemoryModules: memoryModules(sys), Disks: disks}
	if proc == "/proc" && sys == "/sys" {
		h.GPUs = nvidiaGPUs(ctx)
	}
	return h
}
