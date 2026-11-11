// mate/avatar/desktopCursor.ts: the desktop's pointer outside the window comes in as the page's own pointer moves, for
// as long as an avatar that looks at it is shown (counted: two avatars, one feed).
import assert from "node:assert/strict";
import test from "node:test";

class FakePointerEvent extends Event {
  clientX: number;
  clientY: number;
  constructor(type: string, init: { clientX: number; clientY: number }) {
    super(type);
    this.clientX = init.clientX;
    this.clientY = init.clientY;
  }
}

test("the desktop's pointer comes in as the page's, while an avatar follows it", async () => {
  const win = new EventTarget() as any;
  const calls: boolean[] = [];
  let point: ((p: { x: number; y: number }) => void) | null = null;
  win.hrhNative = { cursor: { follow: (on: boolean) => calls.push(on), onPoint: (cb: any) => ((point = cb), () => (point = null)) } };
  (globalThis as any).window = win;
  (globalThis as any).PointerEvent = FakePointerEvent;
  const seen: [number, number][] = [];
  win.addEventListener("pointermove", (e: any) => seen.push([e.clientX, e.clientY]));
  const { followDesktopCursor } = await import("../src/mate/avatar/desktopCursor");

  const a = followDesktopCursor();
  const b = followDesktopCursor();
  assert.deepEqual(calls, [true], "one feed for two avatars");
  point!({ x: -120, y: 840 });
  assert.deepEqual(seen, [[-120, 840]]);
  a();
  a();
  assert.deepEqual(calls, [true], "still one avatar following");
  b();
  assert.deepEqual(calls, [true, false]);
  assert.equal(point, null, "no more points");
});

test("in a browser (no desktop bridge): nothing to do", async () => {
  (globalThis as any).window = new EventTarget();
  const { followDesktopCursor } = await import("../src/mate/avatar/desktopCursor");
  assert.doesNotThrow(() => followDesktopCursor()());
});
