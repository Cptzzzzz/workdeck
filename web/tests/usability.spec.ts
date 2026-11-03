import { themedOptions } from "./helpers";
import { selectThemedOption } from "./helpers";
import { terminateCurrentTerminal } from "./helpers";
import { test, expect, chromium, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { selectTestNode } from "./helpers";

const baseURL = process.env.WORKDECK_TEST_URL || "http://127.0.0.1:8090";
const password = readFileSync(
  process.env.WORKDECK_TEST_PASSWORD_FILE || "../.secrets/administrator.txt",
  "utf8",
).trim();
async function login(page: Page) {
  await page.goto(baseURL);
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "你的远程工作台." }),
  ).toBeVisible();
}

test("choose a real node child directory and create a terminal there", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("button", { name: "新建终端", exact: true })
    .first()
    .click();
  await selectTestNode(page);
  const path = page.getByLabel("工作目录", { exact: true });
  const original = await path.inputValue();
  const select = page.getByRole("combobox", { name: "进入子目录" });
  await expect(select).toBeEnabled();
  const options = await themedOptions(select);
  const child =
    options.find((value) => value.endsWith("/projects")) || options[0];
  expect(child).toBeTruthy();
  await selectThemedOption(select, child!);
  await expect(path).toHaveValue(child!);
  await expect(page.getByRole("button", { name: "上一级" })).toBeEnabled();
  await page.getByRole("button", { name: "上一级" }).click();
  await expect(page.locator(".directory-hint")).toBeVisible();
  await page.getByRole("button", { name: "主目录", exact: true }).click();
  await expect(path).toHaveValue(original);
  await expect(select).toBeEnabled();
  await selectThemedOption(select, child!);
  await expect(page.locator(".directory-hint")).toBeVisible();
  const chosen = await path.inputValue();
  await page.getByLabel("终端名称").fill("目录选择验收-" + Date.now());
  await page.screenshot({ path: "../test-results/directory-picker.png" });
  await page.getByRole("button", { name: "创建并连接" }).click();
  await expect(page.locator(".terminal-state")).toContainText("控制中");
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText("printf 'actual-directory='; pwd");
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-screen")).toContainText(
    "actual-directory=" + chosen,
  );
  await terminateCurrentTerminal(page);
});

test("browser profile remembers login and another device remains logged in", async ({
  browser,
}, info) => {
  const profile = info.outputPath("private-browser-profile");
  const options = {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  };
  let context = await chromium.launchPersistentContext(profile, options);
  const second = await browser.newContext();
  try {
    let page = context.pages()[0] || (await context.newPage());
    await login(page);
    const cookie = (await context.cookies(baseURL)).find(
      (cookie) =>
        cookie.name === "__Host-workdeck" || cookie.name === "workdeck",
    );
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.expires || 0).toBeGreaterThan(
      Date.now() / 1000 + 28 * 86400,
    );
    const other = await second.newPage();
    await login(other);
    await context.close();
    context = await chromium.launchPersistentContext(profile, options);
    page = context.pages()[0] || (await context.newPage());
    await page.goto(baseURL);
    await expect(
      page.getByRole("heading", { name: "你的远程工作台." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "退出此设备", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "登录工作台" }),
    ).toBeVisible();
    await other.reload();
    await expect(
      other.getByRole("heading", { name: "你的远程工作台." }),
    ).toBeVisible();
    await other
      .getByRole("button", { name: "退出此设备", exact: true })
      .click();
  } finally {
    await context.close();
    await second.close();
  }
});
