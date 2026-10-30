let csrf = "";
export function setCSRF(value: string) {
  csrf = value;
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch("/api" + path, {
    ...options,
    signal: options.signal || AbortSignal.timeout(20000),
    headers: {
      "Content-Type": "application/json",
      "X-Workdeck-CSRF": csrf,
      ...options.headers,
    },
    credentials: "same-origin",
  });
  const body = await res.json().catch(() => ({ error: "服务暂时不可用" }));
  if (!res.ok) {
    if (res.status === 401)
      window.dispatchEvent(new Event("workdeck:unauthorized"));
    throw new Error(body.error || "请求失败");
  }
  return body;
}
