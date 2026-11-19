/**
 * The studio canvas's state, pure (frontend/test/studio-graph.test.ts): what each node and tile of the making shows,
 * from the project the server sends (docs/avatar-create.md §11 "The canvas"). Columns, left to right:
 *
 *   입력 (who she is) → 외형·견적 (what will be made, for how much) → 시안 → 기준 그림 → 세트 규칙 → 동시 생성 → 검사 → 완성
 *
 * A tile is one picture or clip of a set; a set is a row (표정, 쉬는 상태, 대화, 반응, 자리 비움). Nothing here makes up
 * progress: a state is what the server's items say, a time only what really passed.
 */
import type { AvatarProject, ClipCheck } from "../../../../api/avatar";

export type SlotState = "empty" | "queued" | "running" | "processing" | "done" | "failed";
export type SetKey = "faces" | "idle" | "talk" | "react" | "away";
export type InputKey = "concept" | "profile" | "style" | "temperament" | "refs" | "voice" | "model";
export type NodeKey = InputKey | "brief" | "estimate" | "candidates" | "home" | `set:${SetKey}` | "check" | "mate" | "import" | "motions";

export const SETS: SetKey[] = ["faces", "idle", "talk", "react", "away"];
/** clip kinds of each set (the faces are stills) */
export const SET_KINDS: Record<SetKey, string[]> = { faces: [], idle: ["idle"], talk: ["talk", "listen", "think"], react: ["react"], away: ["away"] };
/** the stills that are mechanics (the photo body blinks and talks with them), not feelings */
export const MECHANICS = new Set(["blink", "mouth_half", "mouth_open", "mouth_o"]);

export interface Tile {
  /** `still:<name>` | `clip:<id>` — the server's item key, also the redo target */
  key: string;
  id: string;
  set: SetKey;
  kind: "still" | "clip";
  /** a clip's kind (idle, talk, listen, think, react, away) or a still's role (face, mechanic) */
  sub: string;
  emotion: string | null;
  state: SlotState;
  /** a picture for the tile: the still, or for a clip the face it pairs with, else the base picture */
  src: string | null;
  /** a clip's video (hover plays it) */
  video: string | null;
  check: ClipCheck | null;
  error: string | null;
}

export interface Row {
  key: SetKey;
  tiles: Tile[];
}

const itemState = (status: string | undefined | null, gpuQueued = false): SlotState =>
  status === "done" ? "done" : status === "running" ? (gpuQueued ? "queued" : "running") : status === "failed" ? "failed" : status === "pending" ? "queued" : "empty";

/** the project's run has started (a Confirm was given): pending items are queued, before it they are only planned */
const started = (p: AvatarProject) => !!p.confirmation;

/** every set's tiles, from the brief (what is planned) and what the server has made */
export function rowsOf(p: AvatarProject): Row[] {
  const run = started(p);
  const stillUrl = new Map(p.files.stills.map((s) => [s.name, s]));
  const faces: Tile[] = p.brief.stills.map((s) => {
    const f = stillUrl.get(s.name);
    const it = p.items[`still:${s.name}`];
    const st = itemState(it?.status ?? f?.status, !!it?.gpu_queued);
    return {
      key: `still:${s.name}`,
      id: s.name,
      set: "faces",
      kind: "still",
      sub: MECHANICS.has(s.name) ? "mechanic" : "face",
      emotion: null,
      state: !run && st === "queued" ? "empty" : st,
      src: f?.url ?? null,
      video: null,
      check: null,
      error: f?.error ?? it?.error ?? null,
    };
  });
  const files = new Map(p.files.clips.map((c) => [c.id, c]));
  const stillOf = (emotion: string | null | undefined, id: string) => {
    // (a reaction's tile shows the face it turns to: laugh → laugh, smile → smile; doze → sleepy)
    const want = id === "doze" ? "sleepy" : id === "think" || id === "think_b" ? "thinking" : emotion === "joy" ? "laugh" : emotion || id;
    return stillUrl.get(want)?.url ?? stillUrl.get(id)?.url ?? null;
  };
  const clipTiles = p.brief.clips.map((c): Tile => {
    const f = files.get(c.id);
    const clip = p.items[`clip:${c.id}`];
    const matte = p.items[`matte:${c.id}`];
    let st = itemState(clip?.status ?? f?.status, !!clip?.gpu_queued);
    // drawn, then its background taken off and encoded: "processing" until the matte is done
    if (st === "done" && matte && matte.status !== "done") st = matte.status === "failed" ? "failed" : "processing";
    if (!run && st === "queued") st = "empty";
    const set = (SETS.find((k) => SET_KINDS[k].includes(c.kind)) ?? "idle") as SetKey;
    return {
      key: `clip:${c.id}`,
      id: c.id,
      set,
      kind: "clip",
      sub: c.kind,
      emotion: c.emotion ?? null,
      state: st,
      src: stillOf(c.emotion, c.id) ?? p.files.home,
      video: f?.web ?? f?.raw ?? null,
      check: f?.check ?? null,
      error: f?.error ?? clip?.error ?? matte?.error ?? null,
    };
  });
  return SETS.map((key) => ({ key, tiles: key === "faces" ? faces : clipTiles.filter((t) => t.set === key) })).filter((r) => r.tiles.length > 0);
}

export interface CandidateView {
  id: string;
  state: SlotState;
  src: string | null;
  picked: boolean;
}

/** the design candidates: drawn ones with their pictures, the rest as they stand */
export function candidatesOf(p: AvatarProject): CandidateView[] {
  const drawn = new Map(p.files.candidates.map((c) => [c.id, c.url]));
  const keys = Object.keys(p.items)
    .filter((k) => k.startsWith("design:"))
    .sort((a, b) => Number(a.slice(8).replace(/\D/g, "")) - Number(b.slice(8).replace(/\D/g, "")));
  const out: CandidateView[] = keys.map((k) => {
    const id = k.slice(7);
    return { id, state: itemState(p.items[k].status, !!p.items[k].gpu_queued), src: drawn.get(id) ?? null, picked: p.picked === id };
  });
  // planned but not started yet: empty places, as many as the brief asks for
  if (!out.length && p.brief.reference.mode !== "as_base") {
    for (let i = 1; i <= Math.max(1, p.brief.candidates); i++) out.push({ id: `c${i}`, state: "empty", src: null, picked: false });
  }
  return out;
}

export type HomeState = SlotState | "waiting";

/** the base picture: drawn, waiting for the user's approval, or not yet */
export function homeState(p: AvatarProject): HomeState {
  if (p.checkpoint?.stage === "home") return "waiting";
  const it = p.items.home;
  if (it) {
    const st = itemState(it.status, !!it.gpu_queued);
    if (st === "done" && p.files.home) return "done";
    return st === "queued" && !started(p) ? "empty" : st;
  }
  if (p.files.home) return "done";
  return "empty";
}

export type Waiting = "pick" | "home" | "stills" | "estimate" | "extra" | "cap" | null;

/** what waits for the user now (one thing at a time, the most urgent first) */
export function waitingFor(p: AvatarProject): Waiting {
  if (p.extras.some((x) => x.status === "pending")) return "extra";
  if (p.status === "waiting" && p.checkpoint) return p.checkpoint.stage;
  if (p.status === "estimate" && p.plan && !p.confirmation) return "estimate";
  return null;
}

export interface Progress {
  done: number;
  total: number;
}

/** what is finished of what is planned: the required fields, the base picture, every still and clip */
export function progressOf(p: AvatarProject, opts: { needs: number; filled: number; skipped: boolean }): Progress {
  const rows = rowsOf(p);
  const tiles = rows.flatMap((r) => r.tiles);
  const avatar = opts.skipped ? 0 : 1 + tiles.length;
  const avatarDone = opts.skipped ? 0 : (homeState(p) === "done" ? 1 : 0) + tiles.filter((t) => t.state === "done").length;
  return { done: opts.filled + avatarDone, total: opts.needs + avatar };
}

/** the clip checks rolled up: seams (first frame = last frame), starts (from the base picture), clean backgrounds */
export function checksOf(p: AvatarProject): { seam: [number, number]; start: [number, number]; clean: [number, number]; failed: string[] } | null {
  const all = Object.entries(p.check?.clips ?? {}).filter(([, c]) => c && !c.missing);
  if (!all.length) return null;
  const pass = (f: (c: ClipCheck) => boolean): [number, number] => [all.filter(([, c]) => f(c)).length, all.length];
  return {
    seam: pass((c) => (c.seam ?? 99) < 3),
    start: pass((c) => (c.start ?? 99) < 4),
    clean: pass((c) => (c.drift ?? 99) < 10 && (c.soft ?? 1) < 0.12),
    failed: all.filter(([, c]) => !c.ok).map(([id]) => id),
  };
}

/** a tool of the creation agent → the nodes it works on (a running tool lights them) */
export function nodesOfTool(name: string, input: unknown): NodeKey[] {
  const tool = name.replace(/^mcp__avatar__/, "");
  if (tool === "update_mate_draft") return [...new Set(fieldPaths(input).map(nodeOfField))];
  if (tool === "update_brief") return ["brief"];
  if (tool === "use_reference") return ["refs", "brief"];
  if (tool === "estimate") return ["estimate"];
  if (tool === "look") return ["candidates", "home"];
  if (tool === "regenerate" || tool === "extend") return ["estimate"];
  if (tool === "map_avatar_emotions") return ["motions", "mate"];
  return [];
}

/** update_mate_draft's arguments → the field paths it writes (as AvatarChat's draftPaths, the server's paths_of) */
export function fieldPaths(input: unknown): string[] {
  const a = (input || {}) as Record<string, unknown>;
  const f = (a.fields && typeof a.fields === "object" ? a.fields : a) as Record<string, Record<string, unknown> | string | undefined>;
  const out: string[] = [];
  if (typeof f.name === "string") out.push("name");
  for (const k of Object.keys((f.persona as object) || {})) out.push(`persona.${k}`);
  for (const [k, v] of Object.entries((f.prefs as object) || {})) {
    if (k === "tone" && v && typeof v === "object") out.push(...Object.keys(v as object).map((x) => `prefs.tone.${x}`));
    else out.push(`prefs.${k}`);
  }
  for (const k of Object.keys((f.concept as object) || {})) out.push(`concept.${k}`);
  return out;
}

/** a studio field path → its input node */
export function nodeOfField(path: string): InputKey {
  if (path.startsWith("concept.")) return "concept";
  if (path.startsWith("prefs.") || path === "persona.language") return "style";
  if (path.startsWith("voice")) return "voice";
  if (path.startsWith("llm")) return "model";
  return "profile";
}

/** the busy tiles' set rows, the busy nodes (for flowing lines) */
export const going = (s: SlotState | HomeState) => s === "running" || s === "queued" || s === "processing";

export type Tone = "faint" | "accent" | "ok" | "warn";
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Line {
  id: string;
  d: string;
  tone: Tone;
  flow?: boolean;
  thick?: boolean;
}

export const curve = (ax: number, ay: number, bx: number, by: number) => {
  const dx = Math.max(24, Math.abs(bx - ax) * 0.5);
  return `M${r1(ax)} ${r1(ay)}C${r1(ax + dx)} ${r1(ay)} ${r1(bx - dx)} ${r1(by)} ${r1(bx)} ${r1(by)}`;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

/** a polyline with rounded corners */
export function rounded(points: [number, number][], r = 10): string {
  let d = `M${r1(points[0][0])} ${r1(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    const la = Math.hypot(x - px, y - py) || 1;
    const lb = Math.hypot(nx - x, ny - y) || 1;
    const a = Math.min(r, la / 2);
    const b = Math.min(r, lb / 2);
    d += `L${r1(x - ((x - px) / la) * a)} ${r1(y - ((y - py) / la) * a)}Q${r1(x)} ${r1(y)} ${r1(x + ((nx - x) / lb) * b)} ${r1(y + ((ny - y) / lb) * b)}`;
  }
  const last = points[points.length - 1];
  return `${d}L${r1(last[0])} ${r1(last[1])}`;
}

export interface LineState {
  worldH: number;
  /** the inputs that feed the look (concept / references written) */
  looks: { concept: boolean; refs: boolean };
  briefReady: boolean;
  estimate: "none" | "waiting" | "confirmed";
  candidates: "empty" | "busy" | "done";
  home: HomeState;
  ready: boolean;
  /** inputs that go to the mate along the bottom (who she is, how she talks, her voice and model) */
  direct: InputKey[];
  hasCheck: boolean;
}

/** her look from a file (a Live2D model, a LivLiv package, a clip pack): the file → her emotions matched → the mate,
 *  and who she is straight to the mate along the bottom */
export function fileLinesOf(b: Record<string, Box>, o: { worldH: number; has: boolean; mapped: boolean; direct: InputKey[] }): Line[] {
  const out: Line[] = [];
  const right = (k: string): [number, number] | null => (b[k] ? [b[k].x + b[k].w, b[k].y + b[k].h / 2] : null);
  const left = (k: string): [number, number] | null => (b[k] ? [b[k].x, b[k].y + b[k].h / 2] : null);
  const link = (id: string, from: string, to: string, tone: Tone) => {
    const a = right(from);
    const c = left(to);
    if (a && c) out.push({ id, d: curve(a[0], a[1], c[0], c[1]), tone });
  };
  link("concept-import", "concept", "import", o.has ? "accent" : "faint");
  link("import-motions", "import", "motions", o.has ? "accent" : "faint");
  link("motions-mate", "motions", "mate", o.mapped ? "ok" : o.has ? "accent" : "faint");
  const m = b.mate;
  if (m) {
    const y = o.worldH - 18;
    const inX = m.x - 22;
    const to: [number, number] = [m.x, m.y + m.h - 30];
    o.direct.forEach((k, i) => {
      const a = right(k);
      if (a) out.push({ id: `${k}-mate`, d: rounded([[a[0], a[1]], [a[0] + 14 + i * 3, a[1]], [a[0] + 14 + i * 3, y - i * 4], [inX, y - i * 4], [inX, to[1]], to]), tone: "faint" });
    });
  }
  return out;
}

/** the connectors between the measured boxes (`data-g` keys: node keys, `tile:<key>`, `cand:<id>`) */
export function linesOf(b: Record<string, Box>, rows: Row[], o: LineState): Line[] {
  const out: Line[] = [];
  const right = (k: string): [number, number] | null => (b[k] ? [b[k].x + b[k].w, b[k].y + b[k].h / 2] : null);
  const left = (k: string): [number, number] | null => (b[k] ? [b[k].x, b[k].y + b[k].h / 2] : null);
  const link = (id: string, from: string, to: string, tone: Tone, flow?: boolean) => {
    const a = right(from);
    const c = left(to);
    if (a && c) out.push({ id, d: curve(a[0], a[1], c[0], c[1]), tone, flow });
  };
  // (a node under another in the same column: straight down from its bottom to the next one's top)
  const down = (id: string, from: string, to: string, tone: Tone, flow?: boolean) => {
    const a = b[from];
    const c = b[to];
    if (a && c) out.push({ id, d: `M${r1(a.x + a.w / 2)} ${r1(a.y + a.h)}L${r1(c.x + c.w / 2)} ${r1(c.y)}`, tone, flow });
  };
  const homeBusy = going(o.home);
  link("concept-brief", "concept", "brief", o.looks.concept ? "accent" : "faint");
  link("refs-brief", "refs", "brief", o.looks.refs ? "accent" : "faint");
  down("brief-estimate", "brief", "estimate", o.briefReady ? "accent" : "faint");
  link("estimate-candidates", "estimate", b.candidates ? "candidates" : "home", o.estimate === "confirmed" ? "accent" : o.estimate === "waiting" ? "warn" : "faint", o.candidates === "busy" || (!b.candidates && homeBusy));
  down("candidates-home", "candidates", "home", o.candidates === "done" ? "accent" : "faint", homeBusy);
  for (const row of rows) {
    const busy = row.tiles.some((t) => going(t.state));
    const set = `set:${row.key}`;
    link(`home-${row.key}`, "home", set, o.home === "done" ? "accent" : "faint", busy);
    const placed = row.tiles.map((t) => ({ ...t, box: b[`tile:${t.key}`] })).filter((t) => t.box);
    const from = right(set);
    if (!placed.length || !from) continue;
    // tiles in their visual lanes (a set wraps after five)
    const lanes = new Map<number, typeof placed>();
    for (const t of placed) lanes.set(Math.round(t.box.y), [...(lanes.get(Math.round(t.box.y)) ?? []), t]);
    const ys = [...lanes.keys()].sort((p, q) => p - q);
    const spineX = placed[0].box.x - 10;
    const live = placed.some((t) => t.state !== "empty");
    out.push({ id: `${row.key}-in`, d: curve(from[0], from[1], spineX + 6, ys[0] - 10), tone: live ? "accent" : "faint", flow: busy });
    ys.forEach((y, i) => {
      const lane = lanes.get(y)!;
      const lastX = Math.max(...lane.map((t) => t.box.x + t.box.w / 2));
      out.push({
        id: `${row.key}-bus-${i}`,
        d: rounded(i ? [[spineX, ys[i - 1] - 10], [spineX, y - 10], [lastX, y - 10]] : [[spineX + 6, y - 10], [lastX, y - 10]]),
        tone: live ? "accent" : "faint",
        flow: busy,
      });
      for (const t of lane) {
        const cx = t.box.x + t.box.w / 2;
        out.push({ id: `drop-${t.key}`, d: `M${r1(cx)} ${r1(y - 10)}L${r1(cx)} ${r1(y)}`, tone: t.state !== "empty" ? "accent" : "faint", flow: t.state === "running" || t.state === "processing" });
      }
    });
    // under each lane: green under what is done; every row goes on to the check
    const rightX = Math.max(...placed.map((t) => t.box.x + t.box.w)) + 10;
    const under = (lane: typeof placed) => Math.max(...lane.map((t) => t.box.y + t.box.h)) + 5;
    ys.forEach((y, i) => {
      const lane = lanes.get(y)!;
      const uy = under(lane);
      out.push({ id: `${row.key}-under-${i}`, d: `M${r1(lane[0].box.x)} ${r1(uy)}L${r1(rightX)} ${r1(uy)}`, tone: "faint" });
      for (const t of lane) {
        if (t.state === "done") out.push({ id: `done-${t.key}`, d: `M${r1(t.box.x)} ${r1(uy)}L${r1(t.box.x + t.box.w + 8)} ${r1(uy)}`, tone: "ok", thick: true });
        if (t.state === "failed") out.push({ id: `fail-${t.key}`, d: `M${r1(t.box.x)} ${r1(uy)}L${r1(t.box.x + t.box.w + 8)} ${r1(uy)}`, tone: "warn", thick: true });
      }
    });
    const firstU = under(lanes.get(ys[0])!);
    const lastU = under(lanes.get(ys[ys.length - 1])!);
    if (ys.length > 1) out.push({ id: `${row.key}-spine`, d: `M${r1(rightX)} ${r1(firstU)}L${r1(rightX)} ${r1(lastU)}`, tone: "faint" });
    const check = left("check");
    const all = placed.every((t) => t.state === "done");
    const any = placed.some((t) => t.state === "done");
    if (check) out.push({ id: `${row.key}-check`, d: curve(rightX, lastU, check[0], check[1]), tone: all ? "ok" : any ? "accent" : "faint", flow: busy });
  }
  link("check-mate", "check", "mate", o.ready ? "ok" : o.hasCheck ? "accent" : "faint");
  // who she is, how she talks, her voice and her model go straight to the mate, along the bottom
  const m = b.mate;
  if (m) {
    const y = o.worldH - 18;
    const inX = m.x - 22;
    const to: [number, number] = [m.x, m.y + m.h - 30];
    o.direct.forEach((k, i) => {
      const a = right(k);
      if (a) out.push({ id: `${k}-mate`, d: rounded([[a[0], a[1]], [a[0] + 14 + i * 3, a[1]], [a[0] + 14 + i * 3, y - i * 4], [inX, y - i * 4], [inX, to[1]], to]), tone: "faint" });
    });
  }
  return out;
}
