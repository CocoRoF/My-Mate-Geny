/**
 * Settings (the app's, docs/settings.md) at one of its tabs, from wherever this page is: in this window, or — a
 * desktop Mate window, another surface — in the console.
 */
import { currentSurface, desktopMate } from "../mate/desktop";
import { openSettings } from "../stores/uiStore";
import { settingsUrl, type SettingsTab } from "./navUrl";

export function openAppSettings(tab: SettingsTab | null = null): void {
  const url = settingsUrl(tab);
  if (currentSurface() === "console" || !desktopMate()) {
    if (new URLSearchParams(window.location.search).get("surface")) {
      window.open(url, "_blank");
      return;
    }
    openSettings(tab);
    return;
  }
  void desktopMate()!.openConsole(`${window.location.origin}${url}`);
}
