import { Page } from "@playwright/test";

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
