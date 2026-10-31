import { useEffect, useState } from "react";
import type { FileClient } from "../../services/files/client";
import { MAX_CHUNK } from "../../services/files/protocol";
import type { BinaryPreview } from "./use-workspace";

const PAGE_BYTES = 256 * 1024;

export function LargeTextPreview({
  client,
  preview,
  onDownload,
}: {
  client: FileClient;
  preview: BinaryPreview;
  onDownload: () => void;
}) {
  const [page, setPage] = useState(0);
  const [jump, setJump] = useState("1");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const pages = Math.max(1, Math.ceil(preview.size / PAGE_BYTES));
  useEffect(() => {
    const abort = new AbortController();
    let canceled = false;
    setLoading(true);
    setError("");
    setText("");
    setJump(String(page + 1));
    void (async () => {
      let id = "";
      try {
        const read = await client.openRead(preview.path, preview.version);
        id = read.id;
        if (canceled) return;
        const start = page * PAGE_BYTES;
        // Include up to three continuation bytes past the page boundary so a
        // UTF-8 character belongs wholly to exactly one page.
        const length = Math.min(
          PAGE_BYTES + 3,
          Math.max(0, preview.size - start),
        );
        const bytes = new Uint8Array(length);
        for (let offset = 0; offset < length; ) {
          const chunk = await client.readChunk(
            id,
            start + offset,
            Math.min(MAX_CHUNK, length - offset),
            abort.signal,
          );
          if (!chunk.length) throw new Error("文件读取提前结束");
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        let begin = 0,
          end = Math.min(PAGE_BYTES, bytes.length);
        if (page > 0)
          while (
            begin < Math.min(3, bytes.length) &&
            (bytes[begin] & 0xc0) === 0x80
          )
            begin++;
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
        const slice = bytes.subarray(begin, end);
        if (slice.includes(0))
          throw new Error("此文件不是可预览的 UTF-8 文本，请下载后查看");
        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: page > 0,
          }).decode(slice);
        } catch {
          throw new Error("此文件不是有效的 UTF-8 文本，请下载后查看");
        }
        if (!canceled) setText(decoded);
      } catch (e) {
        if (!canceled) setError((e as Error).message);
      } finally {
        if (id) await client.closeRead(id).catch(() => {});
        if (!canceled) setLoading(false);
      }
    })();
    return () => {
      canceled = true;
      abort.abort();
    };
  }, [client, preview.path, preview.version, preview.size, page]);
  return (
    <div className="large-text-preview">
      <div className="large-text-toolbar">
        <span>
          文件超过 5 MiB，仅提供只读分段预览。已有草稿仍可从左侧恢复。
        </span>
        <button type="button" onClick={onDownload}>
          下载文件
        </button>
        <button
          type="button"
          disabled={loading || page === 0}
          onClick={() => setPage(page - 1)}
        >
          上一段
        </button>
        <button
          type="button"
          disabled={loading || page + 1 >= pages}
          onClick={() => setPage(page + 1)}
        >
          下一段
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const n = Number(jump);
            if (Number.isSafeInteger(n) && n >= 1 && n <= pages) setPage(n - 1);
          }}
        >
          <label>
            段{" "}
            <input
              type="number"
              min={1}
              max={pages}
              value={jump}
              onChange={(event) => setJump(event.target.value)}
            />
          </label>
          <span> / {pages}</span>
          <button type="submit" disabled={loading}>
            跳转
          </button>
        </form>
      </div>
      {loading ? (
        <div className="workbench-empty">正在读取文件片段…</div>
      ) : error ? (
        <div className="workbench-empty" role="alert">
          {error}
        </div>
      ) : (
        <pre className="large-text-content">{text}</pre>
      )}
    </div>
  );
}
