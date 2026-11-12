// Device-owned settings and explicit persistent sharing intent; never image data.
"use strict";
const {isDeepStrictEqual} = require("node:util");
const LEGACY_EDGE = 1920; // (the picture size every mate had before it was this device's: not a choice of its own)
const DEFAULT_SCREEN = {
  source: null,
  source_invalid: false,
  all_screens: false, // every screen, each its own picture (capture.js); a chosen source ends it
  approval: "ask",
  max_edge: 0, // a new device sends the picture as it is; saved sizes stay
  hide_avatar: false,
  proactive_enabled: null,
  proactive_mate: "",
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
  if(typeof v.proactive_mate === "string") out.proactive_mate=v.proactive_mate.slice(0,100);
  if (typeof v.proactive_enabled === "boolean") out.proactive_enabled = v.proactive_enabled;
  if (Number.isFinite(v.proactive_interval)) out.proactive_interval = Math.max(60, Math.min(600, v.proactive_interval));
  if ("source" in v) {out.source = cleanSource(v.source);out.source_invalid=(v.source!=null&&!out.source)||(v.source==null&&v.source_invalid===true);out.all_screens=false;}
  else if(typeof v.source_invalid === "boolean") out.source_invalid=v.source_invalid;
  if (typeof v.all_screens === "boolean") out.all_screens = v.all_screens;
  if (out.all_screens) { out.source = null; out.source_invalid = false; }
  if (["ask", "allow"].includes(v.approval)) out.approval = v.approval;
  if ([0, 1280, 1920, 2560].includes(v.max_edge)) out.max_edge = v.max_edge;
  if (typeof v.hide_avatar === "boolean") out.hide_avatar = v.hide_avatar;
  return out;
}
// a mate's old screen settings for a device that takes them over: its size only when it was changed from the old default
function legacyScreen(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const { max_edge, ...rest } = raw;
  return max_edge === LEGACY_EDGE ? rest : raw;
}
const DEFAULT_SHARING = {enabled:false,origin:"",sid:"",name:"",mate_id:"",mode:"ask",interval:180};
function cleanSharing(raw) {
  const v = raw && typeof raw === "object" ? raw : {};
  const origin = typeof v.origin === "string" && /^https?:\/\//.test(v.origin) ? v.origin.slice(0,300) : "";
  const sid = typeof v.sid === "string" ? v.sid.slice(0,100) : "";
  return {enabled:v.enabled === true, origin, sid,
    mate_id:typeof v.mate_id === "string" ? v.mate_id.slice(0,100) : "",
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
      if (old.screen?.source != null && !cleanSource(old.screen.source)) value.screen.source_invalid = true;
      if (!isDeepStrictEqual(value,old)) writeSettings({devicePreferences:value});
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
      if (!migration.screenEdited) screen = cleanScreen(legacyScreen(chosen.screen), screen);
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
