import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readState, selectTestNode, terminateCurrentTerminal } from "./helpers";
const password = readFileSync(
  process.env.WORKDECK_TEST_PASSWORD_FILE || "../.secrets/administrator.txt",
  "utf8",
).trim();

test("rename and terminate use site forms; cancellation keeps the task alive", async ({
  page,
}) => {
  let nativeDialogs = 0;
  page.on("dialog", (dialog) => {
    nativeDialogs++;
    void dialog.dismiss();
  });
  await page.goto("/");
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "你的远程工作台." }),
  ).toBeVisible();
  const initial = "弹窗验收-" + Date.now(),
    renamed = initial + "-已改名";
  await page
    .getByRole("button", { name: "新建终端", exact: true })
    .first()
    .click();
  await selectTestNode(page);
  await page.getByLabel("终端名称").fill(initial);
  await page.getByRole("button", { name: "创建并连接" }).click();
  await expect(page.locator(".terminal-state")).toContainText("控制中");
  const id = (await readState(page)).terminals.find(
    (terminal: { name: string }) => terminal.name === initial,
  ).id;
  try {
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.insertText("export WORKDECK_MODAL_TASK=still-running");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "返回概览", exact: true }).click();
    const card = page
      .locator(".terminal-card")
      .filter({
        has: page.getByRole("heading", { name: initial, exact: true }),
      });
    const openRename = async () => {
      if ((await card.locator("details").getAttribute("open")) === null)
        await card.locator("summary").click();
      await card.getByRole("button", { name: "重命名", exact: true }).click();
    };
    await openRename();
    const dialog = page.getByRole("dialog", {
      name: "重命名终端",
      exact: true,
    });
    await expect(dialog.getByLabel("终端名称", { exact: true })).toHaveValue(
      initial,
    );
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(card).toBeVisible();
    await openRename();
    await dialog.getByLabel("终端名称", { exact: true }).fill(renamed);
    await dialog.getByRole("button", { name: "保存名称", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(
      (await readState(page)).terminals.find(
        (terminal: { id: string }) => terminal.id === id,
      )?.name,
    ).toBe(renamed);
    await page.getByRole("button", { name: renamed, exact: true }).click();
    await expect(page.locator(".terminal-state")).toContainText("控制中");
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.insertText("echo $WORKDECK_MODAL_TASK");
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-screen")).toContainText("still-running");
    let deletions = 0;
    page.on("request", (request) => {
      if (
        request.method() === "DELETE" &&
        request.url().endsWith("/api/terminals/" + id)
      )
        deletions++;
    });
    await page.getByRole("button", { name: "终止终端", exact: true }).click();
    const confirmation = page.getByRole("dialog", {
      name: "终止终端",
      exact: true,
    });
    await expect(confirmation).toContainText(renamed);
    await expect(confirmation).toContainText("后台任务将被结束");
    await page.screenshot({
      path: "../test-results/termination-site-dialog.png",
    });
    await confirmation
      .getByRole("button", { name: "取消", exact: true })
      .click();
    expect(deletions).toBe(0);
    expect(
      (await readState(page)).terminals.find(
        (terminal: { id: string }) => terminal.id === id,
      )?.state,
    ).toBe("running");
    await terminateCurrentTerminal(page);
    expect(deletions).toBe(1);
    expect(nativeDialogs).toBe(0);
    expect(
      (await readState(page)).terminals.find(
        (terminal: { id: string }) => terminal.id === id,
      )?.desired_state,
    ).toBe("closed");
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
