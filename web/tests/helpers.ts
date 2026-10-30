import { Page } from "@playwright/test";

export async function readState(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(async () => {
        const response = await fetch("/api/state", {
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("Unable to read workspace state");
        return response.json();
      });
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

export async function selectTestNode(page: Page) {
  const name = process.env.WORKDECK_TEST_NODE_NAME;
  if (!name) return;
  const state = await readState(page);
  const node = state.nodes.find(
    (candidate: { name: string; online: boolean }) =>
      candidate.name === name && candidate.online,
  );
  if (!node) throw new Error("Configured test node is not online");
  await page
    .getByRole("combobox", { name: "计算节点", exact: true })
    .selectOption(node.id);
}

export async function terminateCurrentTerminal(page: Page) {
  await page.getByRole("button", { name: "终止终端", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "终止终端", exact: true });
  await dialog.getByRole("button", { name: "终止终端", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}
