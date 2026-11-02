package agent

import (
	"encoding/binary"
	"net"
	"sync"

	"github.com/pion/transport/v5"
	"workdeck/internal/protocol"
)

// ICE wire counters only: no addresses, ports, credentials, packet contents or
// transaction IDs are emitted. Transaction IDs live only in this peer's memory.
type iceWireTrace struct {
	mu                                                                                  sync.Mutex
	sent, received, successSent, successReceived, errorSent, errorReceived, writeErrors uint64
	outgoing, incoming                                                                  map[[12]byte]struct{}
}
type iceWireSummary = protocol.RTCWireSummary

func (t *iceWireTrace) snapshot() iceWireSummary {
	t.mu.Lock()
	defer t.mu.Unlock()
	return iceWireSummary{Sent: t.sent, Received: t.received, SuccessSent: t.successSent, SuccessReceived: t.successReceived, ErrorSent: t.errorSent, ErrorReceived: t.errorReceived, WriteErrors: t.writeErrors}
}
func (t *iceWireTrace) observe(b []byte, outgoing bool, sendErr error) {
	if len(b) < 20 || binary.BigEndian.Uint32(b[4:8]) != 0x2112a442 {
		return
	}
	typ := binary.BigEndian.Uint16(b[0:2])
	if typ != 0x0001 && typ != 0x0101 && typ != 0x0111 {
		return
	}
	size := int(binary.BigEndian.Uint16(b[2:4]))
	if size%4 != 0 || size > len(b)-20 {
		return
	}
	var id [12]byte
	copy(id[:], b[8:20])
	username := false
	for p, end := 20, 20+size; p+4 <= end; {
		tag, n := binary.BigEndian.Uint16(b[p:p+2]), int(binary.BigEndian.Uint16(b[p+2:p+4]))
		p += 4
		if p+n > end {
			return
		}
		if tag == 6 {
			username = true
		}
		p += (n + 3) &^ 3
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.outgoing == nil {
		t.outgoing = make(map[[12]byte]struct{})
		t.incoming = make(map[[12]byte]struct{})
	}
	if typ == 1 && username {
		if outgoing {
			if sendErr != nil {
				t.writeErrors++
				return
			}
			t.sent++
			if len(t.outgoing) < 512 {
				t.outgoing[id] = struct{}{}
			}
		} else {
			t.received++
			if len(t.incoming) < 512 {
				t.incoming[id] = struct{}{}
			}
		}
		return
	}
	if typ == 1 {
		return
	}
	if outgoing {
		if _, ok := t.incoming[id]; !ok {
			return
		}
		if sendErr != nil {
			t.writeErrors++
			return
		}
		if typ == 0x0101 {
			t.successSent++
		} else {
			t.errorSent++
		}
	} else {
		if _, ok := t.outgoing[id]; !ok {
			return
		}
		if typ == 0x0101 {
			t.successReceived++
		} else {
			t.errorReceived++
		}
	}
}

type iceTraceNet struct {
	transport.Net
	trace *iceWireTrace
}
type iceTraceUDP struct {
	transport.UDPConn
	trace *iceWireTrace
}
type iceTracePacket struct {
	net.PacketConn
	trace *iceWireTrace
}

func (n *iceTraceNet) ListenUDP(network string, addr *net.UDPAddr) (transport.UDPConn, error) {
	c, e := n.Net.ListenUDP(network, addr)
	if e != nil {
		return nil, e
	}
	return &iceTraceUDP{c, n.trace}, nil
}
func (n *iceTraceNet) DialUDP(network string, local, remote *net.UDPAddr) (transport.UDPConn, error) {
	c, e := n.Net.DialUDP(network, local, remote)
	if e != nil {
		return nil, e
	}
	return &iceTraceUDP{c, n.trace}, nil
}
func (n *iceTraceNet) ListenPacket(network, addr string) (net.PacketConn, error) {
	c, e := n.Net.ListenPacket(network, addr)
	if e != nil {
		return nil, e
	}
	return &iceTracePacket{c, n.trace}, nil
}
func (c *iceTraceUDP) ReadFrom(b []byte) (int, net.Addr, error) {
	n, a, e := c.UDPConn.ReadFrom(b)
	if n > 0 {
		c.trace.observe(b[:n], false, nil)
	}
	return n, a, e
}
func (c *iceTraceUDP) WriteTo(b []byte, a net.Addr) (int, error) {
	n, e := c.UDPConn.WriteTo(b, a)
	c.trace.observe(b, true, e)
	return n, e
}
func (c *iceTraceUDP) ReadFromUDP(b []byte) (int, *net.UDPAddr, error) {
	n, a, e := c.UDPConn.ReadFromUDP(b)
	if n > 0 {
		c.trace.observe(b[:n], false, nil)
	}
	return n, a, e
}
func (c *iceTraceUDP) WriteToUDP(b []byte, a *net.UDPAddr) (int, error) {
	n, e := c.UDPConn.WriteToUDP(b, a)
	c.trace.observe(b, true, e)
	return n, e
}
func (c *iceTraceUDP) Read(b []byte) (int, error) {
	n, e := c.UDPConn.Read(b)
	if n > 0 {
		c.trace.observe(b[:n], false, nil)
	}
	return n, e
}
func (c *iceTraceUDP) Write(b []byte) (int, error) {
	n, e := c.UDPConn.Write(b)
	c.trace.observe(b, true, e)
	return n, e
}
func (c *iceTracePacket) ReadFrom(b []byte) (int, net.Addr, error) {
	n, a, e := c.PacketConn.ReadFrom(b)
	if n > 0 {
		c.trace.observe(b[:n], false, nil)
	}
	return n, a, e
}
func (c *iceTracePacket) WriteTo(b []byte, a net.Addr) (int, error) {
	n, e := c.PacketConn.WriteTo(b, a)
	c.trace.observe(b, true, e)
	return n, e
}
