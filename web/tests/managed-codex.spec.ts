import { expect, test } from "@playwright/test";
const node = {
  id: "node",
  name: "测试节点",
  online: true,
  home: "/tmp",
  hostname: "test",
  platform: "linux",
  shell: "/bin/bash",
  last_seen: "",
  capabilities: ["managed-codex-v1"],
};
test("managed launch sends options without saving proxy in browser storage", async ({
  page,
}) => {
  await page.route("**/api/me", (r) =>
    r.fulfill({ json: { username: "admin", csrf: "fixture" } }),
  );
  await page.route("**/api/state", (r) =>
    r.fulfill({ json: { nodes: [node], terminals: [] } }),
  );
  await page.route("**/api/events", (r) =>
    r.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }),
  );
  await page.route("**/api/nodes/node/directories**", (r) =>
    r.fulfill({
      json: { path: "/tmp", parent: "/", entries: [], truncated: false },
    }),
  );
  let posted: any;
  await page.route("**/api/terminals", async (r) => {
    posted = r.request().postDataJSON();
    await r.fulfill({
      json: {
        id: "new-terminal",
        state: "error",
        error: "fixture stops before creating a process",
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "新建终端", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("启动方式").selectOption("codex");
  await dialog
    .getByLabel("执行预设")
    .selectOption("never/danger-full-access/xhigh");
  await dialog.getByLabel("代理", { exact: true }).selectOption("custom");
  const proxy = "http://fixture:password@127.0.0.1:7890";
  await dialog.getByLabel("代理地址").fill(proxy);
  await dialog.getByRole("button", { name: "创建并连接" }).click();
  await expect.poll(() => posted?.launch?.approval).toBe("never");
  expect(posted.launch).toEqual({
    proxy_mode: "custom",
    proxy,
    approval: "never",
    sandbox: "danger-full-access",
    model: "",
    effort: "xhigh",
    resume: "",
  });
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain(proxy);
});
test("goal active remains running after completed turns", async ({ page }) => {
  const terminal = {
    id: "terminal",
    node_id: "node",
    name: "Goal 测试",
    cwd: "/tmp",
    state: "running",
    desired_state: "running",
    created_at: "",
    updated_at: "",
    error: "",
    viewers: 0,
    exit_code: null,
    task: {
      codex_status: "goal_active",
      codex_detected: true,
      codex_turn: "completed-turn",
      codex_event: "event",
      codex: {
        managed: true,
        thread_id: "parent",
        goal: { status: "active", tokens_used: 10, created_at: 123 },
      },
    },
  };
  await page.route("**/api/me", (r) =>
    r.fulfill({ json: { username: "admin", csrf: "fixture" } }),
  );
  await page.route("**/api/state", (r) =>
    r.fulfill({ json: { nodes: [node], terminals: [terminal] } }),
  );
  await page.route("**/api/events", (r) =>
    r.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }),
  );
  await page.goto("/");
  await expect(page.locator(".terminal-card")).toContainText(
    "Codex Goal 执行中",
  );
  await expect(page.locator(".terminal-card")).not.toContainText("已完成");
});
