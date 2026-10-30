export const MAX_CHUNK = 32 * 1024;
export const MAX_CONTROL = 32 * 1024;
const HEADER = 48;
const validID = /^[0-9a-f]{48}$/;
export type Envelope = {
  version: 1;
  type: string;
  request_id: string;
  workspace_id: string;
  root_revision: number;
  route_epoch: number;
  payload?: unknown;
};
export type Chunk = {
  requestID: string;
  offset: number;
  epoch: number;
  data: Uint8Array;
};
export function makeID(nodeTime: number): string {
  if (!Number.isSafeInteger(nodeTime) || nodeTime < 0)
    throw new Error("节点时间无效");
  const bytes = new Uint8Array(24);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(nodeTime));
  crypto.getRandomValues(bytes.subarray(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function encodeControl(envelope: Envelope): string {
  if (
    !validID.test(envelope.request_id) ||
    !validID.test(envelope.workspace_id) ||
    !Number.isSafeInteger(envelope.root_revision) ||
    envelope.root_revision < 1 ||
    !Number.isInteger(envelope.route_epoch) ||
    envelope.route_epoch < 1 ||
    envelope.route_epoch > 0xffffffff
  )
    throw new Error("文件请求参数无效");
  const encoded = JSON.stringify(envelope);
  if (new TextEncoder().encode(encoded).byteLength > MAX_CONTROL)
    throw new Error("文件请求过大");
  return encoded;
}
export function encodeChunk(
  id: string,
  offset: number,
  epoch: number,
  data: Uint8Array,
): ArrayBuffer {
  if (
    !validID.test(id) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(offset + data.length) ||
    !Number.isInteger(epoch) ||
    epoch < 1 ||
    epoch > 0xffffffff ||
    data.length < 1 ||
    data.length > MAX_CHUNK
  )
    throw new Error("文件数据块无效");
  const buffer = new ArrayBuffer(HEADER + data.length),
    view = new DataView(buffer),
    bytes = new Uint8Array(buffer);
  bytes.set([0x57, 0x44, 0x46, 0x31, 1, 1, 0, 0]);
  for (let i = 0; i < 24; i++)
    bytes[8 + i] = parseInt(id.slice(i * 2, i * 2 + 2), 16);
  view.setBigUint64(32, BigInt(offset));
  view.setUint32(40, data.length);
  view.setUint32(44, epoch);
  bytes.set(data, HEADER);
  return buffer;
}
export function decodeChunk(buffer: ArrayBuffer): Chunk {
  if (buffer.byteLength < HEADER || buffer.byteLength > HEADER + MAX_CHUNK)
    throw new Error("文件数据块长度无效");
  const bytes = new Uint8Array(buffer),
    view = new DataView(buffer);
  if (
    bytes[0] !== 0x57 ||
    bytes[1] !== 0x44 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x31 ||
    bytes[4] !== 1 ||
    bytes[5] !== 2 ||
    bytes[6] !== 0 ||
    bytes[7] !== 0
  )
    throw new Error("文件数据块格式无效");
  const size = view.getUint32(40),
    epoch = view.getUint32(44),
    offset = view.getBigUint64(32);
  if (
    !size ||
    size > MAX_CHUNK ||
    size !== buffer.byteLength - HEADER ||
    !epoch ||
    offset > BigInt(Number.MAX_SAFE_INTEGER) ||
    offset + BigInt(size) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error("文件数据块范围无效");
  return {
    requestID: Array.from(bytes.subarray(8, 32), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
    offset: Number(offset),
    epoch,
    data: bytes.slice(HEADER),
  };
}
