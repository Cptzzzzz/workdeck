// ICE stats may hide addresses or use mDNS names. These ranges are only
// hints: shared IPv4 space is not exclusive to Tailscale.
function possibleTailscaleAddress(address: unknown): boolean | undefined {
  if (typeof address !== "string" || !address) return undefined;
  const ip = address.toLowerCase();
  if (ip.endsWith(".local")) return undefined;
  if (ip.startsWith("fd7a:115c:a1e0:")) return true;
  const parts = ip.split(".");
  if (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  ) {
    return (
      Number(parts[0]) === 100 &&
      Number(parts[1]) >= 64 &&
      Number(parts[1]) <= 127
    );
  }
  return ip.includes(":") ? false : undefined;
}

// Return a category only; callers must not persist the address itself.
// 0: unavailable, 1: private/link-local, 2: Tailscale/shared range, 3: other.
export function candidateNetworkScope(address: unknown): 0 | 1 | 2 | 3 {
  const value = possibleTailscaleAddress(address);
  if (value === undefined || typeof address !== "string") return 0;
  if (value) return 2;
  const ip = address.toLowerCase();
  const v4 = ip.split(".").map(Number);
  if (
    v4.length === 4 &&
    (v4[0] === 10 ||
      v4[0] === 127 ||
      (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) ||
      (v4[0] === 192 && v4[1] === 168) ||
      (v4[0] === 169 && v4[1] === 254))
  )
    return 1;
  if (/^(?:fc|fd)[0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip))
    return 1;
  return 3;
}

export function candidateTypeCode(value: unknown): 0 | 1 | 2 | 3 | 4 {
  return value === "host"
    ? 1
    : value === "srflx"
      ? 2
      : value === "prflx"
        ? 3
        : value === "relay"
          ? 4
          : 0;
}

export function tailscaleCandidateHint(
  local: unknown,
  remote: unknown,
): "possible" | "other" | "unknown" {
  const left = possibleTailscaleAddress(local);
  const right = possibleTailscaleAddress(remote);
  if (left === false || right === false) return "other";
  if (left === true && right === true) return "possible";
  return "unknown";
}
