import { test, expect } from "@playwright/test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

const nodeName = process.env.WORKDECK_TEST_NODE_NAME;
test.skip(
  !nodeName ||
    !process.env.WORKDECK_TEST_PASSWORD_FILE ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.WORKDECK_TEST_URL || ""),
  "requires an isolated local node",
);

test("multiple terminals open their own workspace while local draft storage is stalled", async ({
  page,
}) => {
  const dir = mkdtempSync(
    path.join(os.tmpdir(), "workdeck-workspace-loading-"),
  );
  const roots = [path.join(dir, "first"), path.join(dir, "second")];
  roots.forEach((root, i) => {
    mkdirSync(root);
    writeFileSync(path.join(root, `unique-${i}.txt`), `content-${i}\n`);
  });
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name: string, version?: number) {
      if (name === "workdeck-workspace-drafts") return {} as IDBOpenDBRequest;
      return open.call(this, name, version);
    };
  });
  const ids: string[] = [];
  let csrf = "";
  try {
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
    const fixture = await page.evaluate(
      async ({ nodeName, roots }) => {
        const me = await fetch("/api/me").then((r) => r.json());
        const state = await fetch("/api/state").then((r) => r.json());
        const node = state.nodes.find(
          (n: { name: string; online: boolean }) =>
            n.name === nodeName && n.online,
        );
        if (!node) throw new Error("isolated node unavailable");
        const ids = [];
        for (let i = 0; i < roots.length; i++) {
          const r = await fetch("/api/terminals", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Workdeck-CSRF": me.csrf,
            },
            body: JSON.stringify({
              node_id: node.id,
              name: `loading-terminal-${i}`,
              cwd: roots[i],
            }),
          });
          if (!r.ok) throw new Error("terminal creation failed");
          ids.push((await r.json()).id);
        }
        return { ids, csrf: me.csrf };
      },
      { nodeName, roots },
    );
    ids.push(...fixture.ids);
    csrf = fixture.csrf;
    await expect
      .poll(async () =>
        page.evaluate(async (ids) => {
          const s = await fetch("/api/state").then((r) => r.json());
          return ids.every((id: string) =>
            s.terminals.some(
              (t: { id: string; state: string }) =>
                t.id === id && t.state === "running",
            ),
          );
        }, ids),
      )
      .toBe(true);
    // Simulate the common interval where the node has started the process
    // but the browser's most recent inventory still says "creating".
    await page.route("**/api/state", async (route) => {
      const response = await route.fetch();
      const state = await response.json();
      const terminal = state.terminals?.find(
        (item: { id: string }) => item.id === ids[1],
      );
      if (terminal) terminal.state = "creating";
      await route.fulfill({ response, json: state });
    });
    await page.reload();
    await page
      .getByRole("button", { name: "loading-terminal-0", exact: true })
      .click();
    await expect(
      page.locator(".terminal-workspace:not(.hidden) .terminal-state"),
    ).toContainText("控制中");
    await page.getByRole("button", { name: "返回概览" }).click();
    await page
      .getByRole("button", { name: "loading-terminal-1", exact: true })
      .click();
    await expect(
      page.locator(".terminal-workspace:not(.hidden) .terminal-state"),
    ).toContainText("控制中");
    await page.getByRole("button", { name: "返回概览" }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await expect(
      page
        .locator("aside")
        .getByRole("button", { name: "unique-1.txt", exact: true }),
    ).toBeVisible({ timeout: 5000 });
    await page
      .locator("aside")
      .getByRole("button", { name: "unique-1.txt", exact: true })
      .click();
    await expect(page.locator(".monaco-editor")).toBeVisible({
      timeout: 12000,
    });
    await expect(
      page.locator(".workbench-notice").filter({ hasText: "草稿" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "终端模式", exact: true }).click();
    await page
      .locator(".terminal-tab")
      .getByRole("button", { name: "loading-terminal-0", exact: true })
      .click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await expect(
      page
        .locator("aside")
        .getByRole("button", { name: "unique-0.txt", exact: true }),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page
        .locator("aside")
        .getByRole("button", { name: "unique-1.txt", exact: true }),
    ).toHaveCount(0);
    await page
      .locator("aside")
      .getByRole("button", { name: "unique-0.txt", exact: true })
      .click();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText(
      "content-0",
      { timeout: 12000 },
    );
    await page.getByRole("button", { name: "终端模式", exact: true }).click();
    await page
      .locator(".terminal-tab")
      .getByRole("button", { name: "loading-terminal-1", exact: true })
      .click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await expect(
      page
        .locator("aside")
        .getByRole("button", { name: "unique-1.txt", exact: true }),
    ).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".monaco-editor .view-lines")).toContainText(
      "content-1",
      { timeout: 12000 },
    );
  } finally {
    for (const id of ids)
      await page
        .evaluate(
          async ({ id, csrf }) => {
            await fetch(`/api/terminals/${id}`, {
              method: "DELETE",
              headers: { "X-Workdeck-CSRF": csrf },
            });
          },
          { id, csrf },
        )
        .catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
