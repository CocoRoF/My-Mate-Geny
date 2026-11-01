/**
 * Is a newer web console on the server than the one this page runs? The server's index.html names the build's
 * entry chunk (/assets/index-<hash>.js); a different name than ours means a deploy happened since this page loaded.
 */
export type ConsoleUpdate = "latest" | "available" | "unknown";

const ENTRY_RE = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]*\/assets\/[^"]+\.js)"/;

export function currentEntry(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  return el ? new URL(el.src, window.location.href).pathname : null;
}

export async function checkConsoleUpdate(): Promise<ConsoleUpdate> {
  const mine = currentEntry();
  if (!mine) return "unknown"; // the dev server: no built entry chunk
  const res = await fetch(`/?_=${Date.now()}`, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const m = (await res.text()).match(ENTRY_RE);
  if (!m) return "unknown";
  return new URL(m[1], window.location.href).pathname === mine ? "latest" : "available";
}
