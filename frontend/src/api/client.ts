const BASE = "";

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (res.status === 401) {
    // Session expired / revoked: back to the login page.
    toLogin();
    throw new Error("authentication required");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json() as Promise<T>;
}

export function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

let redirecting = false;
export function toLogin() {
  if (redirecting || window.location.pathname === "/login") return;
  redirecting = true;
  window.location.href = "/login";
}
