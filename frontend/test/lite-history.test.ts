// Lite history pages (backend services/history_lite.py) through the chat store (src/stores/chatStore.ts): a store fed
// the lite pages, with every previewed tool fetched (hydrate), ends in the SAME state as a store fed the full pages —
// turns, tools, subagents, todos, costs, changed files, context, pinned background work — after the newest page and
// after every older page. Before the fetch only the fields marked lazy differ. A lite store talking to a backend that
// doesn't know `lite` (full pages) is the full store.
// Fixture: test/fixtures/lite-history.json (backend tests/test_history_lite.py writes it). HRH_LITE_FIXTURES=<dir>
// adds every *.json there (same shape; e.g. pages of a copy of a real database).
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createChatStore, type ChatState, type ToolActivity, type Turn } from "../src/stores/chatStore.ts";
import { clearLazyEvents } from "../src/lib/lazyEvents.ts";

type Page = Record<string, any> & { page: { cursor: string | null; until: string | null; has_more: boolean } };
interface Fixture {
  sid: string;
  full: Page[];
  lite: Page[];
  events: Record<string, any>;
}

const NOW = 1_800_000_000_000;
Date.now = () => NOW; // (a turn closed without an end time takes "now")

let posts = 0;
let lastFixture: Fixture | null = null;
let liteServer = true; // false: a backend without `lite` (it sends full pages for lite=1 too)

globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const fx = lastFixture!;
  const u = new URL(String(url), "http://test");
  const body = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
  if (u.pathname === `/api/history/${fx.sid}/events` && init?.method === "POST") {
    posts++;
    const { eids } = JSON.parse(String(init.body));
    return body({ events: eids.map((e: number) => fx.events[String(e)]).filter(Boolean) });
  }
  const pages = u.searchParams.get("lite") === "1" && liteServer ? fx.lite : fx.full;
  const before = u.searchParams.get("before");
  const p = pages.find((x, i) => i > 0 && x.page.until === before);
  if (!p) return new Response(JSON.stringify({ detail: "no such page" }), { status: 404 });
  return body(p);
}) as typeof fetch;

type Store = ReturnType<typeof createChatStore>;

const allTools = (s: ChatState) => [...s.turns, ...(s.detached ? [s.detached] : [])].flatMap((t) => t.tools);

async function hydrateAll(store: Store) {
  const ids = allTools(store.getState()).filter((t) => t.lazy).map((t) => t.id);
  for (let i = 0; i < ids.length; i += 300) await store.getState().hydrate(ids.slice(i, i + 300));
  assert.equal(allTools(store.getState()).filter((t) => t.lazy).length, 0, "every preview has its original");
}

/** What the UI reads, keys made comparable (turn keys are a running counter). */
function view(s: ChatState, strip?: (t: ToolActivity, path: string) => ToolActivity) {
  const turn = (t: Turn, i: number | string) => ({
    ...t,
    key: t.key === "detached" ? "detached" : `k${i}`,
    tools: t.tools.map((x, j) => (strip ? strip(x, `${i}/${j}`) : x)),
  });
  return {
    turns: s.turns.map(turn),
    detached: s.detached ? turn(s.detached, "d") : null,
    context: s.context,
    lastCompaction: s.lastCompaction,
    older: s.older,
    runningCostUsd: s.runningCostUsd,
    lastEid: s.lastEid,
    isStreaming: s.isStreaming,
    paging: { cursor: s.paging.cursor, hasMore: s.paging.hasMore, paged: s.paging.paged, baseEid: s.paging.baseEid },
    pinnedTools: [...s.pinnedTools].sort(),
    info: s.info,
  };
}

/** Both views without the fields the lite store marks lazy (and the marks). */
function withoutLazy(full: ChatState, lite: ChatState) {
  const marks = new Map<string, ToolActivity["lazy"]>();
  const vl = view(lite, (t, path) => {
    if (!t.lazy) return t;
    marks.set(path, t.lazy);
    const { lazy, ...rest } = t;
    if (lazy?.use) delete rest.input;
    if (lazy?.result) delete rest.output;
    return rest;
  });
  const vf = view(full, (t, path) => {
    const m = marks.get(path);
    if (!m) return t;
    const rest = { ...t };
    if (m.use) delete rest.input;
    if (m.result) delete rest.output;
    return rest;
  });
  return { vf, vl, marked: marks.size };
}

async function walk(fx: Fixture) {
  lastFixture = fx;
  clearLazyEvents();
  const full = createChatStore();
  const lite = createChatStore({ lite: true });
  for (const s of [full, lite]) s.getState().reset(fx.sid);
  full.getState().loadHistory(fx.full[0] as any);
  lite.getState().loadHistory(fx.lite[0] as any);
  let step = 0;
  let marked = 0;
  for (;;) {
    const before = withoutLazy(full.getState(), lite.getState());
    assert.deepStrictEqual(before.vl, before.vf, `page ${step}: only the lazy fields differ`);
    marked += before.marked;
    await hydrateAll(lite);
    assert.deepStrictEqual(view(lite.getState()), view(full.getState()), `page ${step}: the same state once fetched`);
    assert.equal(full.getState().paging.hasMore, lite.getState().paging.hasMore);
    if (!full.getState().paging.hasMore) break;
    await full.getState().loadOlder();
    await lite.getState().loadOlder();
    step++;
  }
  assert.deepStrictEqual(lite.getState().orphans, []);
  assert.deepStrictEqual(full.getState().orphans, []);
  return { pages: step + 1, marked };
}

function fixtures(): Array<[string, () => Fixture]> {
  const out: Array<[string, () => Fixture]> = [
    ["synthetic", () => JSON.parse(readFileSync(new URL("./fixtures/lite-history.json", import.meta.url), "utf8"))],
  ];
  const dir = process.env.HRH_LITE_FIXTURES;
  if (dir && existsSync(dir))
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort())
      out.push([f, () => JSON.parse(readFileSync(join(dir, f), "utf8"))]);
  return out;
}

for (const [name, load] of fixtures()) {
  test(`lite pages + fetched originals = full pages: ${name}`, async () => {
    const fx = load();
    posts = 0;
    liteServer = true;
    const r = await walk(fx);
    assert.equal(r.pages, fx.full.length);
    if (name === "synthetic") {
      assert.ok(r.marked > 20 && posts > 0, `previews were used (${r.marked})`);
      // the lite pages really are smaller, with fewer events
      const size = (ps: Page[]) => ps.reduce((n, p) => n + JSON.stringify(p).length, 0);
      assert.ok(size(fx.lite) < size(fx.full));
      assert.ok(fx.lite.flatMap((p) => p.events).length < fx.full.flatMap((p) => p.events).length);
    }
    console.log(`# ${name}: ${r.pages} pages, ${r.marked} lazy-marked tools before fetch, ${posts} fetches`);
  });
}

test("a lite store with a backend without `lite`: the full store, nothing fetched", async () => {
  const fx = fixtures()[0][1]();
  posts = 0;
  liteServer = false;
  lastFixture = { ...fx, lite: fx.full };
  const r = await walk(lastFixture);
  assert.equal(r.marked, 0);
  assert.equal(posts, 0);
  liteServer = true;
});

test("hydrate: a server without the original leaves the preview (and says so by keeping `lazy`)", async () => {
  const fx = fixtures()[0][1]();
  lastFixture = { ...fx, events: {} };
  clearLazyEvents();
  const s = createChatStore({ lite: true });
  s.getState().reset(fx.sid);
  s.getState().loadHistory(fx.lite[0] as any);
  const lazy = allTools(s.getState()).filter((t) => t.lazy);
  assert.ok(lazy.length);
  await s.getState().hydrate(lazy.map((t) => t.id));
  assert.equal(allTools(s.getState()).filter((t) => t.lazy).length, lazy.length);
});
