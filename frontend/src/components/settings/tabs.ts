/** Settings' tabs: name, icon, group, hint, and where they are offered (light — the app shell's title bar uses it too). */
import type { MsgKey } from "../../i18n";
import type { SettingsTab } from "../../lib/navUrl";
import type { IconName } from "../ui/Icon";

export interface TabMeta {
  id: SettingsTab;
  label: MsgKey;
  icon: IconName;
  hint?: MsgKey;
  group: "general" | "system";
  /** shown here? (Desktop app: only inside the desktop app) */
  when?: () => boolean;
  /** the content is wide (Admin's system charts) */
  wide?: boolean;
}

const platform = () => (typeof window !== "undefined" ? window.hrhNative?.platform ?? "" : "");
export const isDesktopApp = () => /^desktop-/.test(platform());
export const isAndroidApp = () => platform() === "android";

export const TABS: readonly TabMeta[] = [
  { id: "updates", label: "settings.tabUpdates", icon: "download", hint: "settings.updatesHint", group: "general" },
  { id: "account", label: "settings.secAccount", icon: "user", hint: "settings.accountHint", group: "general" },
  { id: "language", label: "settings.secLanguage", icon: "languages", hint: "settings.languageHint", group: "general" },
  { id: "notifications", label: "settings.secNotifications", icon: "bell", hint: "settings.notifHint", group: "general" },
  { id: "mate", label: "settings.secMate", icon: "volume", hint: "settings.mateHint", group: "general" },
  { id: "desktop", label: "settings.secDesktop", icon: "monitor", hint: "settings.desktopHint", group: "general", when: isDesktopApp },
  { id: "providers", label: "nav.providers", icon: "plug", hint: "providers.intro", group: "system" },
  { id: "connections", label: "nav.connections", icon: "server", hint: "connections.intro", group: "system" },
  { id: "usage", label: "nav.usage", icon: "cpu", hint: "settings.usageHint", group: "system" },
  { id: "admin", label: "nav.admin", icon: "shield", hint: "admin.intro", group: "system", wide: true },
];

export const GROUPS: readonly { id: TabMeta["group"]; label: MsgKey }[] = [
  { id: "general", label: "settings.groupGeneral" },
  { id: "system", label: "settings.groupSystem" },
];

/** the tabs offered here, in order */
export const visibleTabs = (): TabMeta[] => TABS.filter((x) => !x.when || x.when());

export const tabMeta = (id: SettingsTab | null): TabMeta | undefined => (id ? TABS.find((x) => x.id === id) : undefined);
