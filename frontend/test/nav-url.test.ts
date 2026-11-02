// Screens ↔ URLs (src/lib/navUrl.ts): Settings tabs are their own addresses, and the screens that became tabs
// (`/?view=usage`, `downloads`, … — bookmarks, notifications, the desktop app's menu, older apps) open their tab.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromSearch, settingsUrl, urlOf, SETTINGS_TABS } from "../src/lib/navUrl.ts";

test("every Settings tab round-trips through its URL", () => {
  for (const tab of SETTINGS_TABS) {
    const url = settingsUrl(tab);
    assert.equal(url, `/?view=settings&tab=${tab}`);
    assert.deepEqual(fromSearch(url.slice(1)), { view: "settings", session: null, tab });
  }
  assert.deepEqual(fromSearch("?view=settings"), { view: "settings", session: null, tab: null });
  assert.equal(settingsUrl(null), "/?view=settings");
});

test("the old screens open their Settings tab", () => {
  for (const v of ["providers", "connections", "usage", "admin"]) {
    const loc = fromSearch(`?view=${v}`);
    assert.deepEqual(loc, { view: "settings", session: null, tab: v });
    assert.equal(urlOf(loc!), `/?view=settings&tab=${v}`);
  }
  // Download: Updates & Download, scrolled to the downloads
  const dl = fromSearch("?view=downloads");
  assert.deepEqual(dl, { view: "settings", session: null, tab: "updates", anchor: "downloads" });
  assert.equal(urlOf(dl!), "/?view=settings&tab=updates");
  assert.deepEqual(fromSearch("?view=settings&tab=downloads"), { view: "settings", session: null, tab: "updates", anchor: "downloads" });
});

test("unknown tabs fall back to Settings itself; chats, the Mate and surfaces as before", () => {
  assert.deepEqual(fromSearch("?view=settings&tab=nope"), { view: "settings", session: null, tab: null });
  assert.deepEqual(fromSearch(""), { view: "chat", session: null, tab: null });
  assert.deepEqual(fromSearch("?view=chat&session=abc"), { view: "chat", session: "abc", tab: null });
  assert.deepEqual(fromSearch("?session=abc"), { view: "chat", session: "abc", tab: null });
  assert.deepEqual(fromSearch("?view=mate"), { view: "mate", session: null, tab: null });
  assert.equal(fromSearch("?surface=mate-overlay"), null);
  assert.equal(fromSearch("?view=bogus"), null);
  assert.equal(urlOf({ view: "chat", session: "a b", tab: null }), "/?view=chat&session=a%20b");
  assert.equal(urlOf({ view: "chat", session: null, tab: null }), "/");
  assert.equal(urlOf({ view: "mate", session: null, tab: null }), "/?view=mate");
});
