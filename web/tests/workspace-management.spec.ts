import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.env.WORKDECK_FILE_TEST_ROOT,
  nodeName = process.env.WORKDECK_TEST_NODE_NAME,
  url = process.env.WORKDECK_TEST_URL || "";
test.skip(
  !root || !nodeName || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url),
  "requires an isolated local node",
);

test("workspace management navigates existing forms without terminating sessions", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "management-ui-"));
  const name = `management fixture ${Date.now()}`;
  let id = "",
    csrf = "";
  try {
    await page.goto("/?transport=relay");
    await page.getByLabel("用户名").fill("admin");
    await page
      .getByLabel("密码", { exact: true })
      .fill(
        readFileSync(process.env.WORKDECK_TEST_PASSWORD_FILE!, "utf8").trim(),
      );
    await page.getByRole("button", { name: "进入工作台" }).click();
    await expect(
      page.getByRole("heading", { name: "你的远程工作台." }),
    ).toBeVisible();
    const fixture = await page.evaluate(
      async ({ nodeName, dir, name }) => {
        const me = await fetch("/api/me").then((r) => r.json()),
          state = await fetch("/api/state").then((r) => r.json());
        const nodes = state.nodes.filter(
          (n: any) => n.name === nodeName && n.online,
        );
        if (nodes.length !== 1) throw new Error("isolated node unavailable");
        const response = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({ node_id: nodes[0].id, name, cwd: dir }),
        });
        if (!response.ok) throw new Error(`fixture ${response.status}`);
        return { terminal: await response.json(), csrf: me.csrf };
      },
      { nodeName, dir, name },
    );
    id = fixture.terminal.id;
    csrf = fixture.csrf;
    const pane = () =>
      execFileSync(
        "tmux",
        [
          "-L",
          `workdeck-${id}`,
          "display-message",
          "-p",
          "-t",
          "main",
          "#{pane_pid}",
        ],
        { encoding: "utf8" },
      ).trim();
    const pid = pane();
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page
      .locator(".terminal-mount")
      .evaluate((el) => el.setAttribute("data-management-test", "same"));
    await page.getByRole("button", { name: "工作区模式" }).click();
    const trigger = page.getByRole("button", { name: "会话管理" });
    await trigger.click();
    let dialog = page.getByRole("dialog", { name: "会话管理" });
    await expect(dialog.getByText(name)).toBeVisible();
    await dialog.getByLabel("搜索会话").fill(name);
    await dialog.getByRole("button", { name: "终止", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "终止终端" })).toBeVisible();
    await page
      .getByRole("dialog", { name: "终止终端" })
      .getByRole("button", { name: "取消" })
      .click();
    dialog = page.getByRole("dialog", { name: "会话管理" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("搜索会话").fill(name);
    await dialog.getByRole("button", { name: "重命名" }).click();
    const rename = page.getByRole("dialog", { name: "重命名终端" });
    await rename.getByLabel("终端名称").fill(`${name} renamed`);
    await rename.getByRole("button", { name: "保存名称" }).click();
    await expect(dialog.getByText(`${name} renamed`)).toBeVisible();
    expect(
      await page.evaluate(
        async (id) =>
          (await fetch("/api/state").then((r) => r.json())).terminals.find(
            (t: any) => t.id === id,
          ).name,
        id,
      ),
    ).toBe(`${name} renamed`);
    await dialog.getByRole("button", { name: "新建" }).click();
    await expect(page.getByRole("dialog", { name: "新建终端" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "会话管理" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await page.getByRole("button", { name: "节点管理" }).click();
    const nodes = page.getByRole("dialog", { name: "节点管理" });
    await expect(nodes.getByText(nodeName!)).toBeVisible();
    await nodes.getByRole("button", { name: "重命名" }).click();
    await expect(
      page.getByRole("dialog", { name: "重命名节点" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "取消" }).click();
    await expect(nodes).toBeVisible();
    await nodes.getByRole("button", { name: "关闭对话框" }).click();
    await page.getByRole("button", { name: "账户管理" }).click();
    const account = page.getByRole("dialog", { name: "账户管理" });
    await account.getByRole("button", { name: "修改密码" }).click();
    await expect(page.getByRole("dialog", { name: "修改密码" })).toBeVisible();
    await page.getByRole("button", { name: "关闭对话框" }).click();
    await expect(account).toBeVisible();
    await account.getByRole("button", { name: "关闭对话框" }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置" });
    await settings.getByLabel("终端字号").selectOption("14");
    await expect(settings.getByLabel("终端字号")).toHaveValue("14");
    await settings.getByRole("button", { name: "关闭对话框" }).click();
    await page.getByRole("button", { name: "终端模式" }).click();
    await expect(
      page.locator('.terminal-mount[data-management-test="same"]'),
    ).toHaveCount(1);
    expect(pane()).toBe(pid);
  } finally {
    if (id && csrf)
      await page.request
        .delete(`/api/terminals/${id}`, {
          headers: { "X-Workdeck-CSRF": csrf },
        })
        .catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
