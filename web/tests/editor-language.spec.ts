import { test, expect } from "@playwright/test";

test("code language detection, highlighting, manual selection and find", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/monaco-harness.html");
  const language = page.getByLabel("代码语言模式");
  await expect(language.locator("option:checked")).toContainText("python");
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
  await expect(language.locator("option:checked")).toContainText("dockerfile");
  await page.getByRole("button", { name: "JSON" }).click();
  await expect(language.locator("option:checked")).toContainText("json");
  await language.selectOption("python");
  await expect(language).toHaveValue("python");
  await expect(page.getByTestId("text")).toHaveText('{"enabled": true}\n');
  await page.locator(".monaco-editor textarea.inputarea").focus();
  await page.keyboard.press("Control+f");
  await expect(page.locator(".monaco-editor .find-widget")).toBeVisible();
});
