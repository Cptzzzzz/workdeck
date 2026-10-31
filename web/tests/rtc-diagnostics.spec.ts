import { test, expect } from "@playwright/test";
import {
  candidateCountsFromSdp,
  RtcRecorder,
  cleanReport,
  summarizeCandidatePairs,
} from "../src/rtc-diagnostics";

test("diagnostics aggregate candidate types and counters without retaining addresses or credentials", () => {
  const sdp = [
    "v=0",
    "a=candidate:secret-id 1 udp 123 192.0.2.55 12345 typ host",
    "a=candidate:secret-id2 1 UDP 456 198.51.100.1 54321 typ srflx raddr 192.0.2.1 rport 555",
    "a=ice-pwd:private-password",
  ].join("\r\n");
  expect(candidateCountsFromSdp(sdp)).toEqual({
    "host/udp": 1,
    "srflx/udp": 1,
  });
  const stats = new Map<string, any>([
    [
      "private-local-id",
      {
        type: "local-candidate",
        candidateType: "host",
        protocol: "udp",
        address: "192.0.2.55",
        port: 12345,
      },
    ],
    [
      "private-remote-id",
      {
        type: "remote-candidate",
        candidateType: "srflx",
        protocol: "udp",
        address: "198.51.100.1",
        port: 54321,
      },
    ],
    [
      "private-pair-id",
      {
        type: "candidate-pair",
        localCandidateId: "private-local-id",
        remoteCandidateId: "private-remote-id",
        state: "in-progress",
        requestsSent: 4,
        responsesReceived: 0,
      },
    ],
  ]);
  const pairs = summarizeCandidatePairs(stats as unknown as RTCStatsReport);
  expect(pairs).toEqual([
    {
      local: "host/udp",
      remote: "srflx/udp",
      state: "in-progress",
      count: 1,
      requestsSent: 4,
      responsesReceived: 0,
    },
  ]);
  const sanitized = cleanReport({
    schema: 1,
    startedAt: Date.now(),
    elapsedMs: 120,
    stage: "checking",
    outcome: "in_progress",
    gathering: "complete",
    ice: "checking",
    connection: "connecting",
    channel: "connecting",
    localCandidates: { "host/udp": 1 },
    remoteCandidates: { "srflx/udp": 1 },
    pairs,
    stunErrorCodes: [701],
    sdp,
    secret: "private-password",
  });
  const json = JSON.stringify(sanitized);
  for (const secret of [
    "192.0.2",
    "198.51.100",
    "12345",
    "private-password",
    "private-local-id",
    "secret-id",
  ])
    expect(json).not.toContain(secret);
  expect(sanitized?.pairs?.[0].responsesReceived).toBe(0);
  expect(sanitized?.pairs?.[0].requestsReceived).toBeUndefined();
});

test("incremental candidates are counted once and never appear in the saved report", () => {
  let current: any;
  const recorder = new RtcRecorder(
    "",
    (report) => {
      current = report;
    },
    true,
  );
  const first = "candidate:private-a 1 udp 123 192.0.2.2 54321 typ host";
  const later = "candidate:private-b 1 udp 123 198.51.100.7 12345 typ srflx";
  recorder.remoteDescription(`v=0\r\na=${first}\r\n`);
  recorder.remoteCandidate(first);
  recorder.remoteCandidate(later);
  expect(current.remoteCandidates).toEqual({ "host/udp": 1, "srflx/udp": 1 });
  expect(current.trickle).toBe(true);
  expect(JSON.stringify(current)).not.toContain("192.0.2");
  expect(JSON.stringify(current)).not.toContain("198.51.100");
});
