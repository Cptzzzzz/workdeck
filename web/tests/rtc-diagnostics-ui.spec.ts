import { test, expect } from "@playwright/test";

test("failed ICE diagnostic remains available after reconnect and excludes sensitive values", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/tests/fixtures/rtc-diagnostic-harness.html");
  await expect(page.locator(".terminal-network summary").first()).toContainText(
    "WebSocket",
  );
  await page.locator(".terminal-network > summary").click();
  const diagnostic = page.locator(".rtc-diagnostic");
  await diagnostic.locator("summary").click();
  await expect(diagnostic).toContainText("ICE 或连接状态失败", {
    timeout: 12000,
  });
  await expect(diagnostic).toContainText("host/udp：1");
  await expect(diagnostic).toContainText("srflx/udp：1");
  await expect(diagnostic).toContainText("发请求 4 / 收响应 0");
  await expect(diagnostic).toContainText("应用 2 / 失败 1", { timeout: 10000 });
  await expect(diagnostic).toContainText("发请求 9 / 收响应 0");
  await diagnostic.getByRole("button", { name: "复制诊断摘要" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  for (const secret of [
    "192.0.2",
    "198.51.100",
    "12345",
    "54321",
    "private-password",
    "private-local-id",
    "private-candidate-id",
    "a=ice-pwd",
  ])
    expect(copied).not.toContain(secret);
  expect(JSON.parse(copied)).toMatchObject({
    outcome: "ice_failed",
    ice: "failed",
    pairs: [{ requestsSent: 4, responsesReceived: 0 }],
    node: {
      remoteApplied: 2,
      remoteRejected: 1,
      pairs: [{ requestsSent: 9, responsesReceived: 0 }],
    },
  });
  await page
    .getByRole("button", { name: "重连测试" })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(diagnostic).toContainText("本标签页最近一次检测");
  await expect(diagnostic).toContainText("ICE 或连接状态失败");
});
