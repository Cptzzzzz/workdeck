import { expect, test } from "@playwright/test";

const node = {
  id: "node",
  name: "测试节点",
  online: true,
  hostname: "node",
  home: "/tmp",
  platform: "linux",
  last_seen: "",
  shell: "/bin/bash",
  capabilities: [],
};
const base = {
  node_id: "node",
  cwd: "/tmp",
  state: "running",
  desired_state: "running",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "",
  error: "",
  viewers: 0,
  exit_code: null,
};
const terminals = [
  { ...base, id: "codex", name: "开发任务", kind: "codex" },
  { ...base, id: "shell", name: "调试终端", kind: "terminal" },
];

test("terminal mode distinguishes session types and configures Feishu without storing secrets in the browser", async ({
  page,
}) => {
  await page.route("**/api/me", (r) =>
    r.fulfill({ json: { username: "admin", csrf: "fixture" } }),
  );
  await page.route("**/api/state", (r) =>
    r.fulfill({ json: { nodes: [node], terminals } }),
  );
  await page.route("**/api/events", (r) =>
    r.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }),
  );
  let saved: any;
  let tested = false;
  await page.route("**/api/integrations/feishu", async (r) => {
    if (r.request().method() === "PUT") {
      saved = r.request().postDataJSON();
      return r.fulfill({ json: { ok: true } });
    }
    return r.fulfill({
      json: {
        enabled: !!saved,
        app_id: saved?.app_id || "",
        has_secret: !!saved,
        receive_type: "open_id",
        receive_id: saved?.receive_id || "",
        complete: true,
        attention: true,
        pending: 0,
        last_error: "",
      },
    });
  });
  await page.route("**/api/integrations/feishu/test", (r) => {
    tested = true;
    return r.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await expect(
    page.locator(".terminal-card").filter({ hasText: "开发任务" }),
  ).toContainText("Codex 任务");
  await expect(
    page.locator(".terminal-card").filter({ hasText: "调试终端" }),
  ).toContainText("普通终端");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog.getByText("飞书通知", { exact: true })).toBeVisible();
  await dialog.getByLabel("开启飞书通知").check();
  await dialog.getByLabel("App ID", { exact: true }).fill("cli_fixture");
  await dialog.getByLabel("App Secret", { exact: true }).fill("secret-fixture");
  await dialog.getByLabel("接收 ID").fill("ou_fixture");
  await dialog.getByRole("button", { name: "保存飞书设置" }).click();
  await expect(dialog.getByText("飞书设置已保存")).toBeVisible();
  expect(saved).toMatchObject({
    enabled: true,
    app_id: "cli_fixture",
    app_secret: "secret-fixture",
    receive_type: "open_id",
    receive_id: "ou_fixture",
  });
  await expect(dialog.getByLabel("App Secret")).toHaveValue("");
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("secret-fixture");
  await dialog.getByRole("button", { name: "发送测试通知" }).click();
  await expect(dialog.getByText("测试通知已发送，请查看飞书")).toBeVisible();
  expect(tested).toBe(true);
});

test("a notification link opens the matching Codex task after login", async ({
  page,
}) => {
  await page.route("**/api/me", (r) =>
    r.fulfill({ json: { username: "admin", csrf: "fixture" } }),
  );
  await page.route("**/api/state", (r) =>
    r.fulfill({ json: { nodes: [node], terminals } }),
  );
  await page.route("**/api/events", (r) =>
    r.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }),
  );
  await page.goto("/?terminal=codex");
  await expect(
    page.locator(".terminal-tab").filter({ hasText: "开发任务" }),
  ).toBeVisible();
  await expect(
    page.locator(".terminal-tab svg[aria-label='Codex 任务']"),
  ).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.has("terminal"))
    .toBe(false);
});
