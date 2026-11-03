import { test } from "node:test";
import assert from "node:assert/strict";

// Browser voice ownership uses page-lifetime timers. Do not keep this Node test worker alive.
const originalInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  const timer = originalInterval(...args); timer.unref(); return timer;
}) as typeof setInterval;
Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true });

// The source transport is fake here; Electron/browser end-to-end tests exercise the actual upload path.
const win = new EventTarget() as EventTarget & { hrhNative?: unknown; dispatchEvent: typeof EventTarget.prototype.dispatchEvent };
Object.assign(globalThis, { window: win, localStorage: { getItem: () => "testdevice", setItem() {} } });
const calls: any[] = [];
const native = {
  version: 2,
  setChoice: async (...args: any[]) => { calls.push(["choice", ...args]); return true; },
  request: async (req: any) => { calls.push(["request", req]); return { ok: true, data: new Uint8Array([1, 2]), mime: "image/png" }; },
  grab: async (req: any) => { calls.push(["grab", req]); return { ok: true, data: new Uint8Array([1, 2]), mime: "image/png" }; },
};
(win as any).hrhNative = { capture: native };
const screen = await import("../src/mate/localScreen.ts");

test("sharing is explicit, ephemeral and session scoped; source, mode and stop follow immediately", async () => {
  assert.deepEqual(screen.sharedScopes(), {});
  await assert.rejects(screen.localFrame("other"));
  await screen.beginSharing("sid", "Test conversation", { id: "screen:1:0", name: "Display 1", kind: "screen" });
  assert.deepEqual(screen.sharedScopes(), { sid: "ask" });
  assert.deepEqual(calls[0], ["choice", "session:sid", { id: "screen:1:0", name: "Display 1", kind: "screen" }]);
  await assert.rejects(screen.localFrame("other"));
  const file = await screen.localFrame("sid", "req1", true);
  assert.equal(file.type, "image/png");
  assert.equal(calls[1][1].mate_id, "session:sid");
  assert.equal(calls[1][1].ask, true);
  assert.equal(calls[1][1].hide_avatar, true);
  assert.equal(screen.sharingSnapshot()?.capturing, false);
  screen.setSharingMode("on_turn");
  assert.deepEqual(screen.sharedScopes(), { sid: "on_turn" });
  screen.setSharingMode("observe", 1);
  assert.equal(screen.sharingSnapshot()?.interval, 60);
  screen.stopSharing();
  assert.deepEqual(screen.sharedScopes(), {});
  await assert.rejects(screen.localFrame("sid"));
});

test("a stopped or cancelled in-flight capture cannot deliver an image", async () => {
  await screen.beginSharing("sid", "Test", { id: "screen:1:0", name: "Display", kind: "screen" });
  let resolve!: (value: any) => void;
  const original = native.request;
  native.request = async () => new Promise(r => { resolve = r; });
  const capture = screen.localFrame("sid", "req2");
  screen.stopSharing();
  resolve({ ok: true, data: new Uint8Array([1]), mime: "image/png" });
  await assert.rejects(capture);
  native.request = original;
  await screen.beginSharing("sid", "Test", { id: "screen:1:0", name: "Display", kind: "screen" });
  screen.cancelLocalCapture("req3");
  await assert.rejects(screen.localFrame("sid", "req3"));
  screen.stopSharing();
});

test("older native bridge cannot silently substitute an unavailable selected source", async () => {
  native.version = 1;
  await assert.rejects(screen.beginSharing("sid", "Test", { id: "screen:1:0", name: "Display", kind: "screen" }));
  assert.deepEqual(screen.sharedScopes(), {});
  native.version = 2;
});
