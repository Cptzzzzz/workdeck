import { selectThemedOption } from "./helpers";
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
test("separate Codex entry inherits node proxy and sends simple launch options", async ({
  page,
}) => {
  const nodes = [
    node,
    { ...node, id: "node-b", name: "另一个节点", home: "/other" },
  ];
  await page.route("**/api/me", (r) =>
    r.fulfill({ json: { username: "admin", csrf: "fixture" } }),
  );
  await page.route("**/api/state", (r) =>
    r.fulfill({ json: { nodes, terminals: [] } }),
  );
  await page.route("**/api/events", (r) =>
    r.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }),
  );
  await page.route("**/api/nodes/*/directories**", (r) =>
    r.fulfill({
      json: { path: "/tmp", parent: "/", entries: [], truncated: false },
    }),
  );
  const saved = "http://fixture:password@proxy.example:7890";
  await page.route("**/api/nodes/node/codex-settings", (r) =>
    r.fulfill({ json: { proxy: saved } }),
  );
  await page.route("**/api/nodes/node-b/codex-settings", (r) =>
    r.fulfill({ json: { proxy: "http://other.example:7890" } }),
  );
  let posted: any;
  await page.route("**/api/terminals", async (r) => {
    posted = r.request().postDataJSON();
    await r.fulfill({
      json: {
        id: "new-terminal",
        state: "error",
        error: "fixture prevents process creation",
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "新建终端", exact: true })
    .first()
    .click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("终端名称")).toBeVisible();
  await expect(dialog.getByLabel("模型")).toHaveCount(0);
  await expect(dialog.getByLabel("启动方式")).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭对话框" }).click();
  await page
    .getByRole("button", { name: "新建 Codex", exact: true })
    .first()
    .click();
  dialog = page.getByRole("dialog", { name: "新建 Codex", exact: true });
  await expect(dialog.getByLabel("代理地址")).toHaveValue(saved);
  await expect(dialog.getByText("执行预设", { exact: true })).toHaveCount(0);
  await selectThemedOption(dialog.getByLabel("计算节点"), "node-b");
  await expect(dialog.getByLabel("代理地址")).toHaveValue(
    "http://other.example:7890",
  );
  await expect(dialog.getByLabel("工作目录", { exact: true })).toHaveValue(
    "/other",
  );
  await selectThemedOption(dialog.getByLabel("计算节点"), "node");
  await expect(dialog.getByLabel("代理地址")).toHaveValue(saved);
  const edited = "http://session-only.example:7890";
  await dialog.getByLabel("代理地址").fill(edited);
  await expect(
    dialog.getByRole("switch", { name: "执行命令前确认" }),
  ).not.toBeChecked();
  await selectThemedOption(dialog.getByLabel("推理强度"), "xhigh");
  await dialog.getByRole("button", { name: "启动 Codex", exact: true }).click();
  await expect.poll(() => posted?.launch?.approval).toBe("never");
  expect(posted.launch).toEqual({
    proxy_mode: "custom",
    proxy: edited,
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
  ).not.toContain(saved);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain(edited);
  await expect(page.locator("select")).toHaveCount(0);
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
