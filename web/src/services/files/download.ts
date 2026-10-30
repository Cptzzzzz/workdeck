import { FileClient, FileServiceError } from "./client";
import { MAX_CHUNK } from "./protocol";
import { checkTransferAbort } from "./transfer";
import { api } from "../api";

const BLOB_LIMIT = 20 * 1024 * 1024;
type Writable = {
  write: (bytes: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
};
type Picker = (options: {
  suggestedName: string;
}) => Promise<{ createWritable: () => Promise<Writable> }>;

// Invoke directly from a user click: the browser requires transient activation
// for its save picker. In browsers without it, cap the in-memory fallback.
export async function downloadFile(
  client: FileClient,
  path: string,
  signal?: AbortSignal,
  progress?: (done: number, total: number) => void,
  onBrowserDownload?: () => void,
): Promise<void> {
  const name = path.split("/").pop() || "download";
  const picker = (window as Window & { showSaveFilePicker?: Picker })
    .showSaveFilePicker;
  const handle = picker
    ? await picker.call(window, { suggestedName: name })
    : undefined;
  checkTransferAbort(signal);
  const read = await client.openRead(path);
  let writable: Writable | undefined;
  let closed = false;
  try {
    if (!Number.isSafeInteger(read.entry.size) || read.entry.size < 0)
      throw new FileServiceError("PROTOCOL_ERROR", "文件大小无效");
    if (!handle) {
      if (read.entry.size > BLOB_LIMIT) {
        if (!read.entry.version)
          throw new FileServiceError("PROTOCOL_ERROR", "文件版本无效");
        const ticket = await api<{ ticket: string }>(
          `/workspaces/${encodeURIComponent(client.workspace.id)}/downloads`,
          {
            method: "POST",
            body: JSON.stringify({
              path,
              version: read.entry.version,
              size: read.entry.size,
            }),
            signal,
          },
        );
        if (!/^[0-9a-f]{48}$/.test(ticket.ticket))
          throw new FileServiceError("PROTOCOL_ERROR", "下载凭证无效");
        checkTransferAbort(signal);
        const link = document.createElement("a");
        link.href = `/api/workspaces/${encodeURIComponent(client.workspace.id)}/downloads/${ticket.ticket}`;
        link.download = name;
        link.rel = "noreferrer";
        document.body.appendChild(link);
        link.click();
        link.remove();
        onBrowserDownload?.();
        return;
      }
      const bytes = new Uint8Array(read.entry.size);
      for (let offset = 0; offset < bytes.length; ) {
        checkTransferAbort(signal);
        const chunk = await client.readChunk(
          read.id,
          offset,
          Math.min(MAX_CHUNK, bytes.length - offset),
        );
        if (!chunk.length)
          throw new FileServiceError("PROTOCOL_ERROR", "文件读取提前结束");
        bytes.set(chunk, offset);
        offset += chunk.length;
        progress?.(offset, bytes.length);
      }
      checkTransferAbort(signal);
      const url = URL.createObjectURL(new Blob([bytes]));
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      return;
    }
    writable = await handle.createWritable();
    for (let offset = 0; offset < read.entry.size; ) {
      checkTransferAbort(signal);
      const chunk = await client.readChunk(
        read.id,
        offset,
        Math.min(MAX_CHUNK, read.entry.size - offset),
      );
      if (!chunk.length)
        throw new FileServiceError("PROTOCOL_ERROR", "文件读取提前结束");
      await writable.write(chunk);
      offset += chunk.length;
      progress?.(offset, read.entry.size);
    }
    checkTransferAbort(signal);
    await writable.close();
    closed = true;
  } finally {
    if (writable && !closed) await writable.abort().catch(() => {});
    await client.closeRead(read.id).catch(() => {});
  }
}
