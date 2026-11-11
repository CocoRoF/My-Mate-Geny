/** Settings' tabs: name, icon, group, hint, and where they are offered (light — the app shell's title bar uses it too). */
import type { MsgKey } from "../../i18n";
import type { SettingsTab } from "../../lib/navUrl";
import type { IconName } from "../ui/Icon";
import { isTouchFirst } from "../../lib/device";

export interface TabMeta {
  id: SettingsTab;
  label: MsgKey;
  icon: IconName;
  hint?: MsgKey;
  group: "general" | "mate" | "system";
  /** shown here? (Desktop app: only inside the desktop app) */
  when?: () => boolean;
  /** the content is wide (Admin's system charts) */
  wide?: boolean;
}

const platform = () => (typeof window !== "undefined" ? window.hrhNative?.platform ?? "" : "");
export const isDesktopApp = () => /^desktop-/.test(platform());
export const isAndroidApp = () => platform() === "android";
/** this device can share its screen (the desktop app, a desktop browser) — mate/screenCapture.ts canShareScreen, kept light */
const canCapture = () =>
  typeof window !== "undefined" &&
  (!!window.hrhNative?.capture || (!window.hrhNative && !isTouchFirst() && typeof navigator.mediaDevices?.getDisplayMedia === "function"));

export const TABS: readonly TabMeta[] = [
  // the app and you: set once (docs/settings.md)
  { id: "updates", label: "settings.tabUpdates", icon: "download", hint: "settings.updatesHint", group: "general" },
  { id: "account", label: "settings.secAccount", icon: "user", hint: "settings.accountHint", group: "general" },
  { id: "language", label: "settings.secLanguage", icon: "languages", hint: "settings.languageHint", group: "general" },
  { id: "appearance", label: "settings.secAppearance", icon: "appearance", hint: "settings.appearanceHint", group: "general" },
  { id: "notifications", label: "settings.secNotifications", icon: "bell", hint: "settings.notifHint", group: "general" },
  // what holds for every mate (her own settings are hers: Mate settings)
  { id: "mate", label: "settings.secMate", icon: "sparkles", hint: "settings.mateHint", group: "mate" },
  { id: "screen", label: "settings.secScreen", icon: "monitor", hint: "settings.screenHint", group: "mate", when: canCapture },
  { id: "desktop", label: "settings.secDesktop", icon: "laptop", hint: "settings.desktopHint", group: "mate", when: isDesktopApp },
  { id: "providers", label: "mcp.llmTitle", icon: "cpu", hint: "mcp.llmIntro", group: "system" },
  { id: "media", label: "mcp.mediaTitle", icon: "volume", hint: "mcp.mediaIntro", group: "system" },
  { id: "mcp", label: "mcp.title", icon: "plug", hint: "mcp.intro", group: "system" },
  { id: "connections", label: "nav.connections", icon: "server", hint: "connections.intro", group: "system" },
  { id: "usage", label: "nav.usage", icon: "cpu", hint: "settings.usageHint", group: "system" },
  { id: "admin", label: "nav.admin", icon: "shield", hint: "admin.intro", group: "system", wide: true },
];

export const GROUPS: readonly { id: TabMeta["group"]; label: MsgKey }[] = [
  { id: "general", label: "settings.groupGeneral" },
  { id: "mate", label: "settings.groupMate" },
  { id: "system", label: "settings.groupSystem" },
];

/** the tabs offered here, in order */
export const visibleTabs = (): TabMeta[] => TABS.filter((x) => !x.when || x.when());

export const tabMeta = (id: SettingsTab | null): TabMeta | undefined => (id ? TABS.find((x) => x.id === id) : undefined);
