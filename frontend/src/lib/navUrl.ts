/**
 * Screens ↔ URLs (pure; lib/nav.ts wires them to history). The sidebar has two screens — Mate and Chat — and
 * Settings, whose tabs are their own entries:
 *   /                                   a new chat
 *   /?view=chat&session=<id>            a chat
 *   /?view=mate                         the Mate
 *   /?view=settings[&tab=<tab>]         Settings (no tab: the list on a phone, the first tab on a wide screen)
 * Screens that used to be their own (`/?view=usage`, `providers`, `connections`, `admin`, `downloads`) — still in
 * bookmarks, notifications, the desktop app's menu, older apps — open their Settings tab.
 */

export type View = "mate" | "chat" | "settings";

export type SettingsTab =
  | "updates"
  | "account"
  | "language"
  | "appearance"
  | "notifications"
  | "mate"
  | "desktop"
  | "providers"
  | "connections"
  | "usage"
  | "admin";

export const SETTINGS_TABS: readonly SettingsTab[] = [
  "updates",
  "account",
  "language",
  "appearance",
  "notifications",
  "mate",
  "desktop",
  "providers",
  "connections",
  "usage",
  "admin",
];

/** a part of a tab to scroll to once it is shown (`/?view=downloads` → Updates & Download, at Download) */
export type SettingsAnchor = "downloads";

export interface Loc {
  view: View;
  session: string | null;
  tab: SettingsTab | null;
  anchor?: SettingsAnchor;
}

/** the screens that became Settings tabs: old view name → its tab */
const LEGACY: Record<string, { tab: SettingsTab; anchor?: SettingsAnchor }> = {
  providers: { tab: "providers" },
  connections: { tab: "connections" },
  usage: { tab: "usage" },
  admin: { tab: "admin" },
  downloads: { tab: "updates", anchor: "downloads" },
};

/** tab names that aren't the tab's id */
const TAB_ALIAS: Record<string, { tab: SettingsTab; anchor?: SettingsAnchor }> = {
  downloads: { tab: "updates", anchor: "downloads" },
  download: { tab: "updates", anchor: "downloads" },
};

const isTab = (v: string | null): v is SettingsTab => !!v && (SETTINGS_TABS as readonly string[]).includes(v);

function settingsTab(raw: string | null): { tab: SettingsTab | null; anchor?: SettingsAnchor } {
  if (isTab(raw)) return { tab: raw };
  if (raw && TAB_ALIAS[raw]) return TAB_ALIAS[raw];
  return { tab: null };
}

/** the screen a URL's query names; null: not a screen of the console (e.g. a Mate surface) */
export function fromSearch(search: string): Loc | null {
  const q = new URLSearchParams(search);
  const v = q.get("view");
  const session = q.get("session");
  if (v === "chat") return { view: "chat", session, tab: null };
  if (v === "mate") return { view: "mate", session: null, tab: null };
  if (v === "settings") return { view: "settings", session: null, ...settingsTab(q.get("tab")) };
  if (v && LEGACY[v]) return { view: "settings", session: null, ...LEGACY[v] };
  if (session) return { view: "chat", session, tab: null };
  if (!v && !q.get("surface")) return { view: "chat", session: null, tab: null };
  return null;
}

export function urlOf(loc: Loc): string {
  if (loc.view === "chat") return loc.session ? `/?view=chat&session=${encodeURIComponent(loc.session)}` : "/";
  if (loc.view === "settings") return loc.tab ? `/?view=settings&tab=${loc.tab}` : "/?view=settings";
  return `/?view=${loc.view}`;
}

/** the URL of a Settings tab (links that open another window: the desktop Mate's "Open Providers") */
export const settingsUrl = (tab: SettingsTab | null): string => urlOf({ view: "settings", session: null, tab });

/** a panel of the Mate view to open on arrival (the desktop Mate chat window's "Adjust in settings"):
 *  `relation` (the Relationship panel) or a Mate settings tab */
export type MatePanel = "relation" | "settings-relation" | "settings-memory";
const MATE_PANELS: readonly string[] = ["relation", "settings-relation", "settings-memory"];

/** `/?view=mate&mate=<id>&panel=<panel>` — the console's URL becomes `/?view=mate` once it is read */
export const matePanelUrl = (mateId: string, panel: MatePanel): string =>
  `/?view=mate&mate=${encodeURIComponent(mateId)}&panel=${panel}`;

export function matePanelOf(search: string): { mate: string | null; panel: MatePanel } | null {
  const q = new URLSearchParams(search);
  const panel = q.get("panel");
  if (q.get("view") !== "mate" || !panel || !MATE_PANELS.includes(panel)) return null;
  return { mate: q.get("mate"), panel: panel as MatePanel };
}
