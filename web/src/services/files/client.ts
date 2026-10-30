import { api } from "../api";
import { checkTransferAbort, hashBlob } from "./transfer";
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
  SaveTransaction,
  UploadTransaction,
  DeleteStatus,
  DeleteOutcome,
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
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private ready = false;
  private baseTime = 0;
  private baseMonotonic = 0;
  private onReady?: () => void;
  private onReadyError?: (error: Error) => void;
  private closeListeners = new Set<(error: Error) => void>();
  readonly route = "relay" as const;
  private constructor(readonly workspace: Workspace) {}

  static async connect(
    workspace: Workspace,
    signal?: AbortSignal,
  ): Promise<FileClient> {
    if (signal?.aborted) throw new DOMException("已取消", "AbortError");
    const client = new FileClient(workspace);
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
    socket.onmessage = (event) => client.receive(event.data);
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
  close(): void {
    this.fail(new FileServiceError("CONNECTION_LOST", "文件连接已关闭"));
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
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
  private receive(data: unknown): void {
    try {
      if (data instanceof ArrayBuffer) {
        const chunk = decodeChunk(data),
          pending = this.pending.get(chunk.requestID);
        if (
          !pending ||
          pending.expectedOffset === undefined ||
          pending.data ||
          chunk.epoch !== 1 ||
          chunk.offset !== pending.expectedOffset
        )
          throw new Error("意外的文件数据块");
        pending.data = chunk.data;
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
        message.route_epoch !== 1 ||
        !/^[0-9a-f]{48}$/.test(message.request_id)
      )
        throw new Error("文件消息不属于当前工作区");
      const payload = message.payload as WireResult;
      if (!payload || typeof payload !== "object")
        throw new Error("文件消息内容无效");
      if (message.type === "file.ready" && !this.ready) {
        const result = payload.result as
          | { node_time_ms?: number; route?: string }
          | undefined;
        if (
          !Number.isSafeInteger(result?.node_time_ms) ||
          result!.node_time_ms! < 0 ||
          result!.route !== "relay"
        )
          throw new Error("节点连接信息无效");
        this.baseTime = result!.node_time_ms!;
        this.baseMonotonic = performance.now();
        this.ready = true;
        this.onReady?.();
        this.onReady = undefined;
        this.onReadyError = undefined;
        return;
      }
      const pending = this.pending.get(message.request_id);
      if (!pending || message.type !== pending.responseType)
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
          result!.bytes! !== (pending.data?.length || 0)
        )
          throw new Error("文件块确认长度不一致");
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
    } = {},
  ): Promise<{ value: unknown; data?: Uint8Array }> {
    return this.serial(
      () =>
        new Promise((resolve, reject) => {
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
                new FileServiceError(
                  "CONNECTION_LOST",
                  "文件操作超时，连接已关闭",
                ),
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
          });
          try {
            if (options.binary) this.socket.send(options.binary);
            else
              this.socket.send(
                encodeControl({
                  version: 1,
                  type,
                  request_id: id,
                  workspace_id: this.workspace.id,
                  root_revision: this.workspace.root_revision,
                  route_epoch: 1,
                  payload,
                }),
              );
          } catch {
            this.fail(
              new FileServiceError("CONNECTION_LOST", "发送文件请求失败"),
            );
          }
        }),
    );
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
      { expectedOffset: offset, expectedLength: length },
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
  private checkDelete(value: unknown, opID: string): DeleteStatus {
    const operation = this.checkOperation(
      value,
      opID,
      "entry.delete",
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
  ): FileOperation {
    const op = value as FileOperation | undefined;
    if (
      !op ||
      op.id !== opID ||
      op.workspace_id !== this.workspace.id ||
      op.root_revision !== this.workspace.root_revision ||
      op.kind !== kind ||
      !Number.isSafeInteger(op.offset) ||
      op.offset < 0 ||
      typeof op.state !== "string"
    )
      throw new FileServiceError("PROTOCOL_ERROR", "节点返回的保存状态无效");
    return op;
  }
  async abortSave(transaction: SaveTransaction): Promise<FileOperation> {
    this.checkOperation(
      (
        await this.request("file.write.begin", {
          op_id: transaction.opID,
          spec: transaction.spec,
        })
      ).value,
      transaction.opID,
    );
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
