import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readState, selectTestNode, terminateCurrentTerminal } from "./helpers";
import {
  parseFontSize,
  FONT_SIZE_KEY,
  DEFAULT_FONT_SIZE,
} from "../src/terminal-preferences";

test("font preferences validate stored values", () => {
  for (const value of [null, "", "bad", "9", "25", "12.5"])
    expect(parseFontSize(value)).toBe(DEFAULT_FONT_SIZE);
  for (const value of ["10", "12", "24"])
    expect(parseFontSize(value)).toBe(Number(value));
});
async function openFont(page: Page) {
  await page.getByRole("button", { name: "终端字号", exact: true }).click();
  return page.getByRole("dialog", { name: "终端字号设置", exact: true });
}
async function command(page: Page, text: string) {
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}
test("font changes are live, persistent and local to each browser without reconnecting", async ({
  page,
  browser,
}) => {
  const password = readFileSync(
    process.env.WORKDECK_TEST_PASSWORD_FILE || "../.secrets/administrator.txt",
    "utf8",
  ).trim();
  await page.goto("/?transport=relay");
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page
    .getByRole("button", { name: "新建终端", exact: true })
    .first()
    .click();
  await selectTestNode(page);
  const name = "字号验收-" + Date.now();
  await page.getByLabel("终端名称").fill(name);
  let connections = 0;
  page.on("websocket", () => connections++);
  await page.getByRole("button", { name: "创建并连接" }).click();
  await expect(page.locator(".terminal-state")).toContainText("控制中");
  const id = (await readState(page)).terminals.find(
    (t: { name: string }) => t.name === name,
  ).id;
  try {
    await command(page, "export WORKDECK_FONT_SENTINEL=still-alive");
    await expect(page.locator(".xterm-rows")).toHaveCSS("font-size", "13px");
    const before = connections;
    const dialog = await openFont(page);
    await dialog
      .getByRole("combobox", { name: "字号", exact: true })
      .selectOption("12");
    await expect(page.locator(".xterm-rows")).toHaveCSS("font-size", "12px");
    expect(
      await page.evaluate((key) => localStorage.getItem(key), FONT_SIZE_KEY),
    ).toBe("12");
    await dialog.getByRole("button", { name: "增大字号" }).click();
    await expect(page.locator(".xterm-rows")).toHaveCSS("font-size", "13px");
    await dialog.getByRole("button", { name: "减小字号" }).click();
    await dialog.getByRole("button", { name: "关闭字号设置" }).click();
    await command(page, 'printf "font-shell=%s\\n" "$WORKDECK_FONT_SENTINEL"');
    await expect(page.locator(".xterm-screen")).toContainText(
      "font-shell=still-alive",
    );
    expect(connections).toBe(before);
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".xterm-rows")).toHaveCSS("font-size", "12px");
    // Another tab shares this device preference; another browser does not.
    const tab = await page.context().newPage();
    try {
      await tab.goto("/?transport=relay");
      await tab.getByRole("button", { name, exact: true }).click();
      await expect(tab.locator(".xterm-rows")).toHaveCSS("font-size", "12px");
      const settings = await openFont(page);
      await settings
        .getByRole("combobox", { name: "字号", exact: true })
        .selectOption("11");
      await expect(tab.locator(".xterm-rows")).toHaveCSS("font-size", "11px");
      await settings
        .getByRole("button", { name: "恢复默认", exact: false })
        .click();
      await expect(tab.locator(".xterm-rows")).toHaveCSS("font-size", "13px");
      await settings
        .getByRole("combobox", { name: "字号", exact: true })
        .selectOption("12");
      await settings.getByRole("button", { name: "关闭字号设置" }).click();
    } finally {
      await tab.close();
    }
    const other = await browser.newContext();
    try {
      const viewer = await other.newPage();
      await viewer.goto("/?transport=relay");
      await viewer.getByLabel("用户名").fill("admin");
      await viewer.getByLabel("密码", { exact: true }).fill(password);
      await viewer.getByRole("button", { name: "进入工作台" }).click();
      await viewer.getByRole("button", { name, exact: true }).click();
      await expect(viewer.locator(".xterm-rows")).toHaveCSS(
        "font-size",
        "13px",
      );
      await expect(viewer.locator(".terminal-state")).toContainText("只读");
      const settings = await openFont(viewer);
      await settings
        .getByRole("combobox", { name: "字号", exact: true })
        .selectOption("10");
      await expect(viewer.locator(".xterm-rows")).toHaveCSS(
        "font-size",
        "10px",
      );
      await expect(page.locator(".xterm-rows")).toHaveCSS("font-size", "12px");
      await expect(page.locator(".terminal-state")).toContainText("控制中");
    } finally {
      await other.close();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const settings = await openFont(page);
    const box = await settings.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: "../test-results/terminal-font-mobile.png",
      animations: "disabled",
    });
    await settings.getByRole("button", { name: "关闭字号设置" }).click();
    await terminateCurrentTerminal(page);
  } finally {
    await page
      .evaluate(async (id) => {
        const me = await (await fetch("/api/me")).json();
        await fetch("/api/terminals/" + id, {
          method: "DELETE",
          headers: { "X-Workdeck-CSRF": me.csrf },
          signal: AbortSignal.timeout(10000),
        });
      }, id)
      .catch(() => {});
  }
});
