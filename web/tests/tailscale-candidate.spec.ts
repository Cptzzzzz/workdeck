import { test, expect } from "@playwright/test";
import { tailscaleCandidateHint } from "../src/tailscale-candidate";

test("ICE candidate hints never claim a confirmed Tailscale connection", () => {
  expect(tailscaleCandidateHint("100.64.0.1", "100.127.255.254")).toBe(
    "possible",
  );
  expect(tailscaleCandidateHint("fd7a:115c:a1e0::1", "fd7a:115c:a1e0::2")).toBe(
    "possible",
  );
  expect(tailscaleCandidateHint("100.63.0.1", "100.64.0.2")).toBe("other");
  expect(tailscaleCandidateHint("100.128.0.1", "100.64.0.2")).toBe("other");
  expect(tailscaleCandidateHint("private.local", "100.64.0.2")).toBe("unknown");
  expect(tailscaleCandidateHint(undefined, undefined)).toBe("unknown");
  expect(tailscaleCandidateHint("100.64.0.999", "100.64.0.2")).toBe("unknown");
});
