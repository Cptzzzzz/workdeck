package hub

import (
	"encoding/json"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"workdeck/internal/protocol"
)

func hardwareText(value string, max int) string {
	value = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, value))
	if utf8.RuneCountInString(value) > max {
		return string([]rune(value)[:max])
	}
	return value
}
func hardwareDeviceName(name string) string {
	name = hardwareText(name, 64)
	if name == "" {
		return ""
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return ""
		}
	}
	return name
}
func cleanHardware(h *protocol.NodeHardware) *protocol.NodeHardware {
	if h == nil {
		return nil
	}
	if _, err := time.Parse(time.RFC3339, h.CollectedAt); err != nil {
		return nil
	}
	const maxBytes = uint64(1<<53 - 1)
	n := &protocol.NodeHardware{CollectedAt: h.CollectedAt, CPUModel: hardwareText(h.CPUModel, 160)}
	if h.LogicalCPUs > 0 && h.LogicalCPUs <= 65536 {
		n.LogicalCPUs = h.LogicalCPUs
	}
	if h.PhysicalCores > 0 && h.PhysicalCores <= 65536 && (n.LogicalCPUs == 0 || h.PhysicalCores <= n.LogicalCPUs) {
		n.PhysicalCores = h.PhysicalCores
	}
	if h.MemoryBytes <= maxBytes {
		n.MemoryBytes = h.MemoryBytes
	}
	for _, m := range h.MemoryModules {
		v := protocol.HardwareMemory{Model: hardwareText(m.Model, 160), Vendor: hardwareText(m.Vendor, 160)}
		if m.SizeBytes <= maxBytes {
			v.SizeBytes = m.SizeBytes
		}
		n.MemoryModules = append(n.MemoryModules, v)
		if len(n.MemoryModules) >= 64 {
			break
		}
	}
	seen := map[string]bool{}
	for _, d := range h.Disks {
		name := hardwareDeviceName(d.Name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		v := protocol.HardwareDisk{Name: name, Model: hardwareText(d.Model, 160), Vendor: hardwareText(d.Vendor, 160)}
		if d.SizeBytes <= maxBytes {
			v.SizeBytes = d.SizeBytes
		}
		n.Disks = append(n.Disks, v)
		if len(n.Disks) >= 64 {
			break
		}
	}
	for _, g := range h.GPUs {
		model := hardwareText(g.Model, 160)
		if model == "" {
			continue
		}
		v := protocol.HardwareGPU{Model: model}
		if g.MemoryBytes <= maxBytes {
			v.MemoryBytes = g.MemoryBytes
		}
		n.GPUs = append(n.GPUs, v)
		if len(n.GPUs) >= 32 {
			break
		}
	}
	return n
}
func encodeHardware(h *protocol.NodeHardware) string {
	if clean := cleanHardware(h); clean != nil {
		b, e := json.Marshal(clean)
		if e == nil && len(b) <= 32768 {
			return string(b)
		}
	}
	return ""
}
