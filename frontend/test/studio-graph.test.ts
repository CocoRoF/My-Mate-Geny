// The studio canvas's state (src/components/mate/studio/canvas/graph.ts): what each node and tile shows from the
// project the server sends — planned before Confirm, queued after; a clip drawn but not yet matted is finishing;
// what waits for the user, the checks, the agent's tools → their nodes, the lines between measured boxes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatesOf, checksOf, homeState, linesOf, nodesOfTool, progressOf, rowsOf, waitingFor } from "../src/components/mate/studio/canvas/graph.ts";
import type { AvatarProject } from "../src/api/avatar.ts";

function project(over: Partial<AvatarProject> = {}): AvatarProject {
  return {
    id: "av_1",
    title: "t",
    status: "interview",
    phase: null,
    language: "ko",
    session_id: "s",
    brief: {
      reference: { mode: "none", files: [] },
      design: { prompt: "", notes: "" },
      pronoun: "she",
      candidates: 4,
      aspect: "1:1",
      tier: "studio",
      preset: "minimal",
      clips: [
        { id: "idle_a", kind: "idle", action: "breathes" },
        { id: "talk_a", kind: "talk", action: "talks" },
        { id: "listen", kind: "listen", action: "listens" },
        { id: "laugh", kind: "react", action: "laughs", emotion: "joy" },
        { id: "doze", kind: "away", action: "dozes", loop: true },
      ],
      stills: [
        { name: "laugh", face: "laughing" },
        { name: "blink", face: "eyes closed" },
      ],
      target: { mode: "new", mate_id: null, name: "" },
    },
    question: null,
    plan: null,
    confirmation: null,
    extras: [],
    items: {},
    checkpoint: null,
    paused: false,
    picked: null,
    check: null,
    result: null,
    applied: null,
    error: null,
    processing: null,
    ledger: { committed: 0, jobs: 0 },
    credits: { committed: 0, cap: 0, confirmed: null, reserve: null },
    files: { refs: [], candidates: [], stills: [], clips: [], home: null, face: null },
    preview: null,
    agent_running: false,
    log: [],
    updated_at: "",
    version: 1,
    ...over,
  } as AvatarProject;
}

const item = (stage: string, status: "pending" | "running" | "done" | "failed") => ({ key: "", stage, status, tries: 0, credits: 0 });

test("the sets: faces first, clips by kind; planned before Confirm, queued after", () => {
  const p = project();
  const rows = rowsOf(p);
  assert.deepEqual(rows.map((r) => r.key), ["faces", "idle", "talk", "react", "away"]);
  assert.deepEqual(rows.find((r) => r.key === "talk")!.tiles.map((t) => t.id), ["talk_a", "listen"]);
  assert.deepEqual(rows[0].tiles.map((t) => [t.id, t.sub]), [["laugh", "face"], ["blink", "mechanic"]]);
  assert.ok(rows.flatMap((r) => r.tiles).every((t) => t.state === "empty"));
  const started = project({
    confirmation: { plan_id: "p", total: 10, cap: 12, at: "" },
    items: { "clip:idle_a": item("clips", "pending"), "clip:laugh": item("clips", "running"), "still:laugh": item("stills", "done") },
    files: { refs: [], candidates: [], stills: [{ name: "laugh", status: "done", url: "/l.jpg" }], clips: [], home: "/home.jpg", face: null },
  });
  const tiles = Object.fromEntries(rowsOf(started).flatMap((r) => r.tiles).map((t) => [t.key, t]));
  assert.equal(tiles["clip:idle_a"].state, "queued");
  assert.equal(tiles["clip:laugh"].state, "running");
  assert.equal(tiles["still:laugh"].state, "done");
  // a reaction's tile shows the face it turns to; an idle clip the base picture
  assert.equal(tiles["clip:laugh"].src, "/l.jpg");
  assert.equal(tiles["clip:idle_a"].src, "/home.jpg");
});

test("a clip drawn but not matted yet is finishing; a failed matte fails it", () => {
  const p = project({
    confirmation: { plan_id: "p", total: 10, cap: 12, at: "" },
    items: { "clip:idle_a": item("clips", "done"), "matte:idle_a": item("matte", "running"), "clip:talk_a": item("clips", "done"), "matte:talk_a": item("matte", "failed") },
  });
  const tiles = Object.fromEntries(rowsOf(p).flatMap((r) => r.tiles).map((t) => [t.key, t]));
  assert.equal(tiles["clip:idle_a"].state, "processing");
  assert.equal(tiles["clip:talk_a"].state, "failed");
});

test("candidates: empty places before the run, then the items, the picked one marked", () => {
  assert.deepEqual(candidatesOf(project()).map((c) => c.state), ["empty", "empty", "empty", "empty"]);
  assert.deepEqual(candidatesOf(project({ brief: { ...project().brief, reference: { mode: "as_base", files: ["a.png"] } } })), []);
  const p = project({
    items: { "design:c1": item("design", "done"), "design:c2": item("design", "running"), "design:c10": item("design", "pending") },
    files: { refs: [], candidates: [{ id: "c1", url: "/c1.jpg", full: "/c1.png" }], stills: [], clips: [], home: null, face: null },
    picked: "c1",
  });
  assert.deepEqual(candidatesOf(p).map((c) => [c.id, c.state, c.picked]), [["c1", "done", true], ["c2", "running", false], ["c10", "queued", false]]);
});

test("what waits for the user: an extra first, then a checkpoint, then an unconfirmed estimate", () => {
  assert.equal(waitingFor(project()), null);
  const plan = { id: "p", total: 5 } as AvatarProject["plan"];
  assert.equal(waitingFor(project({ status: "estimate", plan })), "estimate");
  assert.equal(waitingFor(project({ status: "waiting", checkpoint: { stage: "home", at: "" } })), "home");
  assert.equal(homeState(project({ status: "waiting", checkpoint: { stage: "home", at: "" } })), "waiting");
  assert.equal(waitingFor(project({ status: "waiting", checkpoint: { stage: "pick", at: "" }, extras: [{ id: "x", reason: "", total: 2, status: "pending" }] })), "extra");
});

test("progress counts the required fields, the base picture and every tile", () => {
  const p = project({ files: { refs: [], candidates: [], stills: [{ name: "laugh", status: "done", url: "/l.jpg" }], clips: [], home: "/h.jpg", face: null } });
  assert.deepEqual(progressOf(p, { needs: 2, filled: 1, skipped: false }), { done: 1 + 1 + 1, total: 2 + 1 + 7 });
  assert.deepEqual(progressOf(p, { needs: 2, filled: 2, skipped: true }), { done: 2, total: 2 });
});

test("the checks rolled up", () => {
  assert.equal(checksOf(project()), null);
  const c = checksOf(project({ check: { clips: { a: { seam: 1, start: 2, drift: 3, soft: 0.05, ok: true }, b: { seam: 5, start: 2, drift: 3, soft: 0.2, ok: false } }, passed: false, redo: ["b"] } }))!;
  assert.deepEqual([c.seam, c.start, c.clean, c.failed], [[1, 2], [2, 2], [1, 2], ["b"]]);
});

test("the agent's tools light their nodes", () => {
  assert.deepEqual(nodesOfTool("mcp__avatar__update_mate_draft", { fields: { name: "서아", concept: { pitch: "x" }, prefs: { tone: { warmth: "high" } } } }).sort(), ["concept", "profile", "style"]);
  assert.deepEqual(nodesOfTool("mcp__avatar__estimate", {}), ["estimate"]);
  assert.deepEqual(nodesOfTool("mcp__avatar__use_reference", {}), ["refs", "brief"]);
  assert.deepEqual(nodesOfTool("mcp__avatar__get_project", {}), []);
});

test("the lines: a curve between boxes, a bus over each set's tiles, green under what is done", () => {
  const p = project({ confirmation: { plan_id: "p", total: 1, cap: 1, at: "" }, items: { "clip:idle_a": item("clips", "done") } });
  const rows = rowsOf(p).filter((r) => r.key === "idle");
  const boxes = {
    concept: { x: 0, y: 40, w: 100, h: 60 },
    brief: { x: 140, y: 40, w: 100, h: 60 },
    estimate: { x: 140, y: 120, w: 100, h: 60 },
    home: { x: 280, y: 60, w: 100, h: 130 },
    "set:idle": { x: 420, y: 60, w: 100, h: 80 },
    "tile:clip:idle_a": { x: 560, y: 70, w: 84, h: 112 },
    check: { x: 700, y: 80, w: 100, h: 80 },
    mate: { x: 840, y: 80, w: 120, h: 160 },
  };
  const lines = linesOf(boxes, rows, { worldH: 300, looks: { concept: true, refs: false }, briefReady: true, estimate: "confirmed", candidates: "done", home: "done", ready: false, direct: [], hasCheck: false });
  const ids = lines.map((l) => l.id);
  for (const id of ["concept-brief", "brief-estimate", "home-idle", "idle-in", "idle-bus-0", "drop-clip:idle_a", "done-clip:idle_a", "idle-check", "check-mate"]) assert.ok(ids.includes(id), id);
  assert.equal(lines.find((l) => l.id === "idle-check")!.tone, "ok");
  assert.ok(lines.find((l) => l.id === "concept-brief")!.d.startsWith("M100 70C"));
});
