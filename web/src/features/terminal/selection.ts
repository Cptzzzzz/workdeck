import type { Terminal } from "@xterm/xterm";

// Mouse-aware TUIs receive clicks and wheel events. Delay an ordinary primary
// press until we know whether it was a click or a text-selection drag.
export function installTerminalSelection(term: Terminal): () => void {
  const element = term.element;
  if (!element) return () => {};
  let replaying = false;
  let cancelPending: (() => void) | undefined;
  const onDown = (event: MouseEvent) => {
    if (
      replaying ||
      term.modes.mouseTrackingMode === "none" ||
      event.button !== 0 ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    let dragging = false;
    const send = (type: string, source: MouseEvent, forced: boolean) => {
      replaying = true;
      try {
        const mac = /Mac/.test(navigator.platform);
        target.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            detail: event.detail,
            screenX: source.screenX,
            screenY: source.screenY,
            clientX: source.clientX,
            clientY: source.clientY,
            button: source.button,
            buttons: type === "mouseup" ? 0 : 1,
            shiftKey: forced && !mac,
            altKey: forced && mac,
          }),
        );
      } finally {
        replaying = false;
      }
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      window.removeEventListener("blur", cleanup);
      cancelPending = undefined;
    };
    const move = (next: MouseEvent) => {
      if (
        !dragging &&
        Math.hypot(
          next.clientX - event.clientX,
          next.clientY - event.clientY,
        ) >= 4
      ) {
        dragging = true;
        send("mousedown", event, true);
      }
    };
    const up = (next: MouseEvent) => {
      if (next.button !== 0) return;
      cleanup();
      if (!dragging) {
        next.stopImmediatePropagation();
        next.preventDefault();
        send("mousedown", event, false);
        send("mouseup", next, false);
      }
    };
    cancelPending?.();
    cancelPending = cleanup;
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
    window.addEventListener("blur", cleanup);
  };
  element.addEventListener("mousedown", onDown, true);
  term.attachCustomKeyEventHandler((event) => {
    const mac = /Mac/.test(navigator.platform);
    const copyShortcut = mac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (
      event.type === "keydown" &&
      event.key.toLowerCase() === "c" &&
      copyShortcut &&
      !event.altKey &&
      term.hasSelection()
    )
      return false;
    return true;
  });
  return () => {
    cancelPending?.();
    element.removeEventListener("mousedown", onDown, true);
  };
}
