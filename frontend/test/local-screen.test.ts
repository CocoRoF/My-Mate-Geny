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
const storage=new Map<string,string>();
Object.assign(globalThis, { window: win, location:{origin:"https://test"},localStorage: { getItem:(k:string)=>storage.get(k)||null,setItem:(k:string,v:string)=>storage.set(k,v) } });
const calls: any[] = [];
const native = {
  version: 3,
  cancel: async () => {},
  setChoice: async (...args: any[]) => { calls.push(["choice", ...args]); return true; },
  request: async (req: any) => { calls.push(["request", req]); return { ok: true, data: new Uint8Array([1, 2]), mime: "image/png" }; },
  grab: async (req: any) => { calls.push(["grab", req]); return { ok: true, data: new Uint8Array([1, 2]), mime: "image/png" }; },
};
(win as any).hrhNative = { capture: native };
const screen = await import("../src/mate/localScreen.ts");

test("sharing is explicit, session scoped and always \"with each message\"; stop follows immediately", async () => {
  const prefs = await import("../src/stores/devicePreferences.ts");
  assert.deepEqual(screen.sharedScopes(), {});
  await assert.rejects(screen.localFrame("other"));
  // (a mode saved by an older version is not what a share is any more)
  await prefs.patchDevicePreferences({ sharing: { mode: "ask" } });
  await screen.beginSharing("sid", "Test conversation", { id: "screen:1:0", name: "Display 1", kind: "screen" });
  assert.deepEqual(screen.sharedScopes(), { sid: "on_turn" });
  assert.deepEqual(calls[0], ["choice", "session:sid", { id: "screen:1:0", name: "Display 1", kind: "screen" }]);
  await assert.rejects(screen.localFrame("other"));
  const file = await screen.localFrame("sid", "req1", true);
  assert.equal(file.type, "image/png");
  assert.equal(calls[1][1].mate_id, "session:sid");
  assert.equal(calls[1][1].ask, true);
  assert.equal(calls[1][1].hide_avatar, false);
  assert.equal(screen.sharingSnapshot()?.capturing, false);
  screen.stopSharing();
  assert.deepEqual(screen.sharedScopes(), {});
  await assert.rejects(screen.localFrame("sid"));
});

test("not shared, she still looks once: the desktop app's own capture, asking first as this device says", async () => {
  const { handleCaptureRequest } = await import("../src/mate/screenCapture.ts");
  const prefs = await import("../src/stores/devicePreferences.ts");
  const posted: [string, any][] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    posted.push([url, JSON.parse(String(init.body))]);
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
  const original = native.request;
  native.request = async (req: any) => { calls.push(["request", req]); return { ok: false, code: "denied" } as any; };
  (native as any).runtime = 1; // (the app-lifetime owner of a share — and sharing is off)
  try {
    assert.equal(prefs.devicePreferences().sharing.enabled, false);
    for (const [approval, ask] of [["ask", true], ["allow", false]] as const) {
      await prefs.patchDevicePreferences({ screen: { approval, max_edge: 1280 } });
      await handleCaptureRequest({ id: `cap_${approval}`, mate_id: "m1", mate_name: "Geny", session_id: "sid", scope: "mate",
        proof: "p", ask: !ask, hide_avatar: true, max_edge: 1920, timeout_ms: 45000 });
      const req = calls.at(-1)[1];
      assert.deepEqual([req.id, req.ask, req.max_edge, req.hide_avatar], [`cap_${approval}`, ask, 1280, false]);
      assert.equal(posted.at(-1)![0], `/api/mates/m1/capture/cap_${approval}`);
      assert.equal(posted.at(-1)![1].ok, false); // (every request is answered — here: no)
    }
  } finally {
    native.request = original;
    delete (native as any).runtime;
    globalThis.fetch = realFetch;
  }
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
  native.version = 3;
});

test("all screens: every picture of a share, the one in use first; asked for one, the bridge is told so", async () => {
  const original = native.request;
  const picture = (n: number, name: string, role: string) => ({ data: new Uint8Array([n]), mime: "image/png", width: 2, height: 1, source: { id: `screen:${n}:0`, name, kind: "screen" }, role });
  native.request = async (req: any) => {
    calls.push(["request", req]);
    const shots = [picture(1, "Display 2", "main"), picture(0, "Display 1", "sub")];
    return { ok: true, ...shots[0], ...(req.multi ? { shots } : {}) };
  };
  native.version = 4;
  const all = { id: "screen:all", name: "All screens", kind: "screen" as const };
  await screen.beginSharing("sid", "Test", all);
  assert.deepEqual(calls.at(-1), ["choice", "session:sid", all]);
  assert.equal(screen.sharingSnapshot()?.source, "All screens");
  const pics = await screen.localFrames("sid", "req4", false, { multi: true });
  assert.equal(calls.at(-1)[1].multi, true);
  assert.deepEqual(pics.map((p) => [p.role, p.source?.name, p.file.name.split("-").slice(0, 2).join("-")]),
    [["main", "Display 2", "screen-main"], ["sub", "Display 1", "screen-other"]]);
  // one frame (observation, an older server): one picture, named as before
  const one = await screen.localFrame("sid", "req5");
  assert.equal(calls.at(-1)[1].multi, false);
  assert.match(one.name, /^screen-\d{8}-\d{6}\.png$/);
  native.request = original;
  // an older app cannot share all screens: it says so instead of sharing one
  native.version = 3;
  await assert.rejects(screen.beginSharing("sid", "Test", all));
  assert.deepEqual(screen.sharedScopes(), {});
});
