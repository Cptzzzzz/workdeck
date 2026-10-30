import { Page } from "@playwright/test";

export async function selectTestNode(page: Page) {
  const name = process.env.WORKDECK_TEST_NODE_NAME;
  if (!name) return;
  const state = await (await page.request.get("/api/state")).json();
  const node = state.nodes.find(
    (candidate: { name: string; online: boolean }) =>
      candidate.name === name && candidate.online,
  );
  if (!node) throw new Error("Configured test node is not online");
  await page
    .getByRole("combobox", { name: "计算节点", exact: true })
    .selectOption(node.id);
}
