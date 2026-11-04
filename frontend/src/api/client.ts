import { authenticationRequired } from "../lib/authNavigation";

const BASE = "";

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return (await apiResponse(path, init)).json() as Promise<T>;
}

/** Like {@link apiFetch} but hands back the Response (for its headers). */
export async function apiResponse(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (res.status === 401) {
    // Session expired / revoked: return to this client's authentication entry.
    toLogin();
    throw new Error("authentication required"); // i18n-ignore (the page goes to the login screen)
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const e = new Error(err.detail || res.statusText) as Error & { status?: number };
    e.status = res.status; // (callers that word errors themselves: 403 / 404 / 502…)
    throw e;
  }
  return res;
}

export function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

let redirecting = false;
let loginRedirect = true;
/** A transparent desktop surface (the Mate overlay) must never turn into the
 * login page: it just shows nothing until signed in again. */
export function disableLoginRedirect() {
  loginRedirect = false;
}
export function toLogin() {
  if (!loginRedirect) return;
  if (redirecting || window.location.pathname === "/login") return;
  redirecting = true;
  void authenticationRequired().catch(() => { redirecting = false; });
}
