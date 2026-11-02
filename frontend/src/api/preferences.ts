import { apiFetch } from "./client";

/** The account's UI preferences, shared by every device (backend app/preferences.py). */
export interface Preferences {
  language: "en" | "ko" | null;
  /** light / dark (lib/theme.ts); null: never chosen (each device keeps its own). Older servers leave it out. */
  theme?: "system" | "light" | "dark" | null;
}

export const getPreferences = () => apiFetch<Preferences>("/api/preferences");
export const putPreferences = (p: Partial<Preferences>) =>
  apiFetch<Preferences>("/api/preferences", { method: "PUT", body: JSON.stringify(p) });
