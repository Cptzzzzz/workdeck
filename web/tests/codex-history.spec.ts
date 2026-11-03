import { test, expect } from "@playwright/test";
import { selectThemedOption } from "./helpers";
const first = "11111111-1111-4111-8111-111111111111",
  second = "22222222-2222-4222-8222-222222222222";
const node = {
  id: "node",
  name: "测试节点",
  online: true,
  home: "/project",
  hostname: "test",
  platform: "linux",
  shell: "/bin/bash",
  last_seen: "",
  capabilities: ["managed-codex-v1", "codex-history-v1", "directories"],
};
async function fixture(page: any) {
  await page.route("**/api/me", (r: any) =>
    r.fulfill({ json: { username: "admin", csrf: "fixture" } }),
  );
  await page.route("**/api/state", (r: any) =>
    r.fulfill({ json: { nodes: [node], terminals: [] } }),
  );
  await page.route("**/api/events", (r: any) =>
    r.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }),
  );
  await page.route("**/api/nodes/node/codex-settings", (r: any) =>
    r.fulfill({ json: { proxy: "" } }),
  );
  await page.route("**/api/nodes/node/directories**", (r: any) =>
    r.fulfill({
      json: {
        path: new URL(r.request().url()).searchParams.get("path"),
        parent: "/",
        entries: [],
        truncated: false,
      },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "新建 Codex", exact: true })
    .first()
    .click();
}

test("load titles only on demand, paginate and submit the chosen conversation with confirmation off", async ({
  page,
}) => {
  let count = 0;
  let posted: any;
  await page.route("**/api/nodes/node/codex-history**", async (r) => {
    count++;
    const q = new URL(r.request().url()).searchParams;
    expect(q.get("cwd")).toBe("/project");
    await r.fulfill({
      json: {
        cwd: "/project",
        run_user: "test",
        entries: [
          {
            id: q.has("cursor") ? second : first,
            title: q.has("cursor") ? "更早的开发任务" : "历史开发任务",
            cwd: "/project",
            updated_at: 123,
          },
        ],
        cursor: q.has("cursor") ? "" : "next",
      },
    });
  });
  await page.route("**/api/terminals", async (r) => {
    posted = r.request().postDataJSON();
    await r.fulfill({
      json: {
        id: "new",
        state: "error",
        error: "fixture prevents process creation",
      },
    });
  });
  await fixture(page);
  const dialog = page.getByRole("dialog", { name: "新建 Codex", exact: true });
  expect(count).toBe(0);
  await expect(
    dialog.getByRole("switch", { name: "执行命令前确认" }),
  ).not.toBeChecked();
  await dialog.getByText("恢复已有对话", { exact: true }).click();
  const picker = dialog.getByRole("combobox", { name: "历史对话" });
  await expect(picker).toBeEnabled();
  await selectThemedOption(picker, first);
  await expect(picker).toContainText("历史开发任务");
  await expect(dialog.getByLabel("会话 UUID")).toHaveValue(first);
  await dialog.getByRole("button", { name: "读取更早对话" }).click();
  await expect.poll(() => count).toBe(2);
  await selectThemedOption(picker, second);
  await expect(picker).toContainText("更早的开发任务");
  await dialog.getByRole("button", { name: "启动 Codex", exact: true }).click();
  await expect.poll(() => posted?.launch?.resume).toBe(second);
  expect(posted.launch.approval).toBe("never");
  expect(posted.launch.sandbox).toBe("danger-full-access");
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("历史开发任务");
});

test("changing directory clears the chosen conversation and reloads titles for the new directory", async ({
  page,
}) => {
  await page.route("**/api/nodes/node/codex-history**", async (r) => {
    const cwd = new URL(r.request().url()).searchParams.get("cwd")!;
    await r.fulfill({
      json: {
        cwd,
        entries: [
          {
            id: cwd === "/project" ? first : second,
            title: cwd === "/project" ? "原目录任务" : "新目录任务",
            cwd,
            updated_at: 0,
          },
        ],
      },
    });
  });
  await fixture(page);
  const d = page.getByRole("dialog", { name: "新建 Codex", exact: true });
  await d.getByText("恢复已有对话", { exact: true }).click();
  const picker = d.getByRole("combobox", { name: "历史对话" });
  await expect(picker).toBeEnabled();
  await selectThemedOption(picker, first);
  await d.getByLabel("工作目录", { exact: true }).fill("/project/next");
  await expect(d.getByLabel("会话 UUID")).toHaveValue("");
  await expect(picker).toBeEnabled();
  await selectThemedOption(picker, second);
  await expect(picker).toContainText("新目录任务");
  await selectThemedOption(
    d.getByRole("combobox", { name: "计算节点" }),
    "node",
  );
  await expect(d.getByLabel("工作目录", { exact: true })).toHaveValue(
    "/project/next",
  );
  await expect(d.getByLabel("会话 UUID")).toHaveValue(second);
});
