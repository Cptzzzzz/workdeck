import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const root = process.env.WORKDECK_FILE_TEST_ROOT,
  nodeName = process.env.WORKDECK_TEST_NODE_NAME,
  url = process.env.WORKDECK_TEST_URL || "";
test.skip(
  process.env.WORKDECK_FILE_RATE_ACCEPTANCE !== "1" ||
    !root ||
    !nodeName ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(url),
  "requires a dedicated localhost Agent configured at 262144 bytes per second",
);

for (const route of ["relay", "direct"] as const) {
  test(`account bandwidth is shared by upload and download on ${route}`, async ({
    page,
  }) => {
    const dir = mkdtempSync(path.join(root!, "rate-ui-"));
    const bundleDir = mkdtempSync(path.join(os.tmpdir(), "workdeck-rate-ui-"));
    const bundle = path.join(bundleDir, "client.js");
    const first = path.join(dir, "first"),
      second = path.join(dir, "second");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(
      path.join(second, "source.bin"),
      Buffer.alloc(512 * 1024, 37),
    );
    const terminals: string[] = [];
    let csrf = "";
    try {
      await build({
        entryPoints: [path.resolve("tests/fixtures/file-client-harness.ts")],
        bundle: true,
        format: "iife",
        platform: "browser",
        outfile: bundle,
      });
      await page.goto(
        route === "relay" ? "/?transport=relay" : "/?file_transport=direct",
      );
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
        async ({ nodeName, first, second, route }) => {
          const me = await fetch("/api/me").then((r) => r.json()),
            state = await fetch("/api/state").then((r) => r.json());
          const nodes = state.nodes.filter(
            (n: any) => n.name === nodeName && n.online,
          );
          if (nodes.length !== 1) throw new Error("isolated node unavailable");
          const created: any[] = [];
          (window as any).__rateCreated = [];
          for (const [index, cwd] of [first, second].entries()) {
            const response = await fetch("/api/terminals", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Workdeck-CSRF": me.csrf,
              },
              body: JSON.stringify({
                node_id: nodes[0].id,
                name: `rate-${route}-${index}-${Date.now()}`,
                cwd,
              }),
            });
            if (!response.ok) throw new Error(`terminal ${response.status}`);
            created.push(await response.json());
            (window as any).__rateCreated.push(created.at(-1).id);
          }
          const workspaces: any[] = [];
          for (const terminal of created) {
            const response = await fetch(
              `/api/terminals/${terminal.id}/workspace`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Workdeck-CSRF": me.csrf,
                },
                body: "{}",
              },
            );
            if (!response.ok) throw new Error(`workspace ${response.status}`);
            workspaces.push((await response.json()).workspace);
          }
          return { created, workspaces, csrf: me.csrf };
        },
        { nodeName, first, second, route },
      );
      csrf = fixture.csrf;
      terminals.push(...fixture.created.map((t: any) => t.id));
      const pane = (id: string) =>
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
      const pids = terminals.map(pane);
      await page.reload();
      await page
        .getByRole("button", { name: fixture.created[0].name, exact: true })
        .click();
      await expect(page.locator(".terminal-state")).toContainText("控制中");
      await page.route("**/__rate-harness.js", (r) =>
        r.fulfill({ path: bundle, contentType: "text/javascript" }),
      );
      await page.addScriptTag({ url: "/__rate-harness.js" });
      const transfer = page.evaluate(
        async ({ workspaces, csrf, route }) => {
          const harness = (window as any).workdeckFileTest;
          harness.setCSRF(csrf);
          const clients = await Promise.all(
            workspaces.map((w: any) => harness.FileClient.connect(w)),
          );
          try {
            if (route === "direct") {
              await Promise.all(
                clients.map(
                  (c: any) =>
                    new Promise<void>((resolve, reject) => {
                      if (c.route === "direct") return resolve();
                      const timer = setTimeout(
                        () =>
                          reject(new Error("file direct route unavailable")),
                        30000,
                      );
                      c.onRoute((r: string) => {
                        if (r === "direct") {
                          clearTimeout(timer);
                          resolve();
                        }
                      });
                    }),
                ),
              );
            }
            const bytes = new Uint8Array(512 * 1024).fill(91);
            const transaction = await clients[0].prepareSave(
              "upload.bin",
              bytes,
              "",
              true,
            );
            (window as any).__rateRunning = true;
            const started = performance.now();
            const [saved, read] = await Promise.all([
              clients[0].save(transaction),
              clients[1].readBytes("source.bin", "", bytes.length),
            ]);
            (window as any).__rateDone = true;
            if (
              saved.state !== "committed" ||
              read.bytes.length !== bytes.length ||
              read.bytes.some((b: number) => b !== 37)
            )
              throw new Error("file data mismatch");
            return {
              elapsed: performance.now() - started,
              routes: clients.map((c: any) => c.route),
            };
          } finally {
            clients.forEach((c: any) => c.close());
          }
        },
        { workspaces: fixture.workspaces, csrf, route },
      );
      await expect
        .poll(() => page.evaluate(() => !!(window as any).__rateRunning), {
          timeout: 35000,
        })
        .toBe(true);
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.insertText(
        "printf '\\122\\101\\124\\105\\137\\117\\113\\n'",
      );
      await page.keyboard.press("Enter");
      await expect(page.locator(".xterm-rows")).toContainText("RATE_OK", {
        timeout: 3000,
      });
      expect(await page.evaluate(() => !!(window as any).__rateDone)).toBe(
        false,
      );
      const result = await transfer;
      expect(result.routes).toEqual([route, route]);
      expect(result.elapsed).toBeGreaterThan(3000);
      expect(readFileSync(path.join(first, "upload.bin"))).toEqual(
        Buffer.alloc(512 * 1024, 91),
      );
      expect(terminals.map(pane)).toEqual(pids);
    } finally {
      const partial = await page
        .evaluate(async () => ({
          ids: (window as any).__rateCreated || [],
          csrf: (await fetch("/api/me").then((r) => r.json())).csrf,
        }))
        .catch(() => ({ ids: [], csrf: "" }));
      for (const id of partial.ids)
        if (!terminals.includes(id)) terminals.push(id);
      if (!csrf) csrf = partial.csrf;
      for (const id of terminals)
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
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });
}
