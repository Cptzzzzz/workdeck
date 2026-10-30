import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const root = process.env.WORKDECK_FILE_TEST_ROOT,
  nodeName = process.env.WORKDECK_TEST_NODE_NAME,
  url = process.env.WORKDECK_TEST_URL || "";
test.skip(
  !root || !nodeName || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url),
  "requires an isolated local node",
);
test("large browser-managed download uses a single-use relay ticket", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "download-ui-")),
    name = `download fixture ${Date.now()}`;
  const bytes = Buffer.alloc(21 * 1024 * 1024 + 31);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i % 13)) & 255;
  const expected = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(path.join(dir, "large.bin"), bytes);
  let id = "",
    csrf = "";
  try {
    await page.addInitScript(() => {
      (window as any).showSaveFilePicker = undefined;
    });
    await page.goto("/?transport=relay");
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
      async ({ nodeName, dir, name }) => {
        const me = await fetch("/api/me").then((r) => r.json()),
          state = await fetch("/api/state").then((r) => r.json());
        const nodes = state.nodes.filter(
          (n: any) => n.name === nodeName && n.online,
        );
        if (nodes.length !== 1) throw new Error("isolated node unavailable");
        const r = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({ node_id: nodes[0].id, name, cwd: dir }),
        });
        if (!r.ok) throw new Error(`fixture ${r.status}`);
        return { terminal: await r.json(), csrf: me.csrf };
      },
      { nodeName, dir, name },
    );
    id = fixture.terminal.id;
    csrf = fixture.csrf;
    const pane = () =>
      execFileSync(
        "tmux",
        [
          "-L",
          `workdeck-${id}`,
          "display-message",
          "-p",
          "-t",
          "main",
          "#{pane_pid}",
        ],
        { encoding: "utf8" },
      ).trim();
    const pid = pane();
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    const event = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载 large.bin" }).click();
    const download = await event;
    await expect(
      page.getByText(/大文件下载已交给浏览器，通过服务器中转/),
    ).toBeVisible();
    expect(await download.failure()).toBeNull();
    const dest = await download.path();
    expect(createHash("sha256").update(readFileSync(dest)).digest("hex")).toBe(
      expected,
    );
    const replay = await page.request.get(download.url());
    expect(replay.status()).toBe(403);
    expect(pane()).toBe(pid);
  } finally {
    if (id && csrf)
      await page.request
        .delete(`/api/terminals/${id}`, {
          headers: { "X-Workdeck-CSRF": csrf },
        })
        .catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
