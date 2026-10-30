import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { selectTestNode } from "./helpers";
const password = readFileSync(
  process.env.WORKDECK_TEST_PASSWORD_FILE || "../.secrets/administrator.txt",
  "utf8",
).trim();
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "你的远程工作台." }),
  ).toBeVisible();
}

test("root service creates root terminals that survive its restart", async ({
  page,
}) => {
  test.skip(
    process.env.WORKDECK_ROOT_ACCEPTANCE !== "1",
    "Requires an explicitly selected root Agent",
  );
  test.setTimeout(150000);
  await login(page);
  let ready = 0;
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => {
      if (typeof frame.payload === "string") {
        try {
          if (JSON.parse(frame.payload).type === "ready") ready++;
        } catch {}
      }
    }),
  );
  const state = await (await page.request.get("/api/state")).json();
  const selected = state.nodes.find(
    (node: { name: string }) =>
      node.name === process.env.WORKDECK_TEST_NODE_NAME,
  );
  expect(selected?.run_user).toBe("root");
  await page
    .getByRole("button", { name: "新建终端", exact: true })
    .first()
    .click();
  await selectTestNode(page);
  await page.getByLabel("终端名称").fill("root服务验收-" + Date.now());
  await page.getByRole("button", { name: "创建并连接" }).click();
  await expect(page.locator(".terminal-state")).toContainText("控制中");
  async function type(command: string) {
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.insertText(command);
    await page.keyboard.press("Enter");
  }
  await type(
    "printf 'service-user='; whoami; printf 'service-uid='; id -u; export WORKDECK_ROOT_RESTART=retained",
  );
  await expect(page.locator(".xterm-screen")).toContainText(
    "service-user=root",
  );
  await expect(page.locator(".xterm-screen")).toContainText("service-uid=0");
  if (process.env.WORKDECK_TEST_SSH_TARGET) {
    const before = ready;
    execFileSync(
      "ssh",
      [
        "-o",
        "ConnectTimeout=10",
        process.env.WORKDECK_TEST_SSH_TARGET,
        "systemctl restart workdeck-agent.service",
      ],
      { timeout: 20000, stdio: "pipe" },
    );
    await expect.poll(() => ready, { timeout: 60000 }).toBeGreaterThan(before);
    await expect(page.locator(".terminal-state")).toContainText("控制中");
    await type('printf "root-session=%s\\n" "$WORKDECK_ROOT_RESTART"');
    await expect(page.locator(".xterm-screen")).toContainText(
      "root-session=retained",
    );
  }
  await page.screenshot({ path: "../test-results/root-service-terminal.png" });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "终止终端", exact: true }).click();
});

test("migrated ordinary-user terminal stays reachable through root Agent", async ({
  page,
}) => {
  const id = process.env.WORKDECK_TEST_LEGACY_TERMINAL_ID;
  test.skip(!id, "Requires a retained pre-migration session");
  await login(page);
  const state = await (await page.request.get("/api/state")).json();
  const terminal = state.terminals.find(
    (terminal: { id: string }) => terminal.id === id,
  );
  expect(terminal?.state).toBe("running");
  await page.getByRole("button", { name: terminal.name, exact: true }).click();
  await expect(page.locator(".terminal-state")).toContainText(
    /控制中|只读连接/,
  );
  await page.getByRole("button", { name: "关闭标签页", exact: true }).click();
  const after = await (await page.request.get("/api/state")).json();
  expect(
    after.terminals.find((terminal: { id: string }) => terminal.id === id)
      ?.state,
  ).toBe("running");
  // Do not send input to or terminate the user's pre-existing session.
});
