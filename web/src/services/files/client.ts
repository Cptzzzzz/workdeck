import { api } from "../api";
import { checkTransferAbort, hashBlob } from "./transfer";
import { FileDirect } from "./direct";
import { terminalPressureDelay } from "./terminal-pressure";
import type { Route } from "../../transport-policy";
import {
  decodeChunk,
  encodeChunk,
  encodeControl,
  makeID,
  MAX_CHUNK,
  MAX_CONTROL,
  type Envelope,
} from "./protocol";
import type {
  DirectoryPage,
  FileEntry,
  FileOperation,
  PendingWrite,
  SaveTransaction,
  UploadTransaction,
  DeleteStatus,
  DeleteOutcome,
  ArchivedOperation,
  Workspace,
  WorkspaceView,
} from "./types";

export class FileServiceError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "FileServiceError";
  }
}
export class UncertainSaveError extends FileServiceError {
  constructor(
    public transaction: SaveTransaction,
    cause: string,
  ) {
    super("SAVE_UNCERTAIN", `保存结果尚未确认：${cause}`);
    this.name = "UncertainSaveError";
  }
}
export type FileTraffic = {
  sent: number;
  received: number;
  sendRate: number;
  receiveRate: number;
};
export type FileTransportMetrics = {
  route: Route;
  tailscaleCandidate?: "possible" | "other" | "unknown";
  relayLatency?: number;
  directLatency?: number;
  adaptiveDelayMs: number;
  traffic: Record<Route, FileTraffic>;
};
type WireResult = {
  result?: unknown;
  error?: { code?: string; message?: string };
};
type Pending = {
  resolve: (value: { value: unknown; data?: Uint8Array }) => void;
  reject: (error: Error) => void;
  timer: number;
  expectedOffset?: number;
  expectedLength?: number;
  responseType: "result" | "file.write.progress";
  data?: Uint8Array;
  route: Route;
  epoch: number;
  control?: { value: unknown; bytes: number };
};

export async function getWorkspace(terminalID: string): Promise<WorkspaceView> {
  return api(`/terminals/${encodeURIComponent(terminalID)}/workspace`);
}
export async function initializeWorkspace(
  terminalID: string,
): Promise<WorkspaceView> {
  return api(`/terminals/${encodeURIComponent(terminalID)}/workspace`, {
    method: "POST",
    body: "{}",
  });
}
export async function changeWorkspaceRoot(
  terminalID: string,
  root: string,
  revision: number,
): Promise<WorkspaceView> {
  return api(`/terminals/${encodeURIComponent(terminalID)}/workspace`, {
    method: "PUT",
    body: JSON.stringify({ root_path: root, root_revision: revision }),
  });
}

// One instance represents one authenticated workspace lease. A disconnected
// instance never silently replays a mutation; callers reconnect and reconcile
// the original operation ID before deciding whether to resume.
export class FileClient {
  private socket!: WebSocket;
  private pending = new Map<string, Pending>();
  private paceWaiters = new Set<(error: Error) => void>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private ready = false;
  private baseTime = 0;
  private baseMonotonic = 0;
  private onReady?: () => void;
  private onReadyError?: (error: Error) => void;
  private closeListeners = new Set<(error: Error) => void>();
  private routeListeners = new Set<(route: Route) => void>();
  private metricListeners = new Set<(metrics: FileTransportMetrics) => void>();
  private traffic: Record<Route, FileTraffic> = {
    relay: { sent: 0, received: 0, sendRate: 0, receiveRate: 0 },
    direct: { sent: 0, received: 0, sendRate: 0, receiveRate: 0 },
  };
  private previousTraffic: Record<Route, { sent: number; received: number }> = {
    relay: { sent: 0, received: 0 },
    direct: { sent: 0, received: 0 },
  };
  private metricsTimer = 0;
  private lastMeter = 0;
  private relayLatency?: number;
  private directLatency?: number;
  private tailscaleCandidate?: "possible" | "other" | "unknown";
  private direct?: FileDirect;
  private directTimer = 0;
  private activeRoute: Route = "relay";
  private epoch = 1;
  get route(): Route {
    return this.activeRoute;
  }
  private constructor(
    readonly workspace: Workspace,
    private readonly allowDirect: boolean,
  ) {}

  static async connect(
    workspace: Workspace,
    signal?: AbortSignal,
    allowDirect = true,
  ): Promise<FileClient> {
    if (signal?.aborted) throw new DOMException("已取消", "AbortError");
    const client = new FileClient(workspace, allowDirect);
    const ticket = await api<{ ticket: string }>(
      `/workspaces/${encodeURIComponent(workspace.id)}/connections`,
      { method: "POST", body: "{}", signal },
    );
    if (signal?.aborted) throw new DOMException("已取消", "AbortError");
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${scheme}//${location.host}/api/workspaces/${encodeURIComponent(workspace.id)}/ws`;
    const socket = new WebSocket(url, `workdeck-file-ticket.${ticket.ticket}`);
    client.socket = socket;
    socket.binaryType = "arraybuffer";
    const connected = new Promise<void>((resolve, reject) => {
      client.onReady = resolve;
      client.onReadyError = reject;
    });
    socket.onmessage = (event) => client.receive("relay", "relay", event.data);
    socket.onerror = () =>
      client.fail(new FileServiceError("CONNECTION_LOST", "文件连接中断"));
    socket.onclose = () =>
      client.fail(new FileServiceError("CONNECTION_LOST", "文件连接已关闭"));
    const abort = () => client.fail(new DOMException("已取消", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(
      () =>
        client.fail(new FileServiceError("CONNECTION_LOST", "文件连接超时")),
      20000,
    );
    try {
      await connected;
      return client;
    } catch (error) {
      client.close();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  onRoute(listener: (route: Route) => void): () => void {
    this.routeListeners.add(listener);
    return () => this.routeListeners.delete(listener);
  }
  onMetrics(listener: (metrics: FileTransportMetrics) => void): () => void {
    this.metricListeners.add(listener);
    this.publishMetrics();
    return () => this.metricListeners.delete(listener);
  }
  private publishMetrics(): void {
    const value: FileTransportMetrics = {
      route: this.activeRoute,
      tailscaleCandidate: this.tailscaleCandidate,
      relayLatency: this.relayLatency,
      directLatency: this.directLatency,
      adaptiveDelayMs: terminalPressureDelay(this.workspace.terminal_id),
      traffic: {
        relay: { ...this.traffic.relay },
        direct: { ...this.traffic.direct },
      },
    };
    for (const listener of this.metricListeners) listener(value);
  }
  close(): void {
    this.fail(new FileServiceError("CONNECTION_LOST", "文件连接已关闭"), true);
  }
  private fail(error: Error, intentional = false): void {
    if (this.closed) return;
    this.closed = true;
    if (this.directTimer) clearTimeout(this.directTimer);
    if (!intentional && this.activeRoute === "direct") this.direct?.penalize();
    this.direct?.close();
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.ready = false;
    for (const reject of this.paceWaiters) reject(error);
    this.paceWaiters.clear();
    this.onReadyError?.(error);
    this.onReady = undefined;
    this.onReadyError = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING)
      this.socket.close();
    for (const listener of this.closeListeners) listener(error);
  }
  private receive(
    route: Route,
    channel: "relay" | "control" | "data",
    data: unknown,
  ): void {
    try {
      if (
        route === "direct" &&
        ((channel === "control" && typeof data !== "string") ||
          (channel === "data" && !(data instanceof ArrayBuffer)))
      )
        throw new Error("文件通道消息类型无效");
      if (data instanceof ArrayBuffer) {
        this.traffic[route].received += data.byteLength;
        const chunk = decodeChunk(data),
          pending = this.pending.get(chunk.requestID);
        if (chunk.epoch < this.epoch) return;
        if (
          !pending ||
          pending.expectedOffset === undefined ||
          pending.data ||
          chunk.epoch !== pending.epoch ||
          pending.route !== route ||
          chunk.offset !== pending.expectedOffset
        )
          throw new Error("意外的文件数据块");
        pending.data = chunk.data;
        if (pending.control) {
          if (pending.control.bytes !== chunk.data.length)
            throw new Error("文件块确认长度不一致");
          this.pending.delete(chunk.requestID);
          clearTimeout(pending.timer);
          pending.resolve({ value: pending.control.value, data: chunk.data });
        }
        return;
      }
      if (
        typeof data !== "string" ||
        new TextEncoder().encode(data).byteLength > MAX_CONTROL
      )
        throw new Error("文件消息无效");
      const message = JSON.parse(data) as Envelope;
      if (
        message.version !== 1 ||
        message.workspace_id !== this.workspace.id ||
        message.root_revision !== this.workspace.root_revision ||
        !/^[0-9a-f]{48}$/.test(message.request_id)
      )
        throw new Error("文件消息不属于当前工作区");
      const payload = message.payload as WireResult;
      if (!payload || typeof payload !== "object")
        throw new Error("文件消息内容无效");
      if (message.type === "file.rtc.answer" && route === "relay") {
        this.direct?.answer((payload.result as { sdp?: unknown })?.sdp);
        return;
      }
      if (message.type === "file.rtc.unavailable" && route === "relay") {
        this.direct?.unavailable();
        return;
      }
      if (message.type === "file.probe.reply") {
        this.direct?.reply(route, message);
        return;
      }
      if (message.route_epoch < this.epoch) return;
      if (message.type === "file.ready" && !this.ready) {
        const result = payload.result as
          | {
              node_time_ms?: number;
              route?: string;
              direct?: boolean;
              ice_servers?: string[];
            }
          | undefined;
        if (
          !Number.isSafeInteger(result?.node_time_ms) ||
          result!.node_time_ms! < 0 ||
          result!.route !== "relay" ||
          route !== "relay" ||
          message.route_epoch !== 1
        )
          throw new Error("节点连接信息无效");
        this.baseTime = result!.node_time_ms!;
        this.baseMonotonic = performance.now();
        this.ready = true;
        this.onReady?.();
        this.onReady = undefined;
        this.onReadyError = undefined;
        this.lastMeter = performance.now();
        this.metricsTimer = window.setInterval(() => {
          const now = performance.now(),
            elapsed = Math.max((now - this.lastMeter) / 1000, 0.001);
          this.lastMeter = now;
          for (const route of ["relay", "direct"] as const) {
            const current = this.traffic[route],
              previous = this.previousTraffic[route];
            current.sendRate = Math.max(
              0,
              (current.sent - previous.sent) / elapsed,
            );
            current.receiveRate = Math.max(
              0,
              (current.received - previous.received) / elapsed,
            );
            previous.sent = current.sent;
            previous.received = current.received;
          }
          this.publishMetrics();
        }, 1000);
        if (
          this.allowDirect &&
          result?.direct === true &&
          Array.isArray(result.ice_servers) &&
          result.ice_servers.length <= 4 &&
          result.ice_servers.every(
            (url) =>
              typeof url === "string" &&
              url.startsWith("stun:") &&
              url.length < 256,
          )
        ) {
          const iceServers = result.ice_servers;
          // Let the caller request and render the tree over the ready relay
          // before starting optional WebRTC negotiation.
          this.directTimer = window.setTimeout(() => {
            if (this.closed || !this.ready) return;
            this.direct = new FileDirect({
              workspace: this.workspace,
              id: () => this.id(),
              epoch: () => this.epoch,
              route: () => this.activeRoute,
              busy: () => this.pending.size > 0,
              relay: (data) => this.sendWire("relay", "control", data),
              switchRoute: (target) => this.switchRoute(target),
              receive: (r, c, d) => this.receive(r, c, d),
              unavailable: (active) => {
                this.directLatency = undefined;
                this.tailscaleCandidate = undefined;
                this.publishMetrics();
                if (active)
                  this.fail(
                    new FileServiceError(
                      "CONNECTION_LOST",
                      "文件直连中断，正在恢复中转",
                    ),
                  );
              },
              candidateHint: (hint) => {
                if (hint !== this.tailscaleCandidate) {
                  this.tailscaleCandidate = hint;
                  this.publishMetrics();
                }
              },
              metrics: (relay, direct) => {
                this.relayLatency = relay ?? undefined;
                this.directLatency = direct ?? undefined;
                this.publishMetrics();
              },
            });
            void this.direct.start(iceServers);
          }, 500);
        }
        return;
      }
      const pending = this.pending.get(message.request_id);
      if (
        !pending ||
        message.type !== pending.responseType ||
        pending.epoch !== message.route_epoch ||
        pending.route !== route ||
        pending.control
      )
        throw new Error("意外的文件响应");
      if (payload.error) {
        this.pending.delete(message.request_id);
        clearTimeout(pending.timer);
        pending.reject(
          new FileServiceError(
            payload.error.code || "IO_ERROR",
            payload.error.message || "文件操作失败",
          ),
        );
        return;
      }
      if (pending.expectedOffset !== undefined) {
        const result = payload.result as { bytes?: number } | undefined;
        if (
          !Number.isInteger(result?.bytes) ||
          result!.bytes! < 0 ||
          result!.bytes! > (pending.expectedLength ?? MAX_CHUNK) ||
          (pending.data !== undefined && result!.bytes! !== pending.data.length)
        )
          throw new Error("文件块确认长度不一致");
        if (result!.bytes! > 0 && !pending.data) {
          pending.control = { value: payload.result, bytes: result!.bytes! };
          return;
        }
      }
      this.pending.delete(message.request_id);
      clearTimeout(pending.timer);
      pending.resolve({ value: payload.result, data: pending.data });
    } catch {
      this.fail(new FileServiceError("PROTOCOL_ERROR", "文件连接收到无效消息"));
    }
  }
  private id(): string {
    if (!this.ready || this.closed)
      throw new FileServiceError("CONNECTION_LOST", "文件连接未就绪");
    return makeID(
      Math.floor(this.baseTime + performance.now() - this.baseMonotonic),
    );
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private request(
    type: string,
    payload: unknown,
    options: {
      id?: string;
      binary?: ArrayBuffer;
      expectedOffset?: number;
      expectedLength?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ value: unknown; data?: Uint8Array }> {
    const paced = type === "file.read.chunk" || type === "file.write.chunk";
    return (
      paced ? this.waitForTerminal(options.signal) : Promise.resolve()
    ).then(() =>
      this.serial(() => {
        if (options.signal?.aborted)
          throw new DOMException("已取消", "AbortError");
        return this.dispatch(type, payload, options);
      }),
    );
  }
  private waitForTerminal(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted)
      return Promise.reject(new DOMException("已取消", "AbortError"));
    if (this.closed)
      return Promise.reject(
        new FileServiceError("CONNECTION_LOST", "文件连接已关闭"),
      );
    const delay = terminalPressureDelay(this.workspace.terminal_id);
    if (!delay) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.paceWaiters.delete(failed);
        if (error) reject(error);
        else resolve();
      };
      const failed = (error: Error) => finish(error);
      const aborted = () => finish(new DOMException("已取消", "AbortError"));
      const timer = window.setTimeout(() => finish(), delay);
      this.paceWaiters.add(failed);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
  private dispatch(
    type: string,
    payload: unknown,
    options: {
      id?: string;
      binary?: ArrayBuffer;
      expectedOffset?: number;
      expectedLength?: number;
    } = {},
  ): Promise<{ value: unknown; data?: Uint8Array }> {
    return new Promise((resolve, reject) => {
      if (
        !this.ready ||
        this.closed ||
        this.socket.readyState !== WebSocket.OPEN
      ) {
        reject(new FileServiceError("CONNECTION_LOST", "文件连接未就绪"));
        return;
      }
      const id = options.id || this.id();
      if (this.pending.has(id)) {
        reject(new FileServiceError("BUSY", "文件请求标识重复"));
        return;
      }
      const timer = window.setTimeout(
        () =>
          this.fail(
            new FileServiceError("CONNECTION_LOST", "文件操作超时，连接已关闭"),
          ),
        30000,
      );
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        expectedOffset: options.expectedOffset,
        expectedLength: options.expectedLength,
        responseType: options.binary ? "file.write.progress" : "result",
        route: this.activeRoute,
        epoch: this.epoch,
      });
      try {
        if (options.binary) {
          new DataView(options.binary).setUint32(44, this.epoch);
          this.sendWire(this.activeRoute, "data", options.binary);
        } else
          this.sendWire(
            this.activeRoute,
            "control",
            encodeControl({
              version: 1,
              type,
              request_id: id,
              workspace_id: this.workspace.id,
              root_revision: this.workspace.root_revision,
              route_epoch: this.epoch,
              payload,
            }),
          );
      } catch {
        this.fail(new FileServiceError("CONNECTION_LOST", "发送文件请求失败"));
      }
    });
  }
  private sendWire(
    route: Route,
    kind: "control" | "data",
    data: string | ArrayBuffer,
  ): void {
    if (route === "relay") {
      if (this.socket.readyState !== WebSocket.OPEN)
        throw new Error("relay closed");
      this.socket.send(data);
      if (data instanceof ArrayBuffer)
        this.traffic[route].sent += data.byteLength;
      return;
    }
    if (!this.direct) throw new Error("direct unavailable");
    this.direct.send(kind, data);
    if (data instanceof ArrayBuffer)
      this.traffic[route].sent += data.byteLength;
  }
  private switchRoute(target: Route): Promise<void> {
    return this.serial(async () => {
      if (this.closed || target === this.activeRoute) return;
      try {
        const next = this.epoch + 1;
        if (next > 0xffffffff) throw new Error("链路代次耗尽");
        const reply = (
          await this.dispatch("file.route", { route: target, epoch: next })
        ).value as { route?: string; epoch?: number };
        if (reply?.route !== target || reply.epoch !== next)
          throw new FileServiceError("PROTOCOL_ERROR", "文件链路切换确认无效");
        this.activeRoute = target;
        this.epoch = next;
        for (const listener of this.routeListeners) listener(target);
        this.publishMetrics();
      } catch (e) {
        this.direct?.penalize();
        this.fail(
          new FileServiceError(
            "CONNECTION_LOST",
            "文件链路切换未确认，正在恢复中转",
          ),
        );
        throw e;
      }
    });
  }

  async list(
    path: string,
    hidden = false,
    filter = "",
    snapshot = "",
    offset = 0,
  ): Promise<DirectoryPage> {
    return (
      await this.request("directory.list", {
        path,
        hidden,
        filter,
        snapshot,
        offset,
      })
    ).value as DirectoryPage;
  }
  async openWatch(paths: string[]): Promise<void> {
    await this.request("watch.open", { paths });
  }
  async pollWatch(
    timeoutMS: number,
  ): Promise<{ generation: number; changed: boolean; reset: boolean }> {
    const result = (await this.request("watch.poll", { timeout_ms: timeoutMS }))
      .value as { generation?: unknown; changed?: unknown; reset?: unknown };
    if (
      !result ||
      !Number.isSafeInteger(result.generation) ||
      (result.generation as number) < 1 ||
      typeof result.changed !== "boolean" ||
      typeof result.reset !== "boolean"
    )
      throw new FileServiceError("PROTOCOL_ERROR", "监听响应无效");
    return result as { generation: number; changed: boolean; reset: boolean };
  }
  async stat(path: string): Promise<FileEntry> {
    return (await this.request("file.stat", { path })).value as FileEntry;
  }
  async openRead(
    path: string,
    version = "",
  ): Promise<{ id: string; entry: FileEntry }> {
    const id = this.id();
    const result = await this.request(
      "file.read.open",
      { path, version },
      { id },
    );
    return { id, entry: result.value as FileEntry };
  }
  async readChunk(
    readID: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(length) ||
      length < 0 ||
      length > MAX_CHUNK
    )
      throw new FileServiceError("INVALID_RANGE", "读取范围无效");
    const result = await this.request(
      "file.read.chunk",
      { read_id: readID, offset, length },
      { expectedOffset: offset, expectedLength: length, signal },
    );
    return result.data || new Uint8Array();
  }
  async closeRead(readID: string): Promise<void> {
    await this.request("file.read.close", { read_id: readID });
  }
  async readBytes(
    path: string,
    version = "",
    limit = 5 * 1024 * 1024,
  ): Promise<{ entry: FileEntry; bytes: Uint8Array }> {
    const read = await this.openRead(path, version);
    try {
      if (
        !Number.isSafeInteger(read.entry.size) ||
        read.entry.size < 0 ||
        read.entry.size > limit
      )
        throw new FileServiceError(
          "FILE_TOO_LARGE",
          "文件超出当前预览大小限制",
        );
      const bytes = new Uint8Array(read.entry.size);
      for (let offset = 0; offset < bytes.length; ) {
        const chunk = await this.readChunk(
          read.id,
          offset,
          Math.min(MAX_CHUNK, bytes.length - offset),
        );
        if (!chunk.length)
          throw new FileServiceError("PROTOCOL_ERROR", "文件读取提前结束");
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return { entry: read.entry, bytes };
    } finally {
      if (!this.closed) await this.closeRead(read.id).catch(() => {});
    }
  }
  async prepareSave(
    path: string,
    content: Uint8Array,
    baseVersion: string,
    create = false,
  ): Promise<SaveTransaction> {
    const snapshot = content.slice();
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", snapshot),
    );
    return {
      opID: this.id(),
      spec: {
        path,
        base_version: baseVersion,
        size: snapshot.length,
        sha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(
          "",
        ),
        create,
      },
      content: snapshot,
    };
  }
  async prepareUpload(
    path: string,
    file: File,
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ): Promise<UploadTransaction> {
    const digest = await hashBlob(file, signal, onProgress);
    checkTransferAbort(signal);
    return {
      opID: this.id(),
      spec: { path, size: file.size, sha256: digest, create: true },
      sourceName: file.name,
    };
  }
  async upload(
    transaction: UploadTransaction,
    file: File,
    options: {
      signal?: AbortSignal;
      onHash?: (done: number, total: number) => void;
      onProgress?: (done: number, total: number) => void;
      onBegin?: () => void;
    } = {},
  ): Promise<FileOperation> {
    const { signal, onHash, onProgress } = options;
    if (
      file.size !== transaction.spec.size ||
      (await hashBlob(file, signal, onHash)) !== transaction.spec.sha256
    )
      throw new FileServiceError(
        "SOURCE_MISMATCH",
        "所选文件与原上传文件不一致",
      );
    checkTransferAbort(signal);
    options.onBegin?.();
    let op = this.checkOperation(
      (
        await this.request("file.write.begin", {
          op_id: transaction.opID,
          spec: transaction.spec,
        })
      ).value,
      transaction.opID,
    );
    if (op.state === "committed") {
      if (!op.version)
        throw new FileServiceError("PROTOCOL_ERROR", "节点未返回文件版本");
      return op;
    }
    if (
      (op.state !== "receiving" && op.state !== "ready") ||
      op.offset > file.size
    )
      throw new FileServiceError("INVALID_STATE", "此上传操作无法继续");
    onProgress?.(op.offset, file.size);
    while (op.offset < file.size) {
      checkTransferAbort(signal);
      const start = op.offset;
      const bytes = new Uint8Array(
        await file.slice(start, start + MAX_CHUNK).arrayBuffer(),
      );
      checkTransferAbort(signal);
      op = this.checkOperation(
        (
          await this.request("file.write.chunk", null, {
            id: transaction.opID,
            binary: encodeChunk(transaction.opID, start, 1, bytes),
            signal,
          })
        ).value,
        transaction.opID,
      );
      if (
        op.offset !== start + bytes.length ||
        (op.state !== "receiving" && op.state !== "ready")
      )
        throw new FileServiceError("PROTOCOL_ERROR", "节点返回的上传确认无效");
      onProgress?.(op.offset, file.size);
    }
    checkTransferAbort(signal);
    if (op.state !== "ready")
      throw new FileServiceError("NOT_READY", "文件内容尚未得到完整确认");
    op = this.checkOperation(
      (await this.request("file.write.commit", { op_id: transaction.opID }))
        .value,
      transaction.opID,
    );
    if (op.state !== "committed" || !op.version)
      throw new FileServiceError("PROTOCOL_ERROR", "节点未确认文件提交");
    return op;
  }
  async abortUpload(transaction: UploadTransaction): Promise<FileOperation> {
    const op = this.checkOperation(
      (
        await this.request("file.write.begin", {
          op_id: transaction.opID,
          spec: transaction.spec,
        })
      ).value,
      transaction.opID,
    );
    if (op.state === "committed" || op.state === "aborted") return op;
    return this.checkOperation(
      (await this.request("file.write.abort", { op_id: transaction.opID }))
        .value,
      transaction.opID,
    );
  }
  newOperationID(): string {
    return this.id();
  }
  async pendingWrites(
    offset: number,
  ): Promise<{ items: PendingWrite[]; next: number; has_more: boolean }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 16)
      throw new FileServiceError("INVALID_RANGE", "待处理写入分页无效");
    const result = (await this.request("operation.pending.list", { offset }))
      .value as { items?: PendingWrite[]; next?: number; has_more?: boolean };
    if (
      !result ||
      !Array.isArray(result.items) ||
      result.items.length > 1 ||
      result.next !== offset + result.items.length ||
      typeof result.has_more !== "boolean" ||
      (result.has_more && result.items.length !== 1)
    )
      throw new FileServiceError("PROTOCOL_ERROR", "待处理写入分页无效");
    for (const item of result.items) {
      if (
        !item ||
        typeof item.id !== "string" ||
        !/^[0-9a-f]{48}$/.test(item.id)
      )
        throw new FileServiceError("PROTOCOL_ERROR", "待处理写入标识无效");
      this.checkOperation(item, item.id);
      if (
        !["receiving", "ready", "committing", "uncertain"].includes(
          item.state,
        ) ||
        typeof item.path !== "string" ||
        !item.path ||
        new TextEncoder().encode(item.path).length > 4096 ||
        !Number.isSafeInteger(item.size) ||
        item.size < 0 ||
        item.offset > item.size ||
        typeof item.create !== "boolean" ||
        !Number.isSafeInteger(item.updated_at) ||
        item.updated_at < 1
      )
        throw new FileServiceError("PROTOCOL_ERROR", "待处理写入记录无效");
    }
    return result as { items: PendingWrite[]; next: number; has_more: boolean };
  }
  async cancelPendingWrite(item: PendingWrite): Promise<FileOperation> {
    this.checkOperation(item, item.id);
    if (
      !/^[0-9a-f]{48}$/.test(item.id) ||
      !["receiving", "ready"].includes(item.state) ||
      !Number.isSafeInteger(item.updated_at) ||
      item.updated_at < 1
    )
      throw new FileServiceError("INVALID_STATE", "此写入不能安全取消");
    const result = this.checkOperation(
      (
        await this.request("operation.pending.cancel", {
          op_id: item.id,
          state: item.state,
          offset: item.offset,
          updated_at: item.updated_at,
        })
      ).value,
      item.id,
    );
    if (result.state !== "aborted")
      throw new FileServiceError("PROTOCOL_ERROR", "节点未确认取消");
    return result;
  }
  async operationStatus(
    opID: string,
    kind: "write" | "directory.create" | "entry.rename" = "write",
  ): Promise<FileOperation> {
    return this.checkOperation(
      (await this.request("operation.status", { op_id: opID })).value,
      opID,
      kind,
    );
  }
  async createDirectory(opID: string, path: string): Promise<FileOperation> {
    return this.checkOperation(
      (await this.request("directory.create", { op_id: opID, path })).value,
      opID,
      "directory.create",
    );
  }
  async rename(
    opID: string,
    source: string,
    target: string,
    version: string,
  ): Promise<FileOperation> {
    return this.checkOperation(
      (
        await this.request("entry.rename", {
          op_id: opID,
          source,
          target,
          version,
        })
      ).value,
      opID,
      "entry.rename",
    );
  }
  async prepareDelete(
    opID: string,
    path: string,
    version: string,
    recursive: boolean,
  ): Promise<DeleteStatus> {
    const value = (
      await this.request("entry.delete.prepare", {
        op_id: opID,
        path,
        version,
        recursive,
      })
    ).value;
    return this.checkDelete(value, opID);
  }
  async commitDelete(opID: string): Promise<DeleteStatus> {
    return this.checkDelete(
      (await this.request("entry.delete.commit", { op_id: opID })).value,
      opID,
    );
  }
  async cancelDelete(opID: string): Promise<DeleteStatus> {
    return this.checkDelete(
      (await this.request("entry.delete.cancel", { op_id: opID })).value,
      opID,
    );
  }
  async deleteStatus(opID: string): Promise<DeleteStatus> {
    return this.checkDelete(
      (await this.request("entry.delete.status", { op_id: opID })).value,
      opID,
    );
  }
  async deleteOutcomes(
    opID: string,
    offset: number,
  ): Promise<{ items: DeleteOutcome[]; next: number }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 8192)
      throw new FileServiceError("INVALID_RANGE", "删除结果分页无效");
    const value = (
      await this.request("entry.delete.outcomes", {
        op_id: opID,
        offset,
        limit: 64,
      })
    ).value as { items?: DeleteOutcome[]; next?: number };
    return this.checkOutcomes(value, offset);
  }
  private checkOutcomes(
    value: { items?: DeleteOutcome[]; next?: number },
    offset: number,
  ): { items: DeleteOutcome[]; next: number } {
    if (
      !value ||
      !Array.isArray(value.items) ||
      value.items.length > 64 ||
      value.items.some(
        (item) =>
          !item ||
          typeof item.path !== "string" ||
          new TextEncoder().encode(item.path).length > 4096 ||
          !["file", "directory", "symlink"].includes(item.kind) ||
          ![
            "pending",
            "moving",
            "removing",
            "deleted",
            "skipped",
            "uncertain",
          ].includes(item.state) ||
          (item.error !== undefined &&
            (typeof item.error?.code !== "string" ||
              typeof item.error?.message !== "string")),
      ) ||
      !Number.isSafeInteger(value.next) ||
      value.next !== offset + value.items.length
    )
      throw new FileServiceError("PROTOCOL_ERROR", "删除结果分页无效");
    return value as { items: DeleteOutcome[]; next: number };
  }
  async archivedOperationStatus(
    opID: string,
    previousRevision: number,
  ): Promise<ArchivedOperation> {
    if (
      !Number.isSafeInteger(previousRevision) ||
      previousRevision < 1 ||
      previousRevision >= this.workspace.root_revision
    )
      throw new FileServiceError("INVALID_RANGE", "旧工作区修订无效");
    const value = (
      await this.request("operation.archive.status", {
        op_id: opID,
        previous_revision: previousRevision,
      })
    ).value as ArchivedOperation;
    if (
      !value ||
      !["write", "directory.create", "entry.rename", "entry.delete"].includes(
        value.kind,
      )
    )
      throw new FileServiceError("PROTOCOL_ERROR", "旧操作类型无效");
    this.checkOperation(
      value,
      opID,
      value.kind as
        | "write"
        | "directory.create"
        | "entry.rename"
        | "entry.delete",
      previousRevision,
    );
    if (
      typeof value.path !== "string" ||
      new TextEncoder().encode(value.path).length > 4096 ||
      (value.source !== undefined &&
        (typeof value.source !== "string" ||
          new TextEncoder().encode(value.source).length > 4096)) ||
      (value.details_expired !== undefined &&
        typeof value.details_expired !== "boolean") ||
      (value.error !== undefined &&
        (typeof value.error?.code !== "string" ||
          typeof value.error?.message !== "string" ||
          value.error.code.length > 128 ||
          value.error.message.length > 4096)) ||
      ![
        "receiving",
        "ready",
        "committing",
        "committed",
        "conflict",
        "failed",
        "aborted",
        "uncertain",
        "prepared",
        "deleting",
        "partial",
      ].includes(value.state)
    )
      throw new FileServiceError("PROTOCOL_ERROR", "旧操作记录无效");
    if (
      value.kind === "write" &&
      (!value.write ||
        value.write.path !== value.path ||
        !Number.isSafeInteger(value.write.size) ||
        value.write.size < 0 ||
        typeof value.write.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.write.sha256) ||
        (value.write.create !== undefined &&
          typeof value.write.create !== "boolean") ||
        (value.write.base_version !== undefined &&
          typeof value.write.base_version !== "string"))
    )
      throw new FileServiceError("PROTOCOL_ERROR", "旧写入记录无效");
    if (
      value.kind === "entry.delete" &&
      value.recursive !== undefined &&
      typeof value.recursive !== "boolean"
    )
      throw new FileServiceError("PROTOCOL_ERROR", "旧删除范围无效");
    if (value.kind === "entry.delete" && value.delete) {
      const detail = this.checkDelete(value.delete, opID, previousRevision);
      if (
        detail.path !== value.path ||
        detail.state !== value.state ||
        detail.recursive !== !!value.recursive
      )
        throw new FileServiceError("PROTOCOL_ERROR", "旧删除记录不一致");
    }
    return value;
  }
  async archivedDeleteOutcomes(
    opID: string,
    previousRevision: number,
    offset: number,
  ): Promise<{ items: DeleteOutcome[]; next: number }> {
    if (
      !Number.isSafeInteger(previousRevision) ||
      previousRevision < 1 ||
      previousRevision >= this.workspace.root_revision ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 8192
    )
      throw new FileServiceError("INVALID_RANGE", "旧删除结果分页无效");
    const value = (
      await this.request("operation.archive.delete.outcomes", {
        op_id: opID,
        previous_revision: previousRevision,
        offset,
        limit: 64,
      })
    ).value as { items?: DeleteOutcome[]; next?: number };
    return this.checkOutcomes(value, offset);
  }
  private checkDelete(
    value: unknown,
    opID: string,
    revision = this.workspace.root_revision,
  ): DeleteStatus {
    const operation = this.checkOperation(
      value,
      opID,
      "entry.delete",
      revision,
    ) as DeleteStatus;
    if (
      typeof operation.path !== "string" ||
      ![
        "prepared",
        "deleting",
        "committed",
        "partial",
        "aborted",
        "uncertain",
      ].includes(operation.state) ||
      typeof operation.recursive !== "boolean" ||
      !Number.isSafeInteger(operation.count) ||
      operation.count < 1 ||
      operation.count > 8192 ||
      !Number.isSafeInteger(operation.directories) ||
      operation.directories < 0 ||
      operation.directories > operation.count ||
      !Number.isSafeInteger(operation.bytes) ||
      operation.bytes < 0
    )
      throw new FileServiceError("PROTOCOL_ERROR", "删除预览无效");
    for (const count of [
      operation.deleted,
      operation.skipped,
      operation.pending,
      operation.uncertain,
    ])
      if (
        count !== undefined &&
        (!Number.isSafeInteger(count) || count < 0 || count > operation.count)
      )
        throw new FileServiceError("PROTOCOL_ERROR", "删除结果数量无效");
    if (
      [
        operation.deleted,
        operation.skipped,
        operation.pending,
        operation.uncertain,
      ].some((n) => n !== undefined) &&
      (operation.deleted === undefined ||
        operation.skipped === undefined ||
        operation.pending === undefined ||
        operation.uncertain === undefined ||
        operation.deleted +
          operation.skipped +
          operation.pending +
          operation.uncertain !==
          operation.count)
    )
      throw new FileServiceError("PROTOCOL_ERROR", "删除结果总数不一致");
    return operation;
  }
  private checkOperation(
    value: unknown,
    opID: string,
    kind:
      | "write"
      | "directory.create"
      | "entry.rename"
      | "entry.delete" = "write",
    revision = this.workspace.root_revision,
  ): FileOperation {
    const op = value as FileOperation | undefined;
    if (
      !op ||
      op.id !== opID ||
      op.workspace_id !== this.workspace.id ||
      op.root_revision !== revision ||
      op.kind !== kind ||
      !Number.isSafeInteger(op.offset) ||
      op.offset < 0 ||
      typeof op.state !== "string"
    )
      throw new FileServiceError("PROTOCOL_ERROR", "节点返回的保存状态无效");
    return op;
  }
  async abortSave(transaction: SaveTransaction): Promise<FileOperation> {
    const operation = this.checkOperation(
      (
        await this.request("file.write.begin", {
          op_id: transaction.opID,
          spec: transaction.spec,
        })
      ).value,
      transaction.opID,
    );
    if (operation.state === "committed" || operation.state === "aborted")
      return operation;
    if (operation.state !== "receiving" && operation.state !== "ready")
      throw new FileServiceError("INVALID_STATE", "保存结果尚不能安全取消");
    return this.checkOperation(
      (await this.request("file.write.abort", { op_id: transaction.opID }))
        .value,
      transaction.opID,
    );
  }
  async save(
    transaction: SaveTransaction,
    onProgress?: (done: number, total: number) => void,
  ): Promise<FileOperation> {
    try {
      let op = this.checkOperation(
        (
          await this.request("file.write.begin", {
            op_id: transaction.opID,
            spec: transaction.spec,
          })
        ).value,
        transaction.opID,
      );
      if (op.state === "committed") {
        if (!op.version)
          throw new FileServiceError("PROTOCOL_ERROR", "节点未返回文件版本");
        return op;
      }
      if (op.state !== "receiving" && op.state !== "ready")
        throw new FileServiceError("INVALID_STATE", "此保存操作无法继续");
      if (
        !Number.isSafeInteger(op.offset) ||
        op.offset < 0 ||
        op.offset > transaction.content.length
      )
        throw new FileServiceError("PROTOCOL_ERROR", "节点返回的上传偏移无效");
      onProgress?.(op.offset, transaction.content.length);
      while (op.offset < transaction.content.length) {
        const start = op.offset,
          chunk = transaction.content.subarray(
            start,
            Math.min(start + MAX_CHUNK, transaction.content.length),
          );
        op = this.checkOperation(
          (
            await this.request("file.write.chunk", null, {
              id: transaction.opID,
              binary: encodeChunk(transaction.opID, start, 1, chunk),
            })
          ).value,
          transaction.opID,
        );
        if (
          op.offset !== start + chunk.length ||
          (op.state !== "receiving" && op.state !== "ready")
        )
          throw new FileServiceError(
            "PROTOCOL_ERROR",
            "节点返回的上传确认无效",
          );
        onProgress?.(op.offset, transaction.content.length);
      }
      if (op.state !== "ready")
        throw new FileServiceError("NOT_READY", "文件内容尚未得到完整确认");
      const committed = this.checkOperation(
        (await this.request("file.write.commit", { op_id: transaction.opID }))
          .value,
        transaction.opID,
      );
      if (committed.state !== "committed" || !committed.version)
        throw new FileServiceError("PROTOCOL_ERROR", "节点未确认文件提交");
      return committed;
    } catch (error) {
      if (
        error instanceof FileServiceError &&
        (error.code === "CONNECTION_LOST" || error.code === "PROTOCOL_ERROR")
      )
        throw new UncertainSaveError(transaction, error.message);
      throw error;
    }
  }
}
