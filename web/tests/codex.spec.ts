import { selectTestNode } from "./helpers";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("installed Codex TUI renders through the public terminal", async ({
  page,
}) => {
  test.skip(
    process.env.WORKDECK_CODEX !== "1",
    "Requires the enrolled host to have Codex installed",
  );
  const password = readFileSync(
    process.env.WORKDECK_TEST_PASSWORD_FILE || "../.secrets/administrator.txt",
    "utf8",
  ).trim();
  await page.goto("/");
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect
    .poll(() => page.locator(".node-item .online").count())
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "新建终端", exact: true })
    .first()
    .click();
  await selectTestNode(page);
  await page.getByLabel("终端名称").fill("Codex TUI 验收");
  if (process.env.WORKDECK_TEST_CWD) {
    await page.getByLabel("工作目录").fill(process.env.WORKDECK_TEST_CWD);
  }
  await page.getByRole("button", { name: "创建并连接" }).click();
  await expect(page.locator(".terminal-state")).toContainText("控制中");
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText("codex");
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-screen")).toContainText("Codex", {
    timeout: 30000,
  });
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(page.locator(".xterm-screen")).toContainText("Codex");
  await page.screenshot({ path: "../test-results/codex-tui.png" });
  // Do not submit a task or change the user's Codex configuration during rendering acceptance.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "终止终端", exact: true }).click();
});
