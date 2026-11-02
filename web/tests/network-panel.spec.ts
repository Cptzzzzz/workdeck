import { test, expect } from "@playwright/test";

test("shows every transport, truthful unmeasured states, current route and policy", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/network-panel-harness.html");
  await page.locator(".terminal-network > summary").click();
  const panel = page.locator(".network-details");
  const http = panel.getByLabel("HTTP 流式中转指标", { exact: true });
  const ws = panel.getByLabel("WebSocket 中转指标", { exact: true });
  await expect(http).toHaveClass(/selected/);
  await expect(http).toContainText("18 ms");
  await expect(ws).toContainText("建连失败");
  await expect(ws.locator(".network-latency strong")).toHaveText("—");
  await expect(
    panel.getByLabel("WebRTC 直连指标", { exact: true }),
  ).toContainText("不可用");
  await expect(
    panel.getByLabel("Tailnet 候选指标", { exact: true }),
  ).toContainText("未配置");
  await expect(panel.locator(".network-path-card.selected")).toHaveCount(1);
  await http.locator(".network-card-extra > summary").click();
  await expect(http).toContainText("42 ms");
  await ws.locator(".network-card-extra > summary").click();
  await expect(ws).toContainText("2 次");
  await panel.getByLabel("链路策略").selectOption("balanced");
  await expect(panel.getByLabel("链路策略")).toHaveValue("balanced");
  await panel.getByRole("button", { name: "关闭网络详情" }).click();
  await expect(page.locator(".terminal-network")).not.toHaveAttribute(
    "open",
    "",
  );
  await page.getByRole("button", { name: "模拟直连" }).click();
  await page.locator(".terminal-network > summary").click();
  await expect(
    panel.getByLabel("WebRTC 直连指标", { exact: true }),
  ).toHaveClass(/selected/);
  await expect(
    panel.getByLabel("HTTP 流式中转指标", { exact: true }),
  ).toContainText("备用就绪");
  await expect(
    panel.getByLabel("其他接口候选指标", { exact: true }),
  ).toContainText("不可用");
  await expect(
    panel.getByLabel("Tailnet 候选指标", { exact: true }),
  ).toContainText("11 ms");
  await expect(panel.locator(".network-path-card.selected")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".terminal-network")).not.toHaveAttribute(
    "open",
    "",
  );
  await expect(page.locator(".terminal-network > summary")).toBeFocused();
  await page.getByRole("button", { name: "模拟连接中" }).click();
  await page.locator(".terminal-network > summary").click();
  await expect(panel.locator(".network-path-card.selected")).toHaveCount(0);
  await expect(panel.locator(".network-current-copy")).toContainText(
    "正在连接",
  );
  await expect(
    panel.getByLabel("HTTP 流式中转指标", { exact: true }),
  ).toContainText("未启用");
});

test("network popover stays inside desktop windows", async ({ page }) => {
  for (const size of [
    { width: 1440, height: 1000 },
    { width: 900, height: 600 },
    { width: 600, height: 500 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/tests/fixtures/network-panel-harness.html");
    await page.locator(".terminal-network > summary").click();
    const panel = page.locator(".network-details");
    await expect(panel).toBeVisible();
    await expect
      .poll(async () => {
        const b = await panel.boundingBox();
        return (
          !!b &&
          b.x >= 10 &&
          b.y >= 10 &&
          b.x + b.width <= size.width - 10 &&
          b.y + b.height <= size.height - 10
        );
      })
      .toBe(true);
  }
});
