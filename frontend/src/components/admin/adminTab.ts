/** Deep link into an Admin tab from elsewhere (e.g. the default-password
 * banner) without pulling the lazy Admin chunk into the main bundle. */
export type AdminTab = "logs" | "system" | "security";

const EVENT = "hrh-admin-tab";
let pending: AdminTab | null = null;

export function requestAdminTab(tab: AdminTab) {
  pending = tab;
  window.dispatchEvent(new CustomEvent<AdminTab>(EVENT, { detail: tab }));
}

/** The tab asked for before Admin mounted (consumed once). */
export function takeAdminTab(): AdminTab | null {
  const t = pending;
  pending = null;
  return t;
}

export function onAdminTab(cb: (tab: AdminTab) => void): () => void {
  const h = (e: Event) => {
    pending = null;
    cb((e as CustomEvent<AdminTab>).detail);
  };
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
