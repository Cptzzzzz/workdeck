// Resolve only workspace-relative references. Absolute, network, data, and
// escaping references are never fetched by previews.
export function relativeWorkspacePath(
  documentPath: string,
  reference: string,
): string | null {
  if (
    !reference ||
    reference.startsWith("#") ||
    /^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(reference) ||
    /[\u0000-\u001f\\]/.test(reference)
  )
    return null;
  const raw = reference.split(/[?#]/, 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (
    !decoded ||
    /[\u0000-\u001f\\]/.test(decoded) ||
    decoded.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(decoded)
  )
    return null;
  const parts = documentPath.split("/");
  parts.pop();
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  const resolved = parts.join("/");
  return resolved && resolved.length <= 4096 ? resolved : null;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024,
  MAX_IMAGE_DIMENSION = 8192,
  MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
function dimensions(
  bytes: Uint8Array,
): { type: string; width: number; height: number } | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const equal = (offset: number, value: number[]) =>
    value.every((b, i) => bytes[offset + i] === b);
  if (
    bytes.length >= 24 &&
    equal(0, [137, 80, 78, 71, 13, 10, 26, 10]) &&
    equal(12, [73, 72, 68, 82])
  )
    return {
      type: "image/png",
      width: v.getUint32(16),
      height: v.getUint32(20),
    };
  if (
    bytes.length >= 10 &&
    (equal(0, [71, 73, 70, 56, 55, 97]) || equal(0, [71, 73, 70, 56, 57, 97]))
  )
    return {
      type: "image/gif",
      width: v.getUint16(6, true),
      height: v.getUint16(8, true),
    };
  if (
    bytes.length >= 30 &&
    equal(0, [82, 73, 70, 70]) &&
    equal(8, [87, 69, 66, 80])
  ) {
    if (equal(12, [86, 80, 56, 88]))
      return {
        type: "image/webp",
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      };
    if (equal(12, [86, 80, 56, 76]) && bytes[20] === 0x2f) {
      const bits = v.getUint32(21, true);
      return {
        type: "image/webp",
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
    }
    if (equal(12, [86, 80, 56, 32]) && equal(23, [0x9d, 0x01, 0x2a]))
      return {
        type: "image/webp",
        width: v.getUint16(26, true) & 0x3fff,
        height: v.getUint16(28, true) & 0x3fff,
      };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 3 < bytes.length) {
      if (bytes[at++] !== 0xff) return null;
      while (at < bytes.length && bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) return null;
      const length = v.getUint16(at);
      if (length < 2 || at + length > bytes.length) return null;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker) &&
        length >= 7
      )
        return {
          type: "image/jpeg",
          height: v.getUint16(at + 3),
          width: v.getUint16(at + 5),
        };
      at += length;
    }
  }
  return null;
}
export async function safeImageBlob(bytes: Uint8Array): Promise<Blob> {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error("图片超过 20 MiB 预览限制");
  const info = dimensions(bytes);
  if (
    !info ||
    !info.width ||
    !info.height ||
    info.width > MAX_IMAGE_DIMENSION ||
    info.height > MAX_IMAGE_DIMENSION ||
    info.width * info.height > MAX_IMAGE_PIXELS
  )
    throw new Error("图片格式不支持或尺寸超出预览限制");
  const blob = new Blob([Uint8Array.from(bytes).buffer], { type: info.type });
  const image = await createImageBitmap(blob);
  try {
    if (
      image.width !== info.width ||
      image.height !== info.height ||
      image.width * image.height > MAX_IMAGE_PIXELS
    )
      throw new Error("图片尺寸无效");
  } finally {
    image.close();
  }
  return blob;
}
export const imageLimit = MAX_IMAGE_BYTES;
export function previewKind(path: string): "image" | "pdf" | null {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  return ext && ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)
    ? "image"
    : null;
}
