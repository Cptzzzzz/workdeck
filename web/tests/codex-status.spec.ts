import { expect, test } from "@playwright/test";

test("terminal mode shows the Codex observation in the card, tab and status bar", async ({
  page,
}) => {
  const node = {
    id: "test-node",
    name: "测试节点",
    online: true,
    hostname: "test",
    home: "/home/test",
    platform: "linux",
    last_seen: "",
    shell: "/bin/bash",
    capabilities: ["codex-hooks-v1"],
  };
  const terminal = {
    id: "test-terminal",
    node_id: node.id,
    name: "测试任务",
    cwd: "/home/test",
    state: "running",
    desired_state: "running",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "",
    error: "",
    viewers: 0,
    exit_code: null,
    task: {
      note: "",
      tags: "",
      important: false,
      manual_status: "",
      codex_turn: "turn",
      codex_completed_at: "2026-01-01T00:00:00Z",
      codex_command: "",
      codex_status: "turn_ended",
      codex_event: "event",
      codex_observed_at: "2026-01-01T00:00:00Z",
      codex_detected: true,
    },
  };
  await page.route("**/api/me", (route) =>
    route.fulfill({ json: { username: "admin", csrf: "fixture" } }),
  );
  await page.route("**/api/state", (route) =>
    route.fulfill({ json: { nodes: [node], terminals: [terminal] } }),
  );
  await page.route("**/api/events", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: ": fixture\n\n",
    }),
  );
  await page.goto("/");
  await expect(page.locator(".terminal-card")).toContainText(
    "Codex 可能已完成，待查看",
  );
  await page
    .locator(".terminal-card")
    .getByRole("button", { name: "进入终端" })
    .click();
  await expect(
    page.locator(".terminal-tab .codex-tab-indicator"),
  ).toHaveAttribute("title", "Codex 可能已完成，待查看");
  await expect(page.locator(".terminal-statusbar")).toContainText(
    "Codex 可能已完成，待查看",
  );
});
