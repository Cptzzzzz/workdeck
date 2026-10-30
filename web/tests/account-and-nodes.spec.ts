import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";

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

test("password form requires six characters with letters and digits", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  const field = page.getByLabel(/^新密码/);
  await expect(field).toHaveAttribute("minlength", "6");
  await expect(field).not.toHaveAttribute("maxlength");
  for (const value of ["abc123", "ABC123", "Ab1!@#", "A1" + "长".repeat(100)]) {
    await field.fill(value);
    expect(
      await field.evaluate((input: HTMLInputElement) => input.checkValidity()),
    ).toBe(true);
  }
  for (const value of ["", "abcdef", "123456"]) {
    await field.fill(value);
    expect(
      await field.evaluate((input: HTMLInputElement) => input.checkValidity()),
    ).toBe(false);
  }
  await page.getByRole("button", { name: "关闭对话框" }).click();
  // Production credentials are deliberately not changed by this acceptance test.
});

test("rename an offline node without changing its identity", async ({
  page,
}) => {
  await login(page);
  const me = await (await page.request.get("/api/me")).json();
  const headers = { "X-Workdeck-CSRF": me.csrf };
  const enrollment = await (
    await page.request.post("/api/enrollments", { headers })
  ).json();
  const pair = generateKeyPairSync("ed25519");
  const publicKey = (
    pair.publicKey.export({ format: "der", type: "spki" }) as Buffer
  )
    .subarray(-32)
    .toString("base64");
  const initial = "节点改名验收-" + Date.now(),
    renamed = initial + "-已改名";
  const response = await page.request.post("/api/agent/enroll", {
    data: {
      token: enrollment.token,
      name: initial,
      public_key: publicKey,
      proof: sign(
        null,
        Buffer.from("workdeck-enroll:" + enrollment.token),
        pair.privateKey,
      ).toString("base64"),
    },
  });
  expect(response.status()).toBe(201);
  const { node_id: id } = await response.json();
  try {
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await page.locator(".node-item").filter({ hasText: initial }).click();
    page.once("dialog", (dialog) => dialog.accept(renamed));
    await page.getByRole("button", { name: "重命名节点", exact: true }).click();
    await expect(
      page.locator(".node-item").filter({ hasText: renamed }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.locator(".node-item").filter({ hasText: renamed }),
    ).toBeVisible();
    const state = await (await page.request.get("/api/state")).json();
    expect(
      state.nodes.find((node: { id: string }) => node.id === id)?.name,
    ).toBe(renamed);
  } finally {
    await page.request.delete("/api/nodes/" + id, { headers });
  }
});
