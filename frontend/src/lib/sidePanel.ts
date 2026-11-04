export type SidePanelKind = "session" | "explorer" | null;
export const DEFAULT_PANEL_WIDTH = 340;
export const panelWidth = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(640, Math.max(220, value))) : DEFAULT_PANEL_WIDTH;
export function sidePanelPreferences(saved: any, fallback: SidePanelKind) {
  const kind = saved?.sidePanel;
  const sidePanel: SidePanelKind = kind === "session" || kind === "explorer" || kind === null
    ? kind : saved?.explorerOpen === true ? "explorer" : fallback;
  return { sidePanel, explorerOpen: sidePanel === "explorer", panelWidth: panelWidth(saved?.panelWidth ?? saved?.explorerWidth) };
}
