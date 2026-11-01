import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const nodeName = process.env.WORKDECK_TEST_NODE_NAME;
test.skip(
  !nodeName ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.WORKDECK_TEST_URL || ""),
  "requires an isolated local node",
);

test("hardware inventory is visible in both node views", async ({ page }) => {
  await page.goto("/");
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
  await expect
    .poll(
      async () =>
        page.evaluate(async (name) => {
          const state = await fetch("/api/state").then((r) => r.json());
          return !!state.nodes.find(
            (node: any) =>
              node.name === name &&
              node.hardware?.memory_bytes &&
              node.hardware?.logical_cpus,
          );
        }, nodeName),
      { timeout: 25000 },
    )
    .toBe(true);
  await page.getByRole("button", { name: "刷新状态" }).click();
  await page.locator(".node-item").filter({ hasText: nodeName }).click();
  const overview = page.locator(".overview:not(.hidden) .node-hardware");
  await expect(overview).toContainText("处理器");
  await expect(overview).toContainText("逻辑 CPU");
  await expect(overview).toContainText("内存");
  await expect(overview).toContainText("硬盘");
  await page.getByRole("button", { name: "工作区模式" }).click();
  await page.getByRole("button", { name: "节点管理" }).click();
  const dialog = page.getByRole("dialog", { name: "节点管理" });
  const node = dialog.locator(".management-item").filter({ hasText: nodeName });
  await node.locator(".node-hardware summary").click();
  await expect(node.locator(".node-hardware")).toContainText("CPU 核心");
  await expect(node.locator(".node-hardware")).toContainText("硬盘");
  await expect(node.locator(".node-hardware")).toContainText("显卡");
});
