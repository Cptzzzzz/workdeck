import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { NetworkPanel } from "../../src/network-panel";
import {
  initialTransportStatus,
  type TransportStatus,
} from "../../src/network-metrics";
import { TerminalTransport } from "../../src/terminal-transport";
import "../../src/style.css";

const terminalID = "a".repeat(48);
const sdp =
  "v=0\r\na=candidate:private-candidate-id 1 udp 123 192.0.2.55 12345 typ host\r\na=candidate:private-candidate-id2 1 udp 123 198.51.100.1 54321 typ srflx raddr 192.0.2.55 rport 12345\r\na=ice-pwd:private-password\r\n";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1;
  binaryType = "arraybuffer";
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    setTimeout(() => {
      this.onmessage?.({
        data: JSON.stringify({ type: "ready", readonly: false }),
      });
      this.onmessage?.({
        data: JSON.stringify({
          type: "rtc-config",
          ice_servers: ["stun:example.invalid:3478"],
        }),
      });
    }, 30);
  }
  send(data: string | Uint8Array) {
    if (typeof data !== "string") return;
    const frame = JSON.parse(data);
    if (frame.type === "rtc-offer")
      setTimeout(
        () =>
          this.onmessage?.({
            data: JSON.stringify({ type: "rtc-answer", sdp }),
          }),
        30,
      );
    if (frame.type === "rtc-offer")
      setTimeout(
        () =>
          this.onmessage?.({
            data: JSON.stringify({
              type: "rtc-diagnostic",
              node_diagnostic: {
                sampleMs: 1000,
                gathering: "complete",
                ice: "checking",
                connection: "connecting",
                stunServers: 1,
                localCandidates: { "host/udp": 2 },
                remoteCandidates: { "srflx/udp": 1 },
                remoteReceived: 3,
                remoteApplied: 2,
                remoteRejected: 1,
                remotePending: 0,
                pairs: [
                  {
                    local: "host/udp",
                    remote: "srflx/udp",
                    state: "in-progress",
                    count: 1,
                    requestsSent: 9,
                    responsesReceived: 0,
                    requestsReceived: 5,
                    responsesSent: 5,
                    id: "private-local-id",
                    address: "192.0.2.19",
                  },
                ],
                sdp: "private-password",
              },
            }),
          }),
        1200,
      );
    if (frame.type === "rtc-offer")
      setTimeout(
        () =>
          this.onmessage?.({
            data: JSON.stringify({
              type: "rtc-diagnostic",
              node_diagnostic: {
                sampleMs: 2800,
                gathering: "complete",
                ice: "failed",
                connection: "failed",
                stunServers: 1,
                localCandidates: {},
                remoteCandidates: {},
                remoteReceived: 3,
                remoteApplied: 2,
                remoteRejected: 1,
                remotePending: 0,
                pairs: [],
                secret: "private-password",
              },
            }),
          }),
        2900,
      );
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}
class FakeChannel {
  readyState = "connecting";
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  onmessage = null;
  onclose: (() => void) | null = null;
  onerror = null;
  onopen: (() => void) | null = null;
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
  send(_data: unknown) {}
}
class FakePeer extends EventTarget {
  iceGatheringState = "new";
  iceConnectionState = "new";
  connectionState = "new";
  localDescription: { sdp: string } | null = null;
  onicecandidate: ((event: any) => void) | null = null;
  onicecandidateerror: null = null;
  onicegatheringstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  channel = new FakeChannel();
  constructor(_config: unknown) {
    super();
  }
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp };
  }
  async setLocalDescription() {
    this.localDescription = { sdp };
    this.iceGatheringState = "complete";
    this.onicecandidate?.({
      candidate: {
        type: "host",
        protocol: "udp",
        candidate: "candidate:private 1 udp 1 192.0.2.55 12345 typ host",
      },
    });
    this.onicegatheringstatechange?.();
    this.dispatchEvent(new Event("icegatheringstatechange"));
  }
  async setRemoteDescription() {
    this.iceConnectionState = "checking";
    this.connectionState = "connecting";
    this.oniceconnectionstatechange?.();
    this.onconnectionstatechange?.();
    setTimeout(() => {
      this.iceConnectionState = "failed";
      this.connectionState = "failed";
      this.oniceconnectionstatechange?.();
      this.onconnectionstatechange?.();
    }, 2600);
  }
  async getStats() {
    return new Map<string, unknown>([
      [
        "private-local-id",
        {
          type: "local-candidate",
          candidateType: "host",
          protocol: "udp",
          address: "192.0.2.55",
          port: 12345,
        },
      ],
      [
        "private-remote-id",
        {
          type: "remote-candidate",
          candidateType: "srflx",
          protocol: "udp",
          address: "198.51.100.1",
          port: 54321,
        },
      ],
      [
        "private-pair-id",
        {
          type: "candidate-pair",
          localCandidateId: "private-local-id",
          remoteCandidateId: "private-remote-id",
          state: "in-progress",
          requestsSent: 4,
          responsesReceived: 0,
        },
      ],
    ]);
  }
  close() {
    this.connectionState = "closed";
  }
}
window.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
window.RTCPeerConnection = FakePeer as unknown as typeof RTCPeerConnection;

function App() {
  const [status, setStatus] = useState<TransportStatus>(initialTransportStatus);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const transport = new TerminalTransport(
      "ws://fixture",
      setStatus,
      "fixture-node",
      undefined,
      terminalID,
    );
    return () => transport.close();
  }, [generation]);
  return (
    <>
      <button onClick={() => setGeneration((n) => n + 1)}>重连测试</button>
      <section
        style={{
          height: 500,
          position: "relative",
          display: "flex",
          alignItems: "end",
        }}
      >
        <div className="terminal-statusbar">
          <NetworkPanel
            status={status}
            onRetryDirect={() => setGeneration((n) => n + 1)}
          />
        </div>
      </section>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
