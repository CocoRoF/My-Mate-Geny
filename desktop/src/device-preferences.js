// Device-owned settings and explicit persistent sharing intent; never image data.
"use strict";
const DEFAULT_SCREEN = {
  source: null,
  approval: "ask",
  max_edge: 1920,
  format: "png",
  quality: 85,
  hide_avatar: false,
  proactive_enabled: null,
  proactive_interval: 180,
};
function cleanSource(v) {
  return v && typeof v.id === "string" && !!v.id
    ? {
        id: v.id.slice(0, 200),
        name: String(v.name || "").slice(0, 200),
        kind: v.kind === "window" ? "window" : "screen",
        display_id: String(v.display_id || "").slice(0, 80),
      }
    : null;
}
function cleanScreen(raw, base = DEFAULT_SCREEN) {
  const v = raw && typeof raw === "object" ? raw : {},
    out = { ...base };
  if (typeof v.proactive_enabled === "boolean") out.proactive_enabled = v.proactive_enabled;
  if (Number.isFinite(v.proactive_interval)) out.proactive_interval = Math.max(60, Math.min(600, v.proactive_interval));
  if ("source" in v) out.source = cleanSource(v.source);
  if (["ask", "allow"].includes(v.approval)) out.approval = v.approval;
  if ([0, 1280, 1920, 2560].includes(v.max_edge)) out.max_edge = v.max_edge;
  if (["png", "jpeg"].includes(v.format)) out.format = v.format;
  if (Number.isFinite(v.quality))
    out.quality = Math.max(40, Math.min(100, Math.round(v.quality)));
  if (typeof v.hide_avatar === "boolean") out.hide_avatar = v.hide_avatar;
  return out;
}
const DEFAULT_SHARING = {enabled:false,origin:"",sid:"",name:"",mode:"ask",interval:180};
function cleanSharing(raw) {
  const v = raw && typeof raw === "object" ? raw : {};
  const origin = typeof v.origin === "string" && /^https?:\/\//.test(v.origin) ? v.origin.slice(0,300) : "";
  const sid = typeof v.sid === "string" ? v.sid.slice(0,100) : "";
  return {enabled:v.enabled === true && !!origin && !!sid, origin, sid,
    name:typeof v.name === "string" ? v.name.slice(0,100) : "",
    mode:["ask","on_turn","observe"].includes(v.mode) ? v.mode : "ask",
    interval:Number.isFinite(v.interval) ? Math.max(60,Math.min(600,v.interval)) : 180};
}
function createDevicePreferences({
  readSettings,
  writeSettings,
  changed = () => {},
}) {
  function get() {
    const s = readSettings();
    if (s.devicePreferences?.version === 1) {
      const old = s.devicePreferences;
      const value = { ...old, revision: Number.isSafeInteger(old.revision) ? old.revision : 0,
        screen: cleanScreen(old.screen), sharing: cleanSharing(old.sharing),
        volume: Number.isFinite(old.volume) ? Math.max(0, Math.min(3, old.volume)) : 1,
        migration: { mates: {}, imported: false, screenEdited: false, volumeEdited: false, ...(old.migration || {}) } };
      if (old.screen?.source != null && !cleanSource(old.screen.source)) value.sharing.enabled = false;
      if (JSON.stringify(value) !== JSON.stringify(old)) writeSettings({devicePreferences:value});
      return value;
    }
    const old = s.captureSources || {};
    const chosen =
      old[s.mateId] || Object.values(old).find((v) => v?.id) || null;
    const value = {
      version: 1,
      revision: 0,
      screen: cleanScreen({ source: chosen }),
      sharing: cleanSharing(),
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
    if (p.sharing && typeof p.sharing === "object") next.sharing = cleanSharing({...cur.sharing,...p.sharing});
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
        proactive: m.proactive,
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
    if (screen.proactive_enabled === null && chosen?.proactive) screen = cleanScreen({proactive_enabled:!!chosen.proactive.enabled,proactive_interval:chosen.proactive.interval}, screen);
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
  cleanSharing, DEFAULT_SHARING,
};
