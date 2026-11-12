// The avatar's pan / zoom (src/mate/avatar/view.ts): a mouse-wheel notch ≈ 5–6 %, Ctrl / Shift + wheel ≈ 2 %, a pinch
// follows the fingers; the point under the pointer stays put. Her fitted figure: whole in every shape of stage; a pan /
// zoom kept against it, kept in reach, and let go on a stage of quite another shape.
import assert from "node:assert/strict";
import test from "node:test";
import {
  clampView,
  fitRect,
  fromKept,
  isHome,
  KEEP,
  MARGIN,
  readKept,
  REFIT_SHAPE,
  shapeMoved,
  toKept,
  viewIn,
  VIEW_HOME,
  wheelZoom,
  zoomAt,
  type AvatarViewT,
  type FigureShape,
  type FitRect,
} from "../src/mate/avatar/view";

const wheel = (o: Partial<{ deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; shiftKey: boolean }>) => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  shiftKey: false,
  ...o,
});
const step = (e: ReturnType<typeof wheel>) => {
  const { delta, speed } = wheelZoom(e);
  return zoomAt(VIEW_HOME, delta, 0.5, 0.5, speed).z;
};

test("a wheel notch zooms in about 5–6 %, back out the same", () => {
  const z = step(wheel({ deltaY: -100 }));
  assert.ok(z > 1.05 && z < 1.06, `notch in: ${z}`);
  const out = step(wheel({ deltaY: 100 }));
  assert.ok(out < 0.95 && out > 0.94, `notch out: ${out}`);
});

test("Ctrl or Shift + wheel is the fine step (≈ 2 %) — Shift's sideways delta too", () => {
  for (const e of [wheel({ deltaY: -100, ctrlKey: true }), wheel({ deltaY: -100, shiftKey: true }), wheel({ deltaX: -100, shiftKey: true })]) {
    const z = step(e);
    assert.ok(z > 1.015 && z < 1.025, `fine: ${z}`);
  }
});

test("lines (Firefox) count like pixels; a trackpad pinch follows the fingers", () => {
  const lines = step(wheel({ deltaY: -3, deltaMode: 1 }));
  assert.ok(lines > 1.05 && lines < 1.06, `3 lines: ${lines}`);
  const pinch = step(wheel({ deltaY: -6.5, ctrlKey: true }));
  assert.ok(pinch > 1.06, `pinch: ${pinch}`);
  // (Ctrl + a notch on a zoomed page is still a notch: not mistaken for a pinch)
  const zoomedPage = step(wheel({ deltaY: -90.90909, ctrlKey: true }));
  assert.ok(zoomedPage < 1.025, `ctrl notch at 110 %: ${zoomedPage}`);
});

test("the point under the pointer stays put", () => {
  const v = zoomAt(VIEW_HOME, -100, 0.3, 0.2);
  // q = 0.3 is drawn at t + z·q
  assert.ok(Math.abs(v.x + v.z * 0.3 - 0.3) < 1e-9);
  assert.ok(Math.abs(v.y + v.z * 0.2 - 0.2) < 1e-9);
});

// ── her fitted figure, and a view kept against it ──

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
// stage areas measured in the browser (split at 1440 × 900, split in a tall window, stacked narrow, a phone, stacked
// wide and short, the desktop overlay) and a few more
const STAGES: [number, number][] = [[570, 835], [490, 1135], [400, 1135], [600, 355], [390, 299], [1332, 315], [300, 360], [1000, 1000], [2560, 300]];
// her default set (han Chaerin), a set with a big sleeve widening her box, a narrow full-length one; Live2D; LivLiv
const FIGURES: FigureShape[] = [{ aspect: 1130 / 1294 }, { aspect: 1.45 }, { aspect: 0.45 }, { aspect: 0.79, scale: 0.85, anchorY: 0.5 }, { aspect: 2 / 3, anchorY: 0.5 }];

/** her figure as drawn under view `v`, in px of a w × h stage */
const drawn = (v: AvatarViewT, f: FitRect, w: number, h: number) => ({
  l: (v.x + v.z * f.x) * w,
  t: (v.y + v.z * f.y) * h,
  r: (v.x + v.z * (f.x + f.w)) * w,
  b: (v.y + v.z * (f.y + f.h)) * h,
});
/** a point of her figure (fractions of it) as drawn, in px */
const at = (v: AvatarViewT, f: FitRect, w: number, h: number, u: number, s: number) => ({ x: (v.x + v.z * (f.x + u * f.w)) * w, y: (v.y + v.z * (f.y + s * f.h)) * h });
/** at least KEEP of her middle (her box without MARGIN on each side), or of the stage once it is bigger, in sight */
const inSight = (a: number, b: number, size: number) => {
  const m0 = a + MARGIN * (b - a);
  const m1 = b - MARGIN * (b - a);
  return Math.max(0, Math.min(m1, size) - Math.max(m0, 0)) >= KEEP * Math.min(m1 - m0, size) - 1e-6;
};

test("fitted, she is whole in every shape of stage: the smaller of the two scales, centred, a picture on the bottom edge", () => {
  for (const [w, h] of STAGES) {
    for (const fig of FIGURES) {
      const f = fitRect(fig, w, h);
      const d = drawn(VIEW_HOME, f, w, h);
      const what = `${fig.aspect.toFixed(2)} in ${w}×${h}`;
      assert.ok(d.l >= -1e-6 && d.t >= -1e-6 && d.r <= w + 1e-6 && d.b <= h + 1e-6, `inside: ${what}`);
      // contained: as big as the stage allows (at her scale) on one axis — a tall stage by its width, a wide one by its height
      const byWidth = w / h < fig.aspect;
      near(byWidth ? d.r - d.l : d.b - d.t, (byWidth ? w : h) * (fig.scale ?? 1), 1e-6 * Math.max(w, h));
      near((d.r - d.l) / (d.b - d.t), fig.aspect, 1e-9);
      near((d.l + d.r) / 2, w / 2, 1e-6 * w);
      if ((fig.anchorY ?? 1) === 1) near(d.b, h, 1e-6 * h);
      else near((d.t + d.b) / 2, h / 2, 1e-6 * h);
    }
  }
});

test("a tall, narrow stage fits her by its width, not by its height (the report: her face cut by the right edge)", () => {
  const f = fitRect({ aspect: 1130 / 1294 }, 490, 1135);
  near(f.w, 1);
  assert.ok(f.h < 0.5, `she stands in the lower half: ${f.h}`);
  near(f.y + f.h, 1);
});

test("a pan / zoom never takes more than half of her middle out of sight — half the stage stays her, zoomed past it", () => {
  for (const [w, h] of STAGES) {
    for (const fig of FIGURES) {
      const f = fitRect(fig, w, h);
      for (const z of [0.3, 0.7, 1, 1.6, 2.5, 4]) {
        for (const x of [-9, -1.5, -0.4, 0, 0.6, 3]) {
          for (const y of [-7, -0.8, 0, 0.9, 5]) {
            const v = clampView({ x, y, z }, f);
            const d = drawn(v, f, w, h);
            const what = `${fig.aspect.toFixed(2)} in ${w}×${h} at ${x},${y},${z}`;
            assert.ok(inSight(d.l, d.r, w), `across: ${what}`);
            assert.ok(inSight(d.t, d.b, h), `up and down: ${what}`);
          }
        }
      }
      // (fitted is in reach as it is)
      assert.deepEqual(clampView(VIEW_HOME, f), VIEW_HOME);
    }
  }
});

test("the wheel on the empty side of a wide stage can't zoom her out of it", () => {
  const [w, h] = [1332, 315];
  const f = fitRect({ aspect: 1130 / 1294 }, w, h);
  let v = VIEW_HOME;
  for (let i = 0; i < 30; i++) v = zoomAt(v, -100, 0.98, 0.5, undefined, f);
  const d = drawn(v, f, w, h);
  assert.ok(v.z > 3);
  assert.ok(inSight(d.l, d.r, w));
});

test("kept against her figure, a view comes back as it was in the same stage; fitted is no view at all", () => {
  for (const [w, h] of STAGES) {
    const f = fitRect({ aspect: 0.873 }, w, h);
    const v = clampView({ x: -0.31, y: -0.12, z: 1.8 }, f);
    const back = fromKept(toKept(v, f, w / h), f);
    near(back.x, v.x);
    near(back.y, v.y);
    near(back.z, v.z);
  }
  const f = fitRect({ aspect: 0.873 }, 490, 1135);
  const home = toKept(VIEW_HOME, f, 490 / 1135);
  assert.deepEqual([home.z, home.ox, home.oy], [1, 0, 0]);
  assert.ok(isHome(fromKept(home, f)));
});

test("a zoom made on a wide stage, shown on a narrow tall one, is the same of her: her face where her fitted face is", () => {
  const fig = { aspect: 1130 / 1294 };
  const face = [0.48, 0.32];
  const [ww, wh] = [1332, 315];
  const fw = fitRect(fig, ww, wh);
  const p = at(VIEW_HOME, fw, ww, wh, face[0], face[1]);
  let v = VIEW_HOME;
  for (let i = 0; i < 12; i++) v = zoomAt(v, -100, p.x / ww, p.y / wh, undefined, fw);
  assert.ok(v.z > 1.9);
  const kept = toKept(v, fw, ww / wh);
  for (const [w, h] of [[490, 1135], [600, 355], [390, 299]]) {
    const f = fitRect(fig, w, h);
    const now = viewIn(kept, fig, { w, h }, false);
    const shown = at(now, f, w, h, face[0], face[1]);
    const fitted = at(VIEW_HOME, f, w, h, face[0], face[1]);
    near(shown.x, fitted.x, 1e-6 * w);
    near(shown.y, fitted.y, 1e-6 * h);
    near(now.z, v.z);
    // (as fractions of the box — the old way — her face went to the tall stage's bottom edge, her body under it)
    if (w === 490) assert.ok(at(v, f, w, h, face[0], face[1]).y > h * 0.95);
  }
});

test("the console's stage fits her whole again when its shape changed a lot since the view was made", () => {
  const fig = { aspect: 0.873 };
  const f = fitRect(fig, 570, 835);
  const kept = toKept(clampView({ x: -0.2, y: -0.1, z: 1.4 }, f), f, 570 / 835);
  // a little wider or taller: kept
  assert.ok(!isHome(viewIn(kept, fig, { w: 570, h: 735 }, true)));
  assert.ok(!isHome(viewIn(kept, fig, { w: 640, h: 835 }, true)));
  // a window turned tall, the stage on top: fitted (the overlay keeps it: its window's shape is the user's)
  assert.ok(isHome(viewIn(kept, fig, { w: 490, h: 1135 }, true)));
  assert.ok(isHome(viewIn(kept, fig, { w: 1332, h: 315 }, true)));
  assert.ok(!isHome(viewIn(kept, fig, { w: 490, h: 1135 }, false)));
  // not measured yet: fitted
  assert.ok(isHome(viewIn(kept, fig, null, false)));
  assert.equal(shapeMoved(1, REFIT_SHAPE * 0.99), false);
  assert.equal(shapeMoved(1, 1 / (REFIT_SHAPE * 0.99)), false);
  assert.equal(shapeMoved(1, REFIT_SHAPE * 1.01), true);
  assert.equal(shapeMoved(1, 1 / (REFIT_SHAPE * 1.01)), true);
  assert.equal(shapeMoved(0, 1), true);
});

test("a box view kept before (fractions of the box, its shape unknown): let go on the stage, kept in reach in the overlay", () => {
  const fig = { aspect: 0.873 };
  const old = { x: -3, y: 2, z: 2 };
  assert.ok(isHome(viewIn(old, fig, { w: 300, h: 360 }, true)));
  const v = viewIn(old, fig, { w: 300, h: 360 }, false);
  const d = drawn(v, fitRect(fig, 300, 360), 300, 360);
  assert.ok(inSight(d.l, d.r, 300));
  assert.ok(inSight(d.t, d.b, 360));
});

test("what is kept is read back; an older box view as one; anything else is no view", () => {
  const store = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: unknown };
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
  });
  try {
    store.set("a", JSON.stringify({ z: 1.5, ox: -0.2, oy: 0.1, shape: 0.68 }));
    assert.deepEqual(readKept("a"), { z: 1.5, ox: -0.2, oy: 0.1, shape: 0.68 });
    store.set("b", JSON.stringify({ x: -0.19, y: -0.11, z: 1.39 }));
    assert.deepEqual(readKept("b"), { x: -0.19, y: -0.11, z: 1.39 });
    store.set("c", "{nope");
    assert.equal(readKept("c"), null);
    store.set("d", JSON.stringify({ z: "2", ox: 0, oy: 0 }));
    assert.equal(readKept("d"), null);
    assert.equal(readKept("missing"), null);
    assert.equal(readKept(null), null);
  } finally {
    if (had) Object.defineProperty(globalThis, "localStorage", had);
    else delete g.localStorage;
  }
});
