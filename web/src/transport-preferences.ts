import type { RoutePreference } from "./transport-policy";

export const ROUTE_PREFERENCE_KEY = "workdeck.transport.preference.v1";
const eventName = "workdeck:transport-preference";
let fallback: RoutePreference | undefined;

export function parseRoutePreference(value: string | null): RoutePreference {
  return value === "balanced" ? "balanced" : "prefer-direct";
}

export function readRoutePreference(): RoutePreference {
  if (fallback) return fallback;
  try {
    return parseRoutePreference(localStorage.getItem(ROUTE_PREFERENCE_KEY));
  } catch {
    return "prefer-direct";
  }
}

export function saveRoutePreference(value: RoutePreference): void {
  try {
    localStorage.setItem(ROUTE_PREFERENCE_KEY, value);
    fallback = undefined;
  } catch {
    fallback = value;
  }
  window.dispatchEvent(new Event(eventName));
}

export function subscribeRoutePreference(update: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === ROUTE_PREFERENCE_KEY || event.key === null) {
      fallback = undefined;
      update();
    }
  };
  window.addEventListener(eventName, update);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(eventName, update);
    window.removeEventListener("storage", storage);
  };
}
