import { test, expect } from "@playwright/test";

test("code highlighting and find without a language toolbar", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/monaco-harness.html");
  await expect(page.getByLabel("代码语言模式")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        new Set(
          await page
            .locator(".monaco-editor .view-lines span[class*='mtk']")
            .evaluateAll((items) => items.map((item) => item.className)),
        ).size,
    )
    .toBeGreaterThan(1);
  await page.getByRole("button", { name: "Dockerfile" }).click();
  await expect(page.getByTestId("text")).toContainText("FROM alpine");
  await page.getByRole("button", { name: "JSON" }).click();
  await expect(page.getByTestId("text")).toHaveText('{"enabled": true}\n');
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+f");
  await expect(page.locator(".monaco-editor .find-widget")).toBeVisible();
});
