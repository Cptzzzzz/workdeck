import { test, expect } from "@playwright/test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.env.WORKDECK_FILE_TEST_ROOT,
  nodeName = process.env.WORKDECK_TEST_NODE_NAME,
  url = process.env.WORKDECK_TEST_URL || "";
test.skip(
  !root || !nodeName || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url),
  "requires an isolated local node",
);

test("refresh updates clean files and protects dirty drafts", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "refresh-ui-")),
    file = path.join(dir, "example.txt"),
    name = `refresh fixture ${Date.now()}`;
  writeFileSync(file, "original\n");
  let id = "",
    csrf = "";
  try {
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
    await page
      .getByRole("button", { name: "example.txt", exact: true })
      .click();
    const editor = page.locator(".monaco-editor textarea.inputarea"),
      screen = page.locator(".monaco-editor .view-lines");
    await expect(screen).toContainText("original");
    writeFileSync(file, "external clean\n");
    writeFileSync(path.join(dir, "new.txt"), "new\n");
    await page.getByRole("button", { name: "刷新文件树" }).click();
    await expect(screen).toContainText("external clean");
    await expect(
      page.getByRole("button", { name: "new.txt", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "example.txt 未保存" }),
    ).toHaveCount(0);
    writeFileSync(path.join(dir, "automatic.txt"), "automatic\n");
    await expect(
      page.getByRole("button", { name: "automatic.txt", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("local draft\n");
    writeFileSync(file, "external conflict\n");
    await page.getByRole("button", { name: "刷新文件树" }).click();
    await expect(
      page
        .locator(".workbench-notice")
        .filter({ hasText: "远端文件已改变，本地草稿已保留" }),
    ).toBeVisible();
    await expect(screen).toContainText("local draft");
    expect(readFileSync(file, "utf8")).toBe("external conflict\n");
    await expect(
      page.getByRole("button", { name: "保存", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置" });
    await settings.getByLabel("停止输入后自动保存文件").check();
    await settings.getByRole("button", { name: "关闭对话框" }).click();
    await page.getByRole("button", { name: "比较远端版本" }).click();
    await expect(page.getByLabel("远端版本与本地草稿差异")).toBeVisible();
    await expect(page.locator(".workbench-compare-toolbar")).toContainText(
      "左侧：远端版本",
    );
    writeFileSync(file, "changed during comparison\n");
    await page
      .getByRole("button", { name: "采用此远端版本作为保存基准" })
      .click();
    await expect(
      page.getByText("远端文件再次变化，请重新比较", { exact: true }),
    ).toBeVisible();
    expect(readFileSync(file, "utf8")).toBe("changed during comparison\n");
    await page.getByRole("button", { name: "比较远端版本" }).click();
    await page
      .getByRole("button", { name: "采用此远端版本作为保存基准" })
      .click();
    await expect(
      page.getByText(
        "已采用所比较的远端版本作为基准；本地草稿未写入，请检查后手动保存。",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(screen).toContainText("local draft");
    expect(readFileSync(file, "utf8")).toBe("changed during comparison\n");
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page
      .getByRole("button", { name: "example.txt", exact: true })
      .click();
    await expect(
      page.getByText("已采用远端版本作为基准；请检查后手动保存。", {
        exact: true,
      }),
    ).toBeVisible();
    await page.waitForTimeout(2000);
    expect(readFileSync(file, "utf8")).toBe("changed during comparison\n");
    writeFileSync(file, "changed before save\n");
    await expect(
      page
        .locator(".workbench-notice")
        .filter({ hasText: "远端文件已改变，本地草稿已保留" }),
    ).toBeVisible();
    expect(readFileSync(file, "utf8")).toBe("changed before save\n");
    await expect(
      page.getByRole("button", { name: "核对保存状态" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "比较远端版本" }).click();
    await page
      .getByRole("button", { name: "采用此远端版本作为保存基准" })
      .click();
    expect(readFileSync(file, "utf8")).toBe("changed before save\n");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => readFileSync(file, "utf8")).toBe("local draft\n");
    await page.getByRole("button", { name: "new.txt", exact: true }).click();
    await expect(screen).toContainText("new");
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("deleted draft\n");
    unlinkSync(path.join(dir, "new.txt"));
    await page.getByRole("button", { name: "刷新文件树" }).click();
    await expect(
      page.getByText("文件不存在或无法访问，本地内容已保留。", { exact: true }),
    ).toBeVisible();
    await expect(screen).toContainText("deleted draft");
    writeFileSync(path.join(dir, "new.txt"), "replacement\n");
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    const drafts = page
      .locator(".workbench-intents")
      .filter({ hasText: "本地未保存草稿" });
    await expect(drafts).toBeVisible();
    await drafts
      .locator("div")
      .filter({ hasText: "new.txt" })
      .getByRole("button", { name: "打开草稿" })
      .click();
    await expect(screen).toContainText("deleted draft");
    await page.getByRole("button", { name: "另存为新文件" }).click();
    const saveAs = page.getByRole("dialog", { name: "另存不可访问的草稿" });
    await saveAs.getByLabel("另存文件名").fill("recovered.txt");
    await saveAs.getByRole("button", { name: "另存", exact: true }).click();
    await expect
      .poll(() => {
        try {
          return readFileSync(path.join(dir, "recovered.txt"), "utf8");
        } catch {
          return "";
        }
      })
      .toBe("deleted draft\n");
    expect(readFileSync(path.join(dir, "new.txt"), "utf8")).toBe(
      "replacement\n",
    );
    writeFileSync(path.join(dir, "orphan.txt"), "orphan original\n");
    await page.getByRole("button", { name: "刷新文件树" }).click();
    await page.getByRole("button", { name: "orphan.txt", exact: true }).click();
    await expect(screen).toContainText("orphan original");
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("orphan draft\n");
    await page.waitForTimeout(800);
    unlinkSync(path.join(dir, "orphan.txt"));
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    const orphanDrafts = page
      .locator(".workbench-intents")
      .filter({ hasText: "本地未保存草稿" });
    await orphanDrafts
      .locator("div")
      .filter({ hasText: "orphan.txt" })
      .getByRole("button", { name: "打开草稿" })
      .click();
    await expect(screen).toContainText("orphan draft");
    await page.getByRole("button", { name: "另存为新文件" }).click();
    const orphanSave = page.getByRole("dialog", { name: "另存不可访问的草稿" });
    await orphanSave.getByLabel("另存文件名").fill("orphan-recovered.txt");
    await orphanSave.getByRole("button", { name: "另存", exact: true }).click();
    await expect
      .poll(() => {
        try {
          return readFileSync(path.join(dir, "orphan-recovered.txt"), "utf8");
        } catch {
          return "";
        }
      })
      .toBe("orphan draft\n");
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
