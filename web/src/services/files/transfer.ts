import { sha256 } from "@noble/hashes/sha256";

export const UPLOAD_LIMIT = 1024 * 1024 * 1024;
const HASH_CHUNK = 1024 * 1024;

export function checkTransferAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
}

// Web Crypto has no streaming digest API. Hash bounded slices so selecting a
// large local file does not allocate a second copy of the entire file.
export async function hashBlob(
  blob: Blob,
  signal?: AbortSignal,
  progress?: (done: number, total: number) => void,
): Promise<string> {
  if (blob.size > UPLOAD_LIMIT) throw new Error("文件超过 1 GiB 上传限制");
  const hash = sha256.create();
  try {
    checkTransferAbort(signal);
    progress?.(0, blob.size);
    for (let offset = 0; offset < blob.size; offset += HASH_CHUNK) {
      const bytes = new Uint8Array(
        await blob.slice(offset, offset + HASH_CHUNK).arrayBuffer(),
      );
      checkTransferAbort(signal);
      hash.update(bytes);
      progress?.(Math.min(offset + bytes.length, blob.size), blob.size);
    }
    return Array.from(hash.digest(), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  } finally {
    hash.destroy();
  }
}
