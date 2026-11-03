import { Page, Locator } from "@playwright/test";

// Keep positive direct-path acceptance deterministic even when localhost
// scheduling noise makes the two real transports otherwise indistinguishable.
// Only application probe replies are delayed; terminal data is untouched.
export function delayRelayProbesForDirectTest() {
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      Object.defineProperty(this, "onmessage", {
        set: (handler: (event: MessageEvent) => void) => {
          this.addEventListener("message", (event) => {
            let probe = false;
            if (typeof event.data === "string") {
              try {
                probe = JSON.parse(event.data).type === "probe-reply";
              } catch {}
            }
            if (probe) setTimeout(() => handler(event), 30);
            else handler(event);
          });
        },
      });
    }
  };
}

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
  await selectThemedOption(
    page.getByRole("combobox", { name: "计算节点", exact: true }),
    node.id,
  );
}

export async function terminateCurrentTerminal(page: Page) {
  await page.getByRole("button", { name: "终止终端", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "终止终端", exact: true });
  await dialog.getByRole("button", { name: "终止终端", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

// Exercise the same themed listbox interaction as the browser user.
export async function selectThemedOption(
  control: Locator,
  value: string | { label: string },
) {
  await control.click();
  const id = await control.getAttribute("aria-controls");
  if (!id) throw new Error("Select popup did not open");
  const list = control.page().locator(`[id=${JSON.stringify(id)}]`);
  if (typeof value !== "string")
    await list.getByRole("option", { name: value.label, exact: true }).click();
  else {
    const index = await list
      .getByRole("option")
      .evaluateAll(
        (items, value) =>
          items.findIndex((item) => item.getAttribute("data-value") === value),
        value,
      );
    if (index < 0) throw new Error("Select option not found");
    await list.getByRole("option").nth(index).click();
  }
}

export async function themedOptions(control: Locator) {
  await control.click();
  const id = await control.getAttribute("aria-controls");
  const values = await control
    .page()
    .locator(`[id=${JSON.stringify(id)}]`)
    .getByRole("option")
    .evaluateAll((items) =>
      items
        .map((item) => item.getAttribute("data-value") || "")
        .filter(Boolean),
    );
  await control.press("Escape");
  return values;
}
