import { test, expect } from "@playwright/test";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
const root = process.env.WORKDECK_FILE_TEST_ROOT,
  nodeName = process.env.WORKDECK_TEST_NODE_NAME,
  testURL = process.env.WORKDECK_TEST_URL || "";
test.skip(
  !root || !nodeName || !/^http:\/\/127\.0\.0\.1:\d+$/.test(testURL),
  "requires a dedicated local test node",
);
function fixturePDF(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "<< /Length 42 >>\nstream\nBT /F1 20 Tf 30 200 Td (First page) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Length 43 >>\nstream\nBT /F1 20 Tf 30 200 Td (Second page) Tj ET\nendstream",
    "<< /Length 2097152 >>\nstream\n" +
      " ".repeat(2 * 1024 * 1024) +
      "\nendstream",
  ];
  // The large unreferenced stream lets the test measure range loading.
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
test("safe Markdown, images and PDF use the workspace connection", async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(root!, "preview-ui-"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  );
  writeFileSync(path.join(dir, "pixel.png"), png);
  writeFileSync(
    path.join(dir, "attack.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" onload="window.svgExecuted=true"></svg>',
  );
  mkdirSync(path.join(dir, "notes"));
  writeFileSync(path.join(dir, "notes", "info.txt"), "relative link target\n");
  writeFileSync(
    path.join(dir, "guide.md"),
    "# 安全文档\n\n![本地图](pixel.png)\n\n![外链图](https://example.invalid/tracker.png)\n\n![越界图](../outside.png)\n\n![编码越界](%2e%2e/outside.png)\n\n![数据图](data:image/svg+xml,malicious)\n\n![SVG图片](attack.svg)\n\n[本地文件](notes/info.txt)\n\n[危险链接](javascript:alert(1))\n\n<script>window.previewExecuted=true</script>\n",
  );
  writeFileSync(path.join(dir, "document.pdf"), fixturePDF());
  const external: string[] = [],
    pageErrors: string[] = [],
    directFiles: string[] = [];
  let fileBytes = 0;
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/api/workspaces/")) return;
    socket.on("framereceived", (frame) => {
      if (
        Buffer.isBuffer(frame.payload) &&
        frame.payload.subarray(0, 4).toString() === "WDF1"
      )
        fileBytes += frame.payload.length - 48;
    });
  });
  page.on("request", (request) => {
    const url = request.url();
    if (/\/(?:guide\.md|pixel\.png|document\.pdf)(?:[?#]|$)/.test(url))
      directFiles.push(url);
    if (/^https?:/.test(url) && new URL(url).hostname !== "127.0.0.1")
      external.push(url);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const revoke = URL.revokeObjectURL.bind(URL);
    (window as any).previewRevokes = 0;
    URL.revokeObjectURL = (url) => {
      (window as any).previewRevokes++;
      revoke(url);
    };
  });
  let id = "",
    csrf = "";
  const name = `preview fixture ${Date.now()}`;
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
      async ({ name, dir, nodeName }) => {
        const me = await fetch("/api/me").then((r) => r.json()),
          state = await fetch("/api/state").then((r) => r.json());
        const nodes = state.nodes.filter(
          (n: any) => n.name === nodeName && n.online,
        );
        if (nodes.length !== 1) throw new Error("fixture node unavailable");
        const response = await fetch("/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workdeck-CSRF": me.csrf,
          },
          body: JSON.stringify({ node_id: nodes[0].id, name, cwd: dir }),
        });
        if (!response.ok) throw new Error(`create ${response.status}`);
        return { terminal: await response.json(), csrf: me.csrf };
      },
      { name, dir, nodeName },
    );
    id = fixture.terminal.id;
    csrf = fixture.csrf;
    expect(fixture.terminal.state).toBe("running");
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
    await page.getByRole("button", { name: "guide.md", exact: true }).click();
    await expect(page.locator(".monaco-editor")).toBeVisible();
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect(page.getByRole("heading", { name: "安全文档" })).toBeVisible();
    const image = page.getByRole("img", { name: "本地图" });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((e: HTMLImageElement) => e.naturalWidth))
      .toBe(1);
    await expect(page.getByText("图片地址已屏蔽")).toHaveCount(4);
    await expect(
      page.getByText("图片格式不支持或尺寸超出预览限制"),
    ).toBeVisible();
    await page.getByRole("button", { name: "并排", exact: true }).click();
    await page.locator(".monaco-editor textarea.inputarea").focus();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText("\n\n## 草稿即时预览\n");
    await expect(
      page.getByRole("heading", { name: "草稿即时预览" }),
    ).toBeVisible();
    expect(readFileSync(path.join(dir, "guide.md"), "utf8")).not.toContain(
      "草稿即时预览",
    );
    expect(
      await page.evaluate(() => Boolean((window as any).previewExecuted)),
    ).toBe(false);
    expect(
      await page.evaluate(() => Boolean((window as any).svgExecuted)),
    ).toBe(false);
    await page.getByRole("link", { name: "本地文件" }).click();
    await expect(page.locator(".monaco-editor")).toContainText(
      "relative link target",
    );
    await page
      .locator(".workbench-tabs .workbench-tab-select")
      .filter({ hasText: "guide.md" })
      .click();
    await page.getByRole("button", { name: "pixel.png", exact: true }).click();
    const standalone = page.getByRole("img", { name: "pixel.png" });
    await expect(standalone).toBeVisible();
    await page.getByRole("button", { name: "放大图片" }).click();
    await expect(page.getByText("125%", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "document.pdf", exact: true })
      .click();
    await expect(page.getByText("1 / 2", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.getByLabel("PDF 页面").evaluate((c: HTMLCanvasElement) => c.width),
      )
      .toBeGreaterThan(100);
    await page.getByRole("button", { name: "下一页" }).click();
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "放大 PDF" }).click();
    await page.getByRole("button", { name: "放大 PDF" }).click();
    await expect(page.getByText("156%", { exact: true })).toBeVisible();
    await page.screenshot({
      path: "../test-results/workspace-pdf-preview.png",
    });
    expect(fileBytes).toBeLessThan(fixturePDF().length / 2);
    const pdfViewport = page.locator(".pdf-viewport");
    await expect
      .poll(() =>
        pdfViewport.evaluate((el) => el.scrollHeight - el.clientHeight),
      )
      .toBeGreaterThan(50);
    await pdfViewport.evaluate((el) => {
      el.scrollTop = 50;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => pdfViewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await page
      .locator(".workbench-tabs .workbench-tab-select")
      .filter({ hasText: "guide.md" })
      .click();
    await page
      .locator(".workbench-tabs .workbench-tab-select")
      .filter({ hasText: "document.pdf" })
      .click();
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    await expect(page.getByText("156%", { exact: true })).toBeVisible();
    await expect
      .poll(() => pdfViewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => (window as any).previewRevokes))
      .toBeGreaterThan(0);
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "工作区模式" }).click();
    await page
      .getByRole("button", { name: "document.pdf", exact: true })
      .click();
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    await expect(page.getByText("156%", { exact: true })).toBeVisible();
    await expect
      .poll(() => pdfViewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    const resourceStatuses = await page.evaluate(async () =>
      Promise.all([
        fetch("/assets/pdfjs/standard_fonts/LiberationSans-Regular.ttf").then(
          (r) => r.status,
        ),
        fetch("/assets/pdfjs/cmaps/UniGB-UTF16-H.bcmap").then((r) => r.status),
      ]),
    );
    expect(resourceStatuses).toEqual([200, 200]);
    expect(external).toEqual([]);
    expect(directFiles).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(pane()).toBe(pid);
  } finally {
    if (id)
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
