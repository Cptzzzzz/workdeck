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
