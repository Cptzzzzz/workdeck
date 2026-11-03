import { test, expect } from "@playwright/test";
import { selectThemedOption } from "./helpers";

const node = {
  id: "node",
  name: "测试节点",
  online: true,
  home: "/tmp",
  hostname: "test",
  platform: "linux",
  shell: "/bin/bash",
  last_seen: "",
  capabilities: ["managed-codex-v1", "directories"],
  has_codex_proxy: true,
};

async function stub(page: any) {
  await page.route("**/api/me", (r: any) =>
    r.fulfill({ json: { username: "admin", csrf: "fixture" } }),
  );
  await page.route("**/api/state", (r: any) =>
    r.fulfill({ json: { nodes: [node], terminals: [] } }),
  );
  await page.route("**/api/events", (r: any) =>
    r.fulfill({ body: ": fixture\n\n", contentType: "text/event-stream" }),
  );
  await page.route("**/api/nodes/node/directories**", (r: any) =>
    r.fulfill({
      json: {
        path: "/tmp",
        parent: "/",
        entries: [{ name: "child", path: "/tmp/child" }],
        truncated: false,
      },
    }),
  );
}

test("listboxes support keyboard, modal Escape, directory navigation and viewport placement", async ({
  page,
}) => {
  await stub(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "新建终端", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "新建终端", exact: true }),
    picker = dialog.getByRole("combobox", { name: "进入子目录" });
  await expect(picker).toBeEnabled();
  await picker.focus();
  await picker.press("ArrowDown");
  await expect(picker).toHaveAttribute("aria-expanded", "true");
  await picker.press("Escape");
  await expect(picker).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toBeVisible();
  await picker.press("ArrowDown");
  await picker.press("End");
  await picker.press("Enter");
  await expect(dialog.getByLabel("工作目录", { exact: true })).toHaveValue(
    "/tmp/child",
  );
  await expect(dialog).toBeVisible();
  await picker.click();
  const popup = page.getByRole("listbox");
  const bounds = await popup.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(1000);
  await page.getByRole("heading", { name: "开启新的工作" }).click();
  await expect(popup).toHaveCount(0);
  await expect(page.locator("select")).toHaveCount(0);
});

test("node proxy editor loads and saves without exposing it in inventory", async ({
  page,
}) => {
  await stub(page);
  let proxy = "http://saved.example:7890",
    writes = 0;
  await page.route("**/api/nodes/node/codex-settings", async (r) => {
    if (r.request().method() === "PUT") {
      writes++;
      proxy = r.request().postDataJSON().proxy;
      await r.fulfill({ json: { ok: true } });
    } else await r.fulfill({ json: { proxy } });
  });
  await page.goto("/");
  await page.locator(".node-item").filter({ hasText: "测试节点" }).click();
  await page.getByRole("button", { name: "代理设置", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "节点代理设置",
    exact: true,
  });
  await expect(editor.getByLabel("代理地址")).toHaveValue(proxy);
  await editor.getByLabel("代理地址").fill("http://edited.example:1080");
  await editor.getByRole("button", { name: "保存代理" }).click();
  await expect.poll(() => writes).toBe(1);
  await expect(editor).toHaveCount(0);
  await page
    .getByRole("button", { name: "新建 Codex", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("代理地址")).toHaveValue(
    "http://edited.example:1080",
  );
});

test("network dropdown stays inside the network card and Escape closes only the dropdown", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/network-panel-harness.html");
  await page.locator(".terminal-network > summary").click();
  const panel = page.locator(".network-details"),
    policy = panel.getByRole("combobox", { name: "链路策略" });
  await policy.click();
  await policy.press("Escape");
  await expect(panel).toBeVisible();
  await selectThemedOption(policy, "balanced");
  await expect(panel).toBeVisible();
  await expect(policy).toHaveAttribute("data-value", "balanced");
});

test("font dropdown works inside a nested popover and browser fullscreen", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/font-select-harness.html");
  for (const fullscreen of [false, true]) {
    if (fullscreen)
      await page.getByRole("button", { name: "全屏验收" }).click();
    await page.getByRole("button", { name: "终端字号", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "终端字号设置" }),
      control = panel.getByRole("combobox", { name: "字号", exact: true });
    await selectThemedOption(control, "12");
    await expect(panel).toBeVisible();
    await expect(page.getByLabel("当前字号")).toHaveText("12");
    await control.click();
    await page.keyboard.press("Escape");
    await expect(panel).toBeVisible();
    await expect(control).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    if (fullscreen) await page.evaluate(() => document.exitFullscreen());
  }
});
