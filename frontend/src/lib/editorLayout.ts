/**
 * Split editors: a chat's tabs in groups side by side or one above the other, as in VS Code (components/viewer/
 * EditorGrid.tsx; stores/workbenchStore.ts). A tree: a leaf is a group (its tabs, the one shown), a split holds two
 * nodes along a row (left | right) or a column (top / bottom) and where the line between them is (`ratio` of the
 * first). The chat is a tab too (`CHAT`): always open, in exactly one group — so the chat can be beside a file.
 *
 * Kept true by every change here (`normalize` mends a stored one): every open file is in exactly one group, the chat
 * in exactly one, no group is empty (an emptied one goes, its split with it), the focused group exists. Pure.
 */

export const CHAT = ":chat";

export type Side = "left" | "right" | "top" | "bottom";
export type Dir = "row" | "col";

export interface Group {
  kind: "group";
  id: string;
  tabs: string[]; // tab ids in the order shown (CHAT among them, or files' paths)
  active: string; // the one shown
}

export interface Split {
  kind: "split";
  id: string;
  dir: Dir; // row: a left | b right; col: a over b
  ratio: number; // the first one's share (0..1)
  a: Node;
  b: Node;
}

export type Node = Group | Split;

export interface Layout {
  root: Node;
  focus: string; // the group a new file opens in, whose shown tab the explorer follows
}

export const MIN_RATIO = 0.12;
export const MAX_RATIO = 1 - MIN_RATIO;

let n = 0;
export const newId = (p: "g" | "s") => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

export const single = (tabs: string[], active: string): Layout => {
  const id = "g0";
  return { root: { kind: "group", id, tabs: [CHAT, ...tabs.filter((t) => t !== CHAT)], active }, focus: id };
};

export function groups(node: Node): Group[] {
  return node.kind === "group" ? [node] : [...groups(node.a), ...groups(node.b)];
}

export const findGroup = (l: Layout, id: string) => groups(l.root).find((g) => g.id === id);
export const groupOf = (l: Layout, tab: string) => groups(l.root).find((g) => g.tabs.includes(tab));
export const focused = (l: Layout): Group => findGroup(l, l.focus) || groups(l.root)[0];
export const isSplit = (l: Layout) => l.root.kind === "split";

/** the node with every group / split passed through `fn` (immutable) */
function mapNode(node: Node, fn: (n: Node) => Node | null): Node | null {
  if (node.kind === "group") return fn(node);
  const a = mapNode(node.a, fn);
  const b = mapNode(node.b, fn);
  // (a side that went: the other takes the split's place)
  if (!a || !b) return a || b;
  return fn(a === node.a && b === node.b ? node : { ...node, a, b });
}

function withGroup(l: Layout, id: string, fn: (g: Group) => Group | null): Layout {
  const root = mapNode(l.root, (x) => (x.kind === "group" && x.id === id ? fn(x) : x));
  return fix({ ...l, root: root || single([], CHAT).root });
}

/** no empty group (its split collapses), the focus on a group that exists, each shown tab one of its own */
function fix(l: Layout): Layout {
  const root =
    mapNode(l.root, (x) => (x.kind === "group" && !x.tabs.length ? null : x.kind === "group" && !x.tabs.includes(x.active) ? { ...x, active: x.tabs[0] } : x)) ||
    single([], CHAT).root;
  const all = groups(root);
  return { root, focus: all.some((g) => g.id === l.focus) ? l.focus : all[0].id };
}

/** A stored layout made right for the open files (`files`): each in exactly one group, the chat in one, nothing
 * else — tabs the layout lost go to the focused group. Undefined (stored before splits): one group of them all. */
export function normalize(l: Layout | undefined, files: string[], active: string | null): Layout {
  if (!l || !l.root) return single(files, active ?? CHAT);
  const want = new Set([CHAT, ...files]);
  const seen = new Set<string>();
  const root = mapNode(l.root, (x) => {
    if (x.kind !== "group") return { ...x, ratio: clampRatio(x.ratio) };
    const tabs = x.tabs.filter((t) => want.has(t) && !seen.has(t));
    tabs.forEach((t) => seen.add(t));
    return { ...x, tabs };
  });
  let out = fix({ root: root || single([], CHAT).root, focus: l.focus });
  const lost = [...want].filter((t) => !seen.has(t));
  if (lost.length) {
    const g = lost.includes(CHAT) ? groups(out.root)[0] : focused(out);
    out = withGroup(out, g.id, (x) => ({ ...x, tabs: lost.includes(CHAT) ? [CHAT, ...x.tabs, ...lost.filter((t) => t !== CHAT)] : [...x.tabs, ...lost] }));
  }
  return out;
}

export const clampRatio = (r: number) => (Number.isFinite(r) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, r)) : 0.5);

/** show `tab` (in whichever group has it) and focus that group */
export function activate(l: Layout, tab: string): Layout {
  const g = groupOf(l, tab);
  if (!g) return l;
  return { ...withGroup(l, g.id, (x) => ({ ...x, active: tab })), focus: g.id };
}

export const focusGroup = (l: Layout, id: string): Layout => (findGroup(l, id) ? { ...l, focus: id } : l);

/** a new tab in the focused group, after its shown one (or in place of `replace`, its preview tab) */
export function addTab(l: Layout, tab: string, replace?: string): Layout {
  const g = focused(l);
  return {
    ...withGroup(l, g.id, (x) => {
      const tabs = [...x.tabs];
      const at = replace ? tabs.indexOf(replace) : -1;
      if (at >= 0) tabs[at] = tab;
      else tabs.splice(tabs.indexOf(x.active) + 1, 0, tab);
      return { ...x, tabs, active: tab };
    }),
    focus: g.id,
  };
}

/** a tab closed (the chat can't be): its group shows its neighbour; an emptied group goes */
export function removeTab(l: Layout, tab: string): Layout {
  if (tab === CHAT) return l;
  const g = groupOf(l, tab);
  if (!g) return l;
  return withGroup(l, g.id, (x) => {
    const i = x.tabs.indexOf(tab);
    const tabs = x.tabs.filter((t) => t !== tab);
    if (!tabs.length) return null;
    return { ...x, tabs, active: x.active === tab ? tabs[Math.min(i, tabs.length - 1)] : x.active };
  });
}

/** `tab` moved into group `to` (at `index`, else at the end), shown there and focused */
export function moveTab(l: Layout, tab: string, to: string, index?: number): Layout {
  const from = groupOf(l, tab);
  const target = findGroup(l, to);
  if (!from || !target) return l;
  if (from.id === to) {
    // (a reorder within the group)
    return withGroup(l, to, (x) => {
      const tabs = x.tabs.filter((t) => t !== tab);
      const at = index === undefined ? tabs.length : Math.max(0, Math.min(index > x.tabs.indexOf(tab) ? index - 1 : index, tabs.length));
      tabs.splice(at, 0, tab);
      return { ...x, tabs, active: tab };
    });
  }
  let out = withGroup(l, to, (x) => {
    const tabs = [...x.tabs];
    tabs.splice(index === undefined ? tabs.length : Math.max(0, Math.min(index, tabs.length)), 0, tab);
    return { ...x, tabs, active: tab };
  });
  out = withGroup(out, from.id, (x) => {
    const i = x.tabs.indexOf(tab);
    const tabs = x.tabs.filter((t) => t !== tab);
    return tabs.length ? { ...x, tabs, active: x.active === tab ? tabs[Math.min(i, tabs.length - 1)] : x.active } : null;
  });
  return { ...out, focus: findGroup(out, to) ? to : out.focus };
}

/**
 * `tab` taken out of its group into a new one beside group `target` (`side`): the split the user made by dropping a
 * tab on a group's edge. The new group is focused. Nothing happens when that would only put the tab back where it
 * was (the only tab of a group dropped on that group's own edge).
 */
export function splitWith(l: Layout, tab: string, target: string, side: Side, newGroupId = newId("g"), splitId = newId("s")): Layout {
  const from = groupOf(l, tab);
  const t = findGroup(l, target);
  if (!from || !t || (from.id === target && from.tabs.length === 1)) return l;
  // out of where it was (its group goes if that empties it — unless it is the target, which keeps its other tabs)
  let out = withGroup(l, from.id, (x) => {
    const i = x.tabs.indexOf(tab);
    const tabs = x.tabs.filter((y) => y !== tab);
    return tabs.length ? { ...x, tabs, active: x.active === tab ? tabs[Math.min(i, tabs.length - 1)] : x.active } : null;
  });
  const fresh: Group = { kind: "group", id: newGroupId, tabs: [tab], active: tab };
  const dir: Dir = side === "left" || side === "right" ? "row" : "col";
  const first = side === "left" || side === "top";
  const root = mapNode(out.root, (x) =>
    x.kind === "group" && x.id === target ? { kind: "split", id: splitId, dir, ratio: 0.5, a: first ? fresh : x, b: first ? x : fresh } : x,
  );
  out = fix({ root: root || out.root, focus: newGroupId });
  return out;
}

/** the line of split `id` moved: the first side's share */
export function resize(l: Layout, id: string, ratio: number): Layout {
  const root = mapNode(l.root, (x) => (x.kind === "split" && x.id === id ? { ...x, ratio: clampRatio(ratio) } : x));
  return root ? { ...l, root } : l;
}

/** one group again: every tab in the focused one's order first, then the others' */
export function unsplit(l: Layout): Layout {
  const all = groups(l.root);
  const f = focused(l);
  const tabs = [...f.tabs, ...all.filter((g) => g.id !== f.id).flatMap((g) => g.tabs)];
  return { root: { kind: "group", id: f.id, tabs, active: f.active }, focus: f.id };
}

/** which side of a group a point over it means (x, y: 0..1 across its width / height): its edges split it, the middle
 * moves the tab in. The edge bands take a third of each side, and a side band wins over a top / bottom one near a
 * corner — as in VS Code. */
export function dropZone(x: number, y: number, edge = 1 / 3): Side | "center" {
  const dx = Math.min(x, 1 - x);
  const dy = Math.min(y, 1 - y);
  if (dx >= edge && dy >= edge) return "center";
  if (dx <= dy) return x < 0.5 ? "left" : "right";
  return y < 0.5 ? "top" : "bottom";
}

/** a row split shown as a column where its sides would be narrower than `minPx` (a phone): what the grid lays out */
export const shownDir = (dir: Dir, widthPx: number, minPx: number): Dir => (dir === "row" && widthPx > 0 && widthPx < minPx * 2 ? "col" : dir);
