// Split editors (src/lib/editorLayout.ts): a chat's tabs in groups side by side or one above the other — the chat a
// tab too, in exactly one group; every file in exactly one; no empty group; the line between two movable.
import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT, activate, addTab, dropZone, findGroup, focused, groupOf, groups, isSplit, moveTab, normalize, removeTab, resize,
  shownDir, single, splitWith, unsplit, type Layout, type Split,
} from "../src/lib/editorLayout.ts";

const tabsOf = (l: Layout) => groups(l.root).map((g) => g.tabs);
const sound = (l: Layout) => {
  const all = groups(l.root).flatMap((g) => g.tabs);
  assert.equal(new Set(all).size, all.length, "a tab in one group only");
  assert.equal(all.filter((t) => t === CHAT).length, 1, "the chat in exactly one group");
  for (const g of groups(l.root)) {
    assert.ok(g.tabs.length > 0, "no empty group");
    assert.ok(g.tabs.includes(g.active), "a group shows one of its own");
  }
  assert.ok(findGroup(l, l.focus), "the focus on a group that exists");
};

test("a file dropped on a group's right edge: the chat on the left, the file on the right", () => {
  let l = single(["/r/report.docx", "/r/a.md"], "/r/report.docx");
  l = splitWith(l, "/r/report.docx", "g0", "right", "g1", "s1");
  sound(l);
  assert.ok(isSplit(l));
  const root = l.root as Split;
  assert.equal(root.dir, "row");
  assert.equal(root.ratio, 0.5);
  assert.deepEqual(tabsOf(l), [[CHAT, "/r/a.md"], ["/r/report.docx"]]);
  assert.equal(l.focus, "g1", "the new group has the focus");
  // (the group it came from shows its neighbour)
  assert.equal(findGroup(l, "g0")!.active, "/r/a.md");
});

test("top and bottom, left: the new group goes on that side; groups nest", () => {
  let l = single(["/a", "/b", "/c"], CHAT);
  l = splitWith(l, "/a", "g0", "bottom", "g1", "s1");
  assert.equal((l.root as Split).dir, "col");
  assert.deepEqual(tabsOf(l), [[CHAT, "/b", "/c"], ["/a"]]);
  l = splitWith(l, "/b", "g1", "left", "g2", "s2");
  sound(l);
  assert.deepEqual(tabsOf(l), [[CHAT, "/c"], ["/b"], ["/a"]]);
  const lower = (l.root as Split).b as Split;
  assert.equal(lower.dir, "row");
  assert.deepEqual([(lower.a as any).id, (lower.b as any).id], ["g2", "g1"]);
});

test("moving the last tab out of a group closes the group and its split; the chat can move too", () => {
  let l = single(["/a"], CHAT);
  l = splitWith(l, "/a", "g0", "right", "g1", "s1");
  l = moveTab(l, "/a", "g0");
  sound(l);
  assert.ok(!isSplit(l), "back to one group");
  assert.deepEqual(tabsOf(l), [[CHAT, "/a"]]);
  // the chat to the right of a file
  l = splitWith(l, CHAT, "g0", "right", "g3", "s3");
  sound(l);
  assert.deepEqual(tabsOf(l), [["/a"], [CHAT]]);
  assert.equal(groupOf(l, CHAT)!.id, "g3");
});

test("dropping a group's only tab on its own edge changes nothing", () => {
  let l = single(["/a"], CHAT);
  l = splitWith(l, "/a", "g0", "right", "g1", "s1");
  const same = splitWith(l, "/a", "g1", "left", "g9", "s9");
  assert.equal(same, l);
});

test("closing: the neighbour shows; the chat can't be closed; an emptied group goes", () => {
  let l = single(["/a", "/b"], "/b");
  l = removeTab(l, "/b");
  assert.equal(focused(l).active, "/a");
  assert.equal(removeTab(l, CHAT), l);
  l = splitWith(single(["/a", "/b"], CHAT), "/b", "g0", "right", "g1", "s1");
  l = removeTab(l, "/b");
  sound(l);
  assert.ok(!isSplit(l));
});

test("opening a file goes to the focused group; showing a tab focuses its group", () => {
  let l = splitWith(single(["/a"], CHAT), "/a", "g0", "right", "g1", "s1");
  l = addTab(l, "/new");
  assert.deepEqual(findGroup(l, "g1")!.tabs, ["/a", "/new"]);
  l = activate(l, CHAT);
  assert.equal(l.focus, "g0");
  l = addTab(l, "/x");
  assert.deepEqual(findGroup(l, "g0")!.tabs, [CHAT, "/x"]);
  // (a preview tab is reused in place)
  l = addTab(l, "/y", "/x");
  assert.deepEqual(findGroup(l, "g0")!.tabs, [CHAT, "/y"]);
});

test("reordering within a group, and moving into another at a place", () => {
  let l = single(["/a", "/b", "/c"], CHAT);
  l = moveTab(l, "/c", "g0", 1);
  assert.deepEqual(tabsOf(l), [[CHAT, "/c", "/a", "/b"]]);
  l = moveTab(l, CHAT, "g0", 4);
  assert.deepEqual(tabsOf(l), [["/c", "/a", "/b", CHAT]]);
  l = splitWith(l, "/b", "g0", "right", "g1", "s1");
  l = moveTab(l, "/c", "g1", 0);
  assert.deepEqual(tabsOf(l), [["/a", CHAT], ["/c", "/b"]]);
});

test("the line between two moves within bounds; one group again keeps every tab", () => {
  let l = splitWith(single(["/a", "/b"], CHAT), "/a", "g0", "right", "g1", "s1");
  l = resize(l, "s1", 0.7);
  assert.equal((l.root as Split).ratio, 0.7);
  l = resize(l, "s1", 0.99);
  assert.ok((l.root as Split).ratio <= 0.88);
  l = resize(l, "s1", Number.NaN);
  assert.equal((l.root as Split).ratio, 0.5);
  const one = unsplit(l);
  sound(one);
  assert.ok(!isSplit(one));
  assert.deepEqual(new Set(tabsOf(one)[0]), new Set([CHAT, "/a", "/b"]));
});

test("a stored layout is mended for the files actually open (and one from before splits becomes one group)", () => {
  const before = normalize(undefined, ["/a", "/b"], "/b");
  assert.deepEqual(tabsOf(before), [[CHAT, "/a", "/b"]]);
  assert.equal(focused(before).active, "/b");
  const stored = splitWith(single(["/a", "/b"], CHAT), "/b", "g0", "right", "g1", "s1");
  // /b was closed elsewhere, /c opened, the chat lost from it: all mended
  const broken: Layout = { root: { ...(stored.root as Split), a: { kind: "group", id: "g0", tabs: ["/a", "/gone"], active: "/gone" } }, focus: "nope" };
  const l = normalize(broken, ["/a", "/c"], null);
  sound(l);
  assert.deepEqual(tabsOf(l), [[CHAT, "/a", "/c"]]);
});

test("where a dropped tab goes: the edges split, the middle moves it in", () => {
  assert.equal(dropZone(0.5, 0.5), "center");
  assert.equal(dropZone(0.05, 0.5), "left");
  assert.equal(dropZone(0.95, 0.5), "right");
  assert.equal(dropZone(0.5, 0.1), "top");
  assert.equal(dropZone(0.5, 0.92), "bottom");
  assert.equal(dropZone(0.05, 0.1), "left", "a side wins near a corner");
  // a phone: a left | right split is laid out top / bottom when its sides would be too narrow
  assert.equal(shownDir("row", 390, 260), "col");
  assert.equal(shownDir("row", 1200, 260), "row");
  assert.equal(shownDir("col", 390, 260), "col");
});
