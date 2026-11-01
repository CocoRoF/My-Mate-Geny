import { apiFetch } from "./client";

/** The account's UI preferences, shared by every device (backend app/preferences.py). */
export interface Preferences {
  language: "en" | "ko" | null;
}

export const getPreferences = () => apiFetch<Preferences>("/api/preferences");
export const putPreferences = (p: Partial<Preferences>) =>
  apiFetch<Preferences>("/api/preferences", { method: "PUT", body: JSON.stringify(p) });
