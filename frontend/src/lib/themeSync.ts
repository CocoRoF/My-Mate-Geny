/**
 * The theme across devices (like the language, i18n/sync.ts): the account's choice lives on the server
 * (`/api/preferences` → `theme`), every device follows it — unless one keeps its own ("This device only", stored
 * here only). i18n/sync.ts pulls the preferences once for both and hands the theme to `applyAccountTheme`.
 */
import { putPreferences, type Preferences } from "../api/preferences";
import { useTheme, type ThemeMode } from "./theme";
import { accountMode } from "./themeCore";

/** the account's choice, unless this device keeps its own */
export function applyAccountTheme(p: Partial<Preferences> | null | undefined): void {
  const st = useTheme.getState();
  const next = accountMode(p?.theme, st.mode, st.deviceOnly);
  if (next) st.setMode(next);
}

/** where a choice went: every device ("saved"), only here as asked ("device"), or only here, the server unreachable */
export type ThemeSaved = "saved" | "device" | "local";

/** switch now (every window of this browser too), then save it for the account */
export async function chooseTheme(mode: ThemeMode): Promise<ThemeSaved> {
  useTheme.getState().setMode(mode);
  if (useTheme.getState().deviceOnly) return "device";
  try {
    await putPreferences({ theme: mode });
    return "saved";
  } catch {
    return "local";
  }
}

/** keep this device's own choice (on), or follow the account again — which then takes this device's choice */
export async function setThemeDeviceOnly(on: boolean): Promise<ThemeSaved> {
  useTheme.getState().setDeviceOnly(on);
  if (on) return "device";
  try {
    await putPreferences({ theme: useTheme.getState().mode });
    return "saved";
  } catch {
    return "local";
  }
}
