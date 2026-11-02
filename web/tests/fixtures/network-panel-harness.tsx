import { createRoot } from "react-dom/client";
import { useState } from "react";
import { NetworkPanel } from "../../src/network-panel";
import {
  initialTransportStatus,
  type TestPath,
  type TransportStatus,
} from "../../src/network-metrics";
import "../../src/style.css";
function snapshot(direct = false): TransportStatus {
  const s = initialTransportStatus();
  const stamp = Date.now();
  return {
    ...s,
    relayProtocol: "http-stream",
    route: direct ? "direct" : "relay",
    detail: direct
      ? "直连稳定，保持中转作为备用通道。"
      : "WebSocket 建连未成功，HTTP 流式通道正在承载终端。",
    relay: {
      state: "available",
      latency: 18,
      jitter: 2.1,
      samples: 12,
      failures: 0,
      updatedAt: stamp,
    },
    direct: direct
      ? {
          state: "available",
          latency: 8.6,
          jitter: 0.8,
          samples: 12,
          failures: 0,
          updatedAt: stamp,
        }
      : {
          state: "unavailable",
          samples: 0,
          failures: 0,
          reason: "暂未建立稳定的节点直连。",
        },
    relayCandidates: {
      websocket: { state: "failed", attempts: 2 },
      "http-stream": { state: "open", attempts: 1, handshakeMs: 42 },
    },
    traffic: {
      relay: {
        received: 123456,
        sent: 2345,
        receiveRate: direct ? 0 : 1234,
        sendRate: direct ? 0 : 234,
      },
      direct: {
        received: direct ? 23456 : 0,
        sent: direct ? 3456 : 0,
        receiveRate: direct ? 2034 : 0,
        sendRate: direct ? 145 : 0,
      },
    },
    alternatives: direct
      ? {
          native: { state: "unavailable", samples: 0, failures: 0 },
          tailnet: {
            state: "available",
            latency: 11.2,
            jitter: 1.1,
            samples: 6,
            failures: 0,
            updatedAt: stamp,
          },
        }
      : undefined,
  };
}
function Harness() {
  const [s, set] = useState(snapshot());
  const testPath = (path: TestPath) => {
    set((old) => ({
      ...old,
      testingPath: path,
      discovery: "settled",
      manualTests: {
        ...old.manualTests,
        [path]: { state: "measuring", samples: 0, failures: 0 },
      },
    }));
    setTimeout(
      () =>
        set((old) => ({
          ...old,
          testingPath: undefined,
          manualTests: {
            ...old.manualTests,
            [path]: {
              state: "available",
              latency: 12,
              jitter: 1,
              samples: 6,
              failures: 0,
              updatedAt: Date.now(),
            },
          },
        })),
      100,
    );
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: 24,
        background: "#111715",
        color: "#d7dedb",
      }}
    >
      <h1 style={{ fontSize: 18 }}>网络详情预览</h1>
      <button onClick={() => set(snapshot(true))}>模拟直连</button>
      <button onClick={() => set(snapshot(false))}>模拟 HTTP</button>
      <button
        onClick={() =>
          set({
            ...initialTransportStatus(),
            relayCandidates: {
              websocket: { state: "connecting", attempts: 1 },
            },
          })
        }
      >
        模拟连接中
      </button>
      <div style={{ position: "fixed", bottom: 24, right: 24 }}>
        <NetworkPanel
          status={s}
          nodeName="开发节点"
          onRetryDirect={() => {}}
          onTestPath={testPath}
        />
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
