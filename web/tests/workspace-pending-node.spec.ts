import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = process.env.WORKDECK_FILE_TEST_ROOT,
  nodeName = process.env.WORKDECK_TEST_NODE_NAME,
  url = process.env.WORKDECK_TEST_URL || "";
test.skip(
  !root || !nodeName || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url),
  "requires an isolated local node",
);

test("orphaned writes can be inspected and canceled without overwriting files", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "pending-node-"));
  const bundleDir = mkdtempSync(
    path.join(os.tmpdir(), "workdeck-pending-test-"),
  );
  const bundle = path.join(bundleDir, "harness.js");
  const name = `pending fixture ${Date.now()}`;
  writeFileSync(path.join(dir, "guarded.txt"), "original guarded");
  writeFileSync(path.join(dir, "orphan.txt"), "original orphan");
  writeFileSync(path.join(dir, "lost.txt"), "original lost");
  writeFileSync(path.join(dir, "unsent.txt"), "original unsent");
  const nextRoot = path.join(dir, "next-root");
  mkdirSync(nextRoot);
  let id = "",
    csrf = "";
  try {
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        private dropID = "";
        private failedLists = new Set<string>();
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (!String(url).includes("/api/workspaces/")) return;
          Object.defineProperty(this, "onmessage", {
            set: (handler: (event: MessageEvent) => void) => {
              this.addEventListener("message", (event) => {
                if (typeof event.data === "string" && this.failedLists.size) {
                  try {
                    const value = JSON.parse(event.data);
                    if (this.failedLists.delete(value.request_id)) {
                      value.payload = {
                        error: {
                          code: "ROOT_REPLACED",
                          message: "测试目录身份已改变",
                        },
                      };
                      handler(
                        new MessageEvent("message", {
                          data: JSON.stringify(value),
                        }),
                      );
                      return;
                    }
                  } catch {}
                }
                if (typeof event.data === "string" && this.dropID) {
                  try {
                    const value = JSON.parse(event.data);
                    if (
                      value.request_id === this.dropID &&
                      value.payload?.result?.state === "aborted"
                    ) {
                      this.dropID = "";
                      this.close();
                      return;
                    }
                  } catch {}
                }
                handler(event);
              });
            },
          });
        }
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (
            typeof data === "string" &&
            (window as any).__dropBeforePendingCancel
          ) {
            try {
              const value = JSON.parse(data);
              if (value.type === "operation.pending.cancel") {
                (window as any).__dropBeforePendingCancel = false;
                this.close();
                return;
              }
            } catch {}
          }
          if (
            typeof data === "string" &&
            sessionStorage.getItem("pending-test-root-failure") === "1"
          ) {
            try {
              const value = JSON.parse(data);
              if (value.type === "directory.list")
                this.failedLists.add(value.request_id);
            } catch {}
          }
          if (typeof data === "string" && (window as any).__dropPendingCancel) {
            try {
              const value = JSON.parse(data);
              if (value.type === "operation.pending.cancel") {
                this.dropID = value.request_id;
                (window as any).__dropPendingCancel = false;
              }
            } catch {}
          }
          return super.send(data);
        }
      };
    });
    await build({
      entryPoints: [path.resolve("tests/fixtures/file-client-harness.ts")],
      bundle: true,
      format: "iife",
      platform: "browser",
      outfile: bundle,
    });
    const direct = process.env.WORKDECK_PENDING_DIRECT === "1";
    await page.goto(direct ? "/?file_transport=direct" : "/?transport=relay");
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
          (n: any) =>
            n.name === nodeName &&
            n.online &&
            n.capabilities.includes("workspace-pending-v1"),
        );
        if (nodes.length !== 1)
          throw new Error("isolated pending-capable node unavailable");
        const response = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({ node_id: nodes[0].id, name, cwd: dir }),
        });
        if (!response.ok) throw new Error(`fixture ${response.status}`);
        return { terminal: await response.json(), csrf: me.csrf };
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
    if (direct)
      await expect(page.locator(".workbench-route")).toContainText(
        "WebRTC 直连",
        { timeout: 30000 },
      );
    await page.route("**/__pending-harness.js", (route) =>
      route.fulfill({ path: bundle, contentType: "text/javascript" }),
    );
    await page.addScriptTag({ url: "/__pending-harness.js" });
    const ids = await page.evaluate(
      async ({ id, csrf }) => {
        const h = (window as any).workdeckFileTest;
        h.setCSRF(csrf);
        const workspace = (
          await fetch(`/api/terminals/${id}/workspace`).then((r) => r.json())
        ).workspace;
        const client = await h.FileClient.connect(workspace);
        const transactions: any[] = [];
        for (const name of [
          "guarded.txt",
          "orphan.txt",
          "lost.txt",
          "unsent.txt",
        ]) {
          const version = (await client.stat(name)).version;
          const tx = await client.prepareSave(
            name,
            new TextEncoder().encode("remote update"),
            version,
            false,
          );
          await client.request("file.write.begin", {
            op_id: tx.opID,
            spec: tx.spec,
          });
          transactions.push(tx);
        }
        const item = (await client.pendingWrites(0)).items[0];
        await h.pendingCancels.rememberPendingCancel(workspace, item);
        const changed = { ...item, updated_at: item.updated_at + 1 };
        let refusedRepeat = false,
          refusedReplace = false,
          refusedDelete = false;
        try {
          await h.pendingCancels.rememberPendingCancel(workspace, item);
        } catch {
          refusedRepeat = true;
        }
        try {
          await h.pendingCancels.rememberPendingCancel(workspace, changed);
        } catch {
          refusedReplace = true;
        }
        try {
          await h.pendingCancels.forgetPendingCancel(workspace, changed);
        } catch {
          refusedDelete = true;
        }
        if (
          !refusedRepeat ||
          !refusedReplace ||
          !refusedDelete ||
          (await h.pendingCancels.listPendingCancels(workspace)).length !== 1
        )
          throw new Error("stale browser record was not protected");
        await h.pendingCancels.forgetPendingCancel(workspace, item);
        (window as any).__pendingActor = { client, transactions };
        return transactions.map((tx) => tx.opID);
      },
      { id, csrf },
    );
    const shared = await page.evaluate(async () => {
      const h = (window as any).workdeckFileTest,
        client = (window as any).__pendingActor.client;
      const item = (await client.pendingWrites(0)).items[0],
        workspace = client.workspace;
      await h.pendingCancels.rememberPendingCancel(workspace, item);
      return { workspace, item };
    });
    const sibling = await page.context().newPage();
    try {
      await sibling.goto("/");
      await sibling.route("**/__pending-harness.js", (route) =>
        route.fulfill({ path: bundle, contentType: "text/javascript" }),
      );
      await sibling.addScriptTag({ url: "/__pending-harness.js" });
      const protectedRecord = await sibling.evaluate(
        async ({ workspace, item }) => {
          const store = (window as any).workdeckFileTest.pendingCancels;
          let rejected = false;
          try {
            await store.forgetPendingCancel(workspace, {
              ...item,
              updated_at: item.updated_at + 1,
            });
          } catch {
            rejected = true;
          }
          return (
            rejected &&
            (await store.listPendingCancels(workspace)).some(
              (v: any) => v.id === item.id,
            )
          );
        },
        shared,
      );
      expect(protectedRecord).toBe(true);
    } finally {
      await sibling.close();
    }
    await page.evaluate(
      async ({ workspace, item }) =>
        (window as any).workdeckFileTest.pendingCancels.forgetPendingCancel(
          workspace,
          item,
        ),
      shared,
    );
    await page.getByRole("button", { name: "查看节点待处理写入" }).click();
    const dialog = page.getByRole("dialog", { name: "节点待处理写入" });
    const row = (name: string) =>
      dialog.locator(".management-item").filter({ hasText: name });
    await expect(row("guarded.txt")).toBeVisible();
    await expect(row("orphan.txt")).toBeVisible();
    await row("guarded.txt")
      .getByRole("button", { name: "核对并取消" })
      .click();
    await page.evaluate(async () => {
      const a = (window as any).__pendingActor;
      await a.client.save(a.transactions[0]);
    });
    await dialog.getByRole("button", { name: "确认取消写入" }).click();
    await expect(dialog.locator(".form-error")).toContainText("操作状态已变化");
    expect(readFileSync(path.join(dir, "guarded.txt"), "utf8")).toBe(
      "remote update",
    );
    await dialog.getByRole("button", { name: "刷新列表" }).click();
    await expect(row("guarded.txt")).toHaveCount(0);
    const tracking = () =>
      dialog
        .locator(".workbench-notice")
        .filter({ hasText: "本浏览器待核对的取消请求" });
    await expect(tracking()).toContainText("guarded.txt");
    await tracking().getByRole("button", { name: "核对取消结果" }).click();
    await expect(tracking()).toHaveCount(0);
    await row("orphan.txt").getByRole("button", { name: "核对并取消" }).click();
    await dialog.getByRole("button", { name: "确认取消写入" }).click();
    await expect(dialog.getByText(/节点已确认取消/)).toBeVisible();
    await expect(row("orphan.txt")).toHaveCount(0);
    expect(readFileSync(path.join(dir, "orphan.txt"), "utf8")).toBe(
      "original orphan",
    );
    const status = await page.evaluate(
      async (id) => (window as any).__pendingActor.client.operationStatus(id),
      ids[1],
    );
    expect(status.state).toBe("aborted");
    expect(pane()).toBe(pid);
    await page.evaluate(() => (window as any).__pendingActor.client.close());
    await row("unsent.txt").getByRole("button", { name: "核对并取消" }).click();
    if (!direct) {
      await page.evaluate(() => {
        (window as any).__dropBeforePendingCancel = true;
      });
      await dialog.getByRole("button", { name: "确认取消写入" }).click();
      await expect(dialog.locator(".form-error")).toBeVisible();
      await page.reload();
      await page.getByRole("button", { name, exact: true }).click();
      await page.getByRole("button", { name: "查看节点待处理写入" }).click();
      await expect(tracking()).toContainText("unsent.txt");
      await tracking().getByRole("button", { name: "核对取消结果" }).click();
      await expect(dialog.getByText(/写入仍未提交/)).toBeVisible();
      await tracking().getByRole("button", { name: "移除本地记录" }).click();
      await dialog.getByRole("button", { name: "确认移除本地记录" }).click();
      await expect(tracking()).toHaveCount(0);
      await row("unsent.txt")
        .getByRole("button", { name: "核对并取消" })
        .click();
      await page.addScriptTag({ url: "/__pending-harness.js" });
    }
    await dialog.getByRole("button", { name: "确认取消写入" }).click();
    await expect(row("unsent.txt")).toHaveCount(0);
    expect(readFileSync(path.join(dir, "unsent.txt"), "utf8")).toBe(
      "original unsent",
    );
    await row("lost.txt").getByRole("button", { name: "核对并取消" }).click();
    if (!direct) {
      await page.evaluate(() => {
        (window as any).__dropPendingCancel = true;
      });
      await dialog.getByRole("button", { name: "确认取消写入" }).click();
      await expect(dialog.locator(".form-error")).toBeVisible();
      await page.evaluate(
        async ({ id, csrf, opID, nextRoot }) => {
          const h = (window as any).workdeckFileTest;
          h.setCSRF(csrf);
          const current = (
            await fetch(`/api/terminals/${id}/workspace`).then((r) => r.json())
          ).workspace;
          const client = await h.FileClient.connect(current);
          try {
            if ((await client.operationStatus(opID)).state !== "aborted")
              throw new Error("cancellation did not reach node");
          } finally {
            client.close();
          }
          const response = await fetch(`/api/terminals/${id}/workspace`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "X-Workdeck-CSRF": csrf,
            },
            body: JSON.stringify({
              root_path: nextRoot,
              root_revision: current.root_revision,
            }),
          });
          if (!response.ok) throw new Error(`root change ${response.status}`);
        },
        { id, csrf, opID: ids[2], nextRoot },
      );
      await page.reload();
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.locator(".workbench-root")).toContainText("next-root");
      await page.getByRole("button", { name: "查看节点待处理写入" }).click();
      await expect(tracking()).toContainText("lost.txt");
      await tracking().getByRole("button", { name: "核对取消结果" }).click();
      await expect(dialog.getByText(/节点已确认取消/)).toBeVisible();
      await expect(tracking()).toHaveCount(0);
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await page.evaluate(() =>
        sessionStorage.setItem("pending-test-root-failure", "1"),
      );
      await page.reload();
      await page.getByRole("button", { name, exact: true }).click();
      const pendingButton = page.getByRole("button", {
        name: "查看节点待处理写入",
      });
      await expect(pendingButton).toBeEnabled();
      await pendingButton.click();
      await expect(dialog.getByText("没有待处理的写入。")).toBeVisible();
    } else {
      await dialog.getByRole("button", { name: "确认取消写入" }).click();
      await expect(dialog.getByText(/节点已确认取消/)).toBeVisible();
    }
    expect(readFileSync(path.join(dir, "lost.txt"), "utf8")).toBe(
      "original lost",
    );
    expect(pane()).toBe(pid);
  } finally {
    if (id && csrf)
      await page.request
        .delete(`/api/terminals/${id}`, {
          headers: { "X-Workdeck-CSRF": csrf },
        })
        .catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
  }
});
