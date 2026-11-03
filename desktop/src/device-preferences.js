// Device-owned preferences. No server writes, no sharing consent persisted.
"use strict";
const DEFAULT_SCREEN = {
  source: null,
  approval: "ask",
  max_edge: 1920,
  format: "png",
  quality: 85,
  hide_avatar: true,
};
function cleanSource(v) {
  return v && typeof v.id === "string"
    ? {
        id: v.id.slice(0, 200),
        name: String(v.name || "").slice(0, 200),
        kind: v.kind === "window" ? "window" : "screen",
        display_id: String(v.display_id || "").slice(0, 80),
      }
    : null;
}
function cleanScreen(raw, base = DEFAULT_SCREEN) {
  const v = raw || {},
    out = { ...base };
  if ("source" in v) out.source = cleanSource(v.source);
  if (["ask", "allow"].includes(v.approval)) out.approval = v.approval;
  if ([0, 1280, 1920, 2560].includes(v.max_edge)) out.max_edge = v.max_edge;
  if (["png", "jpeg"].includes(v.format)) out.format = v.format;
  if (Number.isFinite(v.quality))
    out.quality = Math.max(40, Math.min(100, Math.round(v.quality)));
  if (typeof v.hide_avatar === "boolean") out.hide_avatar = v.hide_avatar;
  return out;
}
function createDevicePreferences({
  readSettings,
  writeSettings,
  changed = () => {},
}) {
  function get() {
    const s = readSettings();
    if (s.devicePreferences?.version === 1) return s.devicePreferences;
    const old = s.captureSources || {};
    const chosen =
      old[s.mateId] || Object.values(old).find((v) => v?.id) || null;
    const value = {
      version: 1,
      revision: 0,
      screen: cleanScreen({ source: chosen }),
      volume: 1,
      migration: {
        sources: { ...old },
        mates: {},
        imported: false,
        screenEdited: false,
        volumeEdited: false,
      },
    };
    writeSettings({ devicePreferences: value });
    return value;
  }
  function patch(p) {
    const cur = get();
    const next = {
      ...cur,
      revision: cur.revision + 1,
      migration: { ...cur.migration },
    };
    if (p.screen && typeof p.screen === "object") {
      next.screen = cleanScreen(p.screen, cur.screen);
      next.migration.screenEdited = true;
    }
    if (typeof p.volume === "number" && Number.isFinite(p.volume)) {
      next.volume = Math.max(0, Math.min(3, p.volume));
      next.migration.volumeEdited = true;
    }
    writeSettings({ devicePreferences: next });
    changed(next, cur);
    return next;
  }
  function migrate({ origin, activeId, mates }) {
    const cur = get(),
      migration = { ...cur.migration, mates: { ...cur.migration.mates } };
    const rows = Array.isArray(mates)
      ? mates.filter((m) => m && typeof m.id === "string").slice(0, 500)
      : [];
    for (const m of rows)
      migration.mates[`${String(origin || "").slice(0, 200)}:${m.id}`] = {
        screen: m.screen || null,
        volume: m.volume,
        updated_at: m.updated_at || null,
      };
    const chosen =
      rows.find((m) => m.id === (readSettings().mateId || activeId)) ||
      rows.find((m) => m.id === activeId) ||
      rows[0];
    let screen = cur.screen,
      volume = cur.volume;
    if (!migration.imported && chosen) {
      if (!migration.screenEdited) screen = cleanScreen(chosen.screen, screen);
      if (!migration.volumeEdited && Number.isFinite(chosen.volume))
        volume = Math.max(0, Math.min(3, chosen.volume));
      migration.imported = true;
      migration.chosenMate = chosen.id;
      migration.rule = "active-mate-first";
    }
    const next = {
      ...cur,
      screen,
      volume,
      migration,
      revision: cur.revision + 1,
    };
    writeSettings({ devicePreferences: next });
    changed(next, cur);
    return next;
  }
  return { get, patch, migrate };
}
module.exports = {
  createDevicePreferences,
  DEFAULT_SCREEN,
  cleanScreen,
  cleanSource,
};
