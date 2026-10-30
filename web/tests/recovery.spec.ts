import { terminateCurrentTerminal } from "./helpers";
import { selectTestNode } from "./helpers";
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
  const sshTarget = process.env.WORKDECK_TEST_SSH_TARGET;
  test.skip(
    !sshTarget,
    "Set WORKDECK_TEST_SSH_TARGET before enabling service-restart acceptance",
  );
  const deployDir =
    process.env.WORKDECK_TEST_DEPLOY_DIR || "/opt/stacks/workdeck";
  const shellQuote = (value: string) =>
    "'" + value.replaceAll("'", "'\"'\"'") + "'";
  test.setTimeout(150000);
  let readyCount = 0;
  page.on("websocket", (ws) =>
    ws.on("framereceived", (frame) => {
      if (typeof frame.payload === "string") {
        try {
          if (JSON.parse(frame.payload).type === "ready") readyCount++;
        } catch {}
      }
    }),
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
  const name = "恢复验收-" + Date.now();
  await page
    .getByRole("button", { name: "新建终端", exact: true })
    .first()
    .click();
  await selectTestNode(page);
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
  const program = `import curses
def main(s):
 while True:
  s.erase()
  s.addstr(0,0,'TUI-ALIVE '+str(s.getmaxyx()))
  s.refresh()
  if s.getch()==ord('q'): break
curses.wrapper(main)
`;
  await type(
    `python3 -c "exec(__import__('base64').b64decode('${Buffer.from(program).toString("base64")}'))"`,
  );
  await expect(page.locator(".xterm-screen")).toContainText("TUI-ALIVE");
  await page.setViewportSize({ width: 1024, height: 768 });
  let before = readyCount;
  execFileSync("systemctl", ["--user", "restart", "workdeck-agent.service"], {
    timeout: 20000,
  });
  await expect
    .poll(() => readyCount, { timeout: 45000 })
    .toBeGreaterThan(before);
  await expect(page.locator(".terminal-state")).toContainText("控制中");
  await expect(page.locator(".xterm-screen")).toContainText("TUI-ALIVE");
  before = readyCount;
  execFileSync("ssh", [sshTarget!, "sh", "-s"], {
    timeout: 30000,
    stdio: "pipe",
    input: `set -eu
cd ${shellQuote(deployDir)}
docker compose restart hub
`,
  });
  await expect
    .poll(() => readyCount, { timeout: 60000 })
    .toBeGreaterThan(before);
  await expect(page.locator(".terminal-state")).toContainText("控制中");
  await expect(page.locator(".xterm-screen")).toContainText("TUI-ALIVE");
  // Exit only the test TUI and verify its original parent shell still has its environment.
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("q");
  await type('printf "recovered=%s\\n" "$WORKDECK_RECOVERY"');
  await expect(page.locator(".xterm-screen")).toContainText(
    "recovered=" + marker,
  );
  await page.screenshot({ path: "../test-results/service-recovery.png" });
  await terminateCurrentTerminal(page);
});
