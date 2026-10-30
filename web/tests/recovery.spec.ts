import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

test("terminal process survives Agent and Hub service restart", async ({
  page,
}) => {
  test.skip(
    process.env.WORKDECK_RECOVERY !== "1",
    "Explicitly enable this test in the deployed acceptance environment",
  );
  test.setTimeout(150000);
  const password = readFileSync(
    process.env.WORKDECK_TEST_PASSWORD_FILE || "../.secrets/administrator.txt",
    "utf8",
  ).trim();
  await page.goto("/");
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.locator(".node-item .online")).toHaveCount(1);
  const name = "恢复验收-" + Date.now();
  await page
    .getByRole("button", { name: "新建终端", exact: true })
    .first()
    .click();
  await page.getByLabel("终端名称").fill(name);
  await page.getByRole("button", { name: "创建并连接" }).click();
  await expect(page.locator(".terminal-state")).toContainText("控制中");
  const type = async (s: string) => {
    await page
      .locator(".terminal-workspace:not(.hidden) .xterm-helper-textarea")
      .focus();
    await page.keyboard.insertText(s);
    await page.keyboard.press("Enter");
  };
  const marker = "WORKDECK_RECOVERY_" + Date.now();
  await type(`export WORKDECK_RECOVERY=${marker}`);
  // Exercise a real alternate-screen TUI and its resize handler, not only line-oriented output.
  const program =
    "import curses; curses.wrapper(lambda s: (s.addstr(0,0,'TUI-ALIVE: resize and reconnect'),s.refresh(),s.getch()))";
  await type("python3 -c " + JSON.stringify(program));
  await expect(page.locator(".xterm-screen")).toContainText("TUI-ALIVE");
  await page.setViewportSize({ width: 1024, height: 768 });
  execFileSync("systemctl", ["--user", "restart", "workdeck-agent.service"], {
    timeout: 20000,
  });
  await expect(page.locator(".terminal-state")).toContainText("控制中", {
    timeout: 45000,
  });
  await expect(page.locator(".xterm-screen")).toContainText("TUI-ALIVE");
  execFileSync(
    "ssh",
    [
      "root@server.example.com",
      "cd /opt/stacks/workdeck && docker compose restart hub",
    ],
    { timeout: 30000, stdio: "pipe" },
  );
  await expect(page.locator(".terminal-state")).toContainText("控制中", {
    timeout: 60000,
  });
  await expect(page.locator(".xterm-screen")).toContainText("TUI-ALIVE");
  // Exit only the test TUI and verify its original parent shell still has its environment.
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("q");
  await type('printf "recovered=%s\\n" "$WORKDECK_RECOVERY"');
  await expect(page.locator(".xterm-screen")).toContainText(
    "recovered=" + marker,
  );
  await page.screenshot({ path: "../test-results/service-recovery.png" });
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "终止终端", exact: true }).click();
});
