// The avatar's zoom steps (src/mate/avatar/view.ts): a mouse-wheel notch ≈ 5–6 %, Ctrl / Shift + wheel ≈ 2 %, a pinch
// follows the fingers; the point under the pointer stays put.
import assert from "node:assert/strict";
import test from "node:test";
import { VIEW_HOME, wheelZoom, zoomAt } from "../src/mate/avatar/view";

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
