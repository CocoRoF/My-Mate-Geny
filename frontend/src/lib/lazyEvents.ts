import { getEvents } from "../api/sessions";
import type { ProviderEvent } from "../types";

/**
 * The originals of events a lite history page sent as previews
 * (`event.lazy`; backend services/history_lite.py), fetched on demand —
 * when a tool row / diff / subagent opens — and kept for a while: a reload of
 * the page (reconnect) rebuilds the turns from previews again, and opening
 * the same row then costs nothing.
 */

const MAX = 400; // events kept (least recently used out first)
const cache = new Map<string, ProviderEvent>();
const inflight = new Map<string, Promise<void>>();

const keyOf = (sid: string, eid: number) => `${sid}:${eid}`;

function keep(k: string, ev: ProviderEvent) {
  cache.delete(k);
  cache.set(k, ev);
  while (cache.size > MAX) cache.delete(cache.keys().next().value as string);
}

/** The events `eids` of chat `sid` (those the server has), from the cache or one request. */
export async function fullEvents(sid: string, eids: number[]): Promise<Map<number, ProviderEvent>> {
  const want = [...new Set(eids)];
  const out = new Map<number, ProviderEvent>();
  const missing = want.filter((e) => !cache.has(keyOf(sid, e)) && !inflight.has(keyOf(sid, e)));
  for (let i = 0; i < missing.length; i += 500) {
    const chunk = missing.slice(i, i + 500);
    const req = getEvents(sid, chunk).then((r) => {
      for (const ev of r.events) {
        if (!ev.eid) continue;
        keep(keyOf(sid, ev.eid), ev);
        out.set(ev.eid, ev);
      }
    });
    const done = req.finally(() => chunk.forEach((e) => inflight.delete(keyOf(sid, e))));
    chunk.forEach((e) => inflight.set(keyOf(sid, e), done));
  }
  await Promise.all(want.map((e) => inflight.get(keyOf(sid, e))).filter(Boolean));
  for (const e of want) {
    const ev = out.get(e) || cache.get(keyOf(sid, e));
    if (ev) {
      keep(keyOf(sid, e), ev);
      out.set(e, ev);
    }
  }
  return out;
}

/** (tests) forget everything */
export function clearLazyEvents() {
  cache.clear();
  inflight.clear();
}
