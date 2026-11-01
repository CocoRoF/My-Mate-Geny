/** Deep link into a Settings section from elsewhere (the default-password banner → Account) without pulling the
 * lazy Settings chunk into the main bundle. */
export type SettingsSection = "updates" | "account" | "language" | "notifications" | "mate" | "desktop";

const EVENT = "hrh-settings-section";
let pending: SettingsSection | null = null;

export function requestSettingsSection(section: SettingsSection) {
  pending = section;
  window.dispatchEvent(new CustomEvent<SettingsSection>(EVENT, { detail: section }));
}

/** The section asked for before Settings mounted (consumed once). */
export function takeSettingsSection(): SettingsSection | null {
  const s = pending;
  pending = null;
  return s;
}

export function onSettingsSection(cb: (section: SettingsSection) => void): () => void {
  const h = (e: Event) => {
    pending = null;
    cb((e as CustomEvent<SettingsSection>).detail);
  };
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
