import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  ArrowLeft,
  ArrowRight,
  TerminalSquare,
  RefreshCw,
  Maximize2,
  Trash2,
  Monitor,
} from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { ComputeNode as Node, TerminalRecord as Term } from "../../types";
import {
  TerminalTransport,
  clearDirectCooldown,
  type TransportStatus,
} from "../../terminal-transport";
import { initialTransportStatus } from "../../network-metrics";
import { NetworkPanel } from "../../network-panel";
import { TerminalFontControl } from "../../terminal-font-control";
import { registerTerminalPressure } from "../../services/files/terminal-pressure";
import { codexStatus } from "../../codex-status";
import { installTerminalSelection } from "./selection";
function sendInput(socket: TerminalTransport | null, bytes: Uint8Array) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  for (let offset = 0; offset < bytes.length; offset += 16384)
    socket.send(bytes.subarray(offset, offset + 16384));
}
export function TerminalView({
  terminal,
  node,
  visible,
  layoutVisible = true,
  fontSize,
  onFontSizeChange,
  onBack,
  onStop,
  notify,
}: {
  terminal: Term;
  node?: Node;
  visible: boolean;
  layoutVisible?: boolean;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  onBack: () => void;
  onStop: () => void;
  notify: (s: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLElement>(null),
    instance = useRef<XTerminal | null>(null),
    socket = useRef<TerminalTransport | null>(null),
    inputRef = useRef<(bytes: Uint8Array) => void>(() => {}),
    connectRef = useRef<(takeover?: boolean) => void>(() => {}),
    fitRef = useRef<() => void>(() => {});
  const [connection, setConnection] = useState("connecting"),
    [readonly, setReadonly] = useState(true),
    [size, setSize] = useState(""),
    [failure, setFailure] = useState(""),
    [ctrl, setCtrl] = useState(false);
  const [transport, setTransport] = useState<TransportStatus>(
    initialTransportStatus,
  );
  const stopped =
    terminal.desired_state === "closed" ||
    ["closed", "lost", "error"].includes(terminal.state);
  const visibleRef = useRef(visible && layoutVisible);
  visibleRef.current = visible && layoutVisible;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const focusTerminal = useCallback(() => instance.current?.focus(), []);
  useEffect(() => {
    if (!container.current || stopped) return;
    const term = new XTerminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: fontSizeRef.current,
      lineHeight: 1.25,
      scrollback: 5000,
      allowProposedApi: false,
      macOptionClickForcesSelection: true,
      theme: {
        background: "#111416",
        foreground: "#d7dedb",
        cursor: "#e7ae7a",
        selectionBackground: "#46605688",
        black: "#202628",
        red: "#e99591",
        green: "#9fc7a3",
        yellow: "#e2c38f",
        blue: "#95b7d1",
        magenta: "#bda3cf",
        cyan: "#91c5c0",
        white: "#d7dedb",
      },
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    const removeSelectionHandlers = installTerminalSelection(term);
    instance.current = term;
    let disposed = false,
      retry: ReturnType<typeof setTimeout> | null = null,
      generation = 0,
      attempt = 0,
      currentReadonly = true,
      wheelDispatch = false,
      historyMayBeActive = true;
    let pressure: ReturnType<typeof registerTerminalPressure> | undefined;
    const sendKeyboardInput = (bytes: Uint8Array) => {
      if (socket.current?.readyState !== WebSocket.OPEN || currentReadonly)
        return;
      if (!wheelDispatch && historyMayBeActive) {
        socket.current.send(JSON.stringify({ type: "scroll-exit" }));
        historyMayBeActive = false;
      }
      sendInput(socket.current, bytes);
    };
    inputRef.current = sendKeyboardInput;
    term.attachCustomWheelEventHandler((event) => {
      if (event.ctrlKey) return false;
      if (term.modes.mouseTrackingMode !== "none") {
        // tmux receives genuine mouse reports. Do not treat those reports as
        // keyboard input, or they would cancel the copy mode they just opened.
        wheelDispatch = true;
        historyMayBeActive = true;
        queueMicrotask(() => {
          wheelDispatch = false;
        });
        return true;
      }
      if (term.buffer.active.type === "alternate") {
        // xterm otherwise synthesizes Up/Down in an alternate screen. During
        // reconnect/with an old Agent a wheel must never edit shell history.
        event.preventDefault();
        return false;
      }
      return true;
    });
    let lastResize = 0,
      resizeTimer = 0;
    const transmitSize = () => {
      resizeTimer = 0;
      if (
        disposed ||
        !visibleRef.current ||
        socket.current?.readyState !== WebSocket.OPEN
      )
        return;
      lastResize = performance.now();
      socket.current.send(
        JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
      );
    };
    const sendSize = (force = false) => {
      if (
        disposed ||
        !visibleRef.current ||
        !container.current?.clientWidth ||
        !container.current?.clientHeight
      )
        return;
      try {
        fit.fit();
        setSize(`${term.cols} × ${term.rows}`);
        if (force || performance.now() - lastResize >= 100) {
          if (resizeTimer) clearTimeout(resizeTimer);
          transmitSize();
        } else if (!resizeTimer) {
          resizeTimer = window.setTimeout(
            transmitSize,
            100 - (performance.now() - lastResize),
          );
        }
      } catch {}
    };
    fitRef.current = () => sendSize(true);
    const connect = (takeover = false) => {
      if (disposed) return;
      generation++;
      const gen = generation;
      if (retry) clearTimeout(retry);
      socket.current?.close();
      pressure?.close();
      const currentPressure = registerTerminalPressure(terminal.id);
      pressure = currentPressure;
      setConnection("connecting");
      setFailure("");
      const ws = new TerminalTransport(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/terminals/${terminal.id}/ws${takeover ? "?takeover=1" : ""}`,
        setTransport,
        terminal.node_id,
        (route, rtt) => {
          if (gen === generation) currentPressure.sample(route, rtt);
        },
        terminal.id,
        () => visibleRef.current,
      );
      socket.current = ws;
      ws.onmessage = (e) => {
        if (gen !== generation) return;
        if (typeof e.data === "string") {
          try {
            const frame = JSON.parse(e.data);
            if (frame.type === "ready") {
              term.reset();
              historyMayBeActive = true;
              currentReadonly = frame.readonly;
              setReadonly(frame.readonly);
              term.options.disableStdin = frame.readonly;
              setConnection("connected");
              attempt = 0;
              requestAnimationFrame(() => sendSize());
              if (visibleRef.current) term.focus();
            } else if (frame.type === "error") {
              setFailure(frame.message);
              setConnection("error");
            }
          } catch {}
          return;
        }
        const bytes = new Uint8Array(e.data);
        term.write(bytes, () => {
          if (gen === generation) ws.outputRendered();
          if (ws.readyState === WebSocket.OPEN && gen === generation)
            ws.send(JSON.stringify({ type: "ack", bytes: bytes.byteLength }));
        });
      };
      ws.onclose = () => {
        if (disposed || gen !== generation) return;
        currentPressure.close();
        setConnection("disconnected");
        retry = setTimeout(
          () => connect(),
          Math.min(1000 * 2 ** attempt++, 15000),
        );
      };
      ws.onerror = () => {
        if (gen === generation) setConnection("disconnected");
      };
    };
    connectRef.current = connect;
    const input = term.onData((data) => {
      sendKeyboardInput(new TextEncoder().encode(data));
    });
    const binary = term.onBinary((data) => {
      sendKeyboardInput(Uint8Array.from(data, (c) => c.charCodeAt(0)));
    });
    const observer = new ResizeObserver(() =>
      requestAnimationFrame(() => sendSize()),
    );
    observer.observe(container.current);
    const viewport = () => requestAnimationFrame(() => sendSize());
    const resizeEnd = () => requestAnimationFrame(() => sendSize(true));
    window.visualViewport?.addEventListener("resize", viewport);
    window.addEventListener("resize", viewport);
    window.addEventListener("workdeck:resize-end", resizeEnd);
    connect();
    return () => {
      removeSelectionHandlers();
      disposed = true;
      generation++;
      if (retry) clearTimeout(retry);
      observer.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      window.visualViewport?.removeEventListener("resize", viewport);
      window.removeEventListener("resize", viewport);
      window.removeEventListener("workdeck:resize-end", resizeEnd);
      socket.current?.close();
      pressure?.close();
      socket.current = null;
      input.dispose();
      binary.dispose();
      term.dispose();
      instance.current = null;
      inputRef.current = () => {};
    };
  }, [terminal.id, stopped]);
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        fitRef.current();
        instance.current?.focus();
      });
    }
  }, [visible]);
  useEffect(() => {
    if (visible && layoutVisible) {
      socket.current?.terminalVisible();
      const frame = requestAnimationFrame(() => fitRef.current());
      return () => cancelAnimationFrame(frame);
    }
  }, [layoutVisible, visible]);
  useEffect(() => {
    // Hidden tabs are measured when shown, including browsers which use DOM
    // font measurement and cannot measure inside display:none.
    if (visible && instance.current) {
      instance.current.options.fontSize = fontSize;
      const frame = requestAnimationFrame(() => fitRef.current());
      return () => cancelAnimationFrame(frame);
    }
  }, [fontSize, visible]);
  const send = (s: string) => {
    if (readonly || socket.current?.readyState !== WebSocket.OPEN) return;
    inputRef.current(new TextEncoder().encode(s));
    instance.current?.focus();
  };
  return (
    <section
      ref={panel}
      className={"terminal-workspace " + (!visible ? "hidden" : "")}
    >
      <div className="terminal-heading">
        <div>
          <button className="icon-button" title="返回概览" onClick={onBack}>
            <ArrowLeft size={17} />
          </button>
          <TerminalSquare size={18} />
          <b>{terminal.name}</b>
          <span className="terminal-host">{node?.name}</span>
        </div>
        <div>
          <span
            className={
              "terminal-state " + (connection === "connected" ? "live" : "")
            }
          >
            {stopped
              ? "已结束"
              : connection === "connected"
                ? readonly
                  ? "只读连接"
                  : "控制中"
                : "重新连接中…"}
          </span>
          <TerminalFontControl
            size={fontSize}
            onChange={onFontSizeChange}
            onClose={focusTerminal}
          />
          <button
            className="icon-button"
            title="重新连接"
            aria-label="重新连接"
            onClick={() => connectRef.current()}
          >
            <RefreshCw size={16} />
          </button>
          <button
            className="icon-button"
            title="全屏"
            aria-label="全屏"
            onClick={() => {
              if (!document.fullscreenElement)
                void panel.current
                  ?.requestFullscreen()
                  .catch(() => notify("浏览器不支持全屏"));
              else void document.exitFullscreen();
            }}
          >
            <Maximize2 size={16} />
          </button>
          <button
            className="icon-button danger-text"
            title="终止终端和任务"
            aria-label="终止终端"
            onClick={onStop}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      {!stopped && readonly && connection === "connected" && (
        <div className="readonly-banner">
          <Monitor size={15} />
          <span>其他设备正在控制此终端。当前为只读模式。</span>
          <button onClick={() => connectRef.current(true)}>
            接管终端
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      {(failure || stopped || !node?.online) && (
        <div className="terminal-notice">
          {failure ||
            (stopped
              ? "此终端已结束。可返回概览创建新的终端。"
              : "节点当前离线，正在等待重新连接。")}
        </div>
      )}
      <div className="terminal-screen">
        <div className="terminal-mount" ref={container} />
      </div>
      <div className="mobile-keys">
        <button
          className={ctrl ? "pressed" : ""}
          disabled={readonly}
          onClick={() => setCtrl(!ctrl)}
        >
          Ctrl
        </button>
        {ctrl ? (
          <>
            {["C", "D", "Z", "L"].map((k) => (
              <button
                key={k}
                disabled={readonly}
                onClick={() => {
                  send(String.fromCharCode(k.charCodeAt(0) - 64));
                  setCtrl(false);
                }}
              >
                {k}
              </button>
            ))}
          </>
        ) : (
          <>
            <button disabled={readonly} onClick={() => send("\x1b")}>
              Esc
            </button>
            <button disabled={readonly} onClick={() => send("\t")}>
              Tab
            </button>
            <button disabled={readonly} onClick={() => send("\x1b[A")}>
              ↑
            </button>
            <button disabled={readonly} onClick={() => send("\x1b[B")}>
              ↓
            </button>
            <button disabled={readonly} onClick={() => send("\x1b[D")}>
              ←
            </button>
            <button disabled={readonly} onClick={() => send("\x1b[C")}>
              →
            </button>
          </>
        )}
        <button
          disabled={readonly}
          onClick={async () => {
            try {
              instance.current?.paste(await navigator.clipboard.readText());
              instance.current?.focus();
            } catch {
              notify("请使用浏览器的粘贴功能");
            }
          }}
        >
          粘贴
        </button>
      </div>
      <div className="terminal-statusbar">
        <span>
          <i
            className={"dot " + (connection === "connected" ? "online" : "")}
          />
          {connection === "connected"
            ? readonly
              ? "只读"
              : "可输入"
            : "连接恢复中"}
        </span>
        <span>{terminal.cwd}</span>
        <span>{size}</span>
        {codexStatus(terminal, node) && (
          <span
            className={`codex-bar-status ${codexStatus(terminal, node)!.kind}`}
          >
            {codexStatus(terminal, node)!.text}
          </span>
        )}
        {!stopped && connection === "connected" && (
          <NetworkPanel
            status={transport}
            nodeName={node?.name}
            onTestPath={(path) => {
              void socket.current?.testPath(path);
            }}
            onRetryDirect={() => {
              clearDirectCooldown(terminal.node_id);
              connectRef.current();
            }}
          />
        )}
        <span className="persist-label">关闭标签页后任务继续运行</span>
      </div>
    </section>
  );
}
