const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDevicePreferences } = require("../src/device-preferences");
const { createSharing } = require("../src/capture-sharing");
const { EventEmitter } = require("node:events");
function store(seed = {}) {
  let data = seed;
  const events = [];
  const prefs = createDevicePreferences({
    readSettings: () => data,
    writeSettings: (p) => (data = { ...data, ...p }),
    changed: (v) => events.push(v),
  });
  return { prefs, events, data: () => data };
}
test("migrate active mate volume, archive all alternatives and legacy sources; never enable sharing", () => {
  const x = store({
    mateId: "b",
    captureSources: {
      a: { id: "screen:a", name: "A" },
      b: { id: "window:b", name: "B", kind: "window" },
    },
  });
  x.prefs.migrate({
    origin: "https://one",
    activeId: "a",
    mates: [
      { id: "a", volume: 0, screen: { format: "png" } },
      {
        id: "b",
        volume: 2.65,
        screen: { format: "jpeg", hide_avatar: false, max_edge: 2560 },
      },
    ],
  });
  const p = x.prefs.get();
  assert.equal(p.volume, 2.65);
  assert.equal(p.screen.source.id, "window:b");
  assert.equal(p.screen.format, "jpeg");
  assert.equal(p.screen.hide_avatar, false);
  assert.equal(p.migration.mates["https://one:a"].volume, 0);
  assert.equal(p.migration.sources.a.id, "screen:a");
  assert.equal(p.sharing, undefined);
  const restart = store(x.data());
  assert.equal(restart.prefs.get().volume, 2.65);
  restart.prefs.migrate({
    origin: "https://two",
    activeId: "a",
    mates: [{ id: "a", volume: 0.4, screen: { format: "png" } }],
  });
  assert.equal(restart.prefs.get().volume, 2.65);
  assert.equal(
    restart.prefs.get().migration.mates["https://two:a"].volume,
    0.4,
  );
});
test("explicit edits win over later migration; partial updates keep volume and capture in one revision stream", () => {
  const x = store();
  x.prefs.patch({ volume: 0 });
  x.prefs.patch({ screen: { format: "jpeg" } });
  x.prefs.migrate({
    activeId: "a",
    mates: [{ id: "a", volume: 3, screen: { format: "png" } }],
  });
  assert.equal(x.prefs.get().volume, 0);
  assert.equal(x.prefs.get().screen.format, "jpeg");
  x.prefs.patch({ volume: 99, screen: { quality: 0 } });
  assert.equal(x.prefs.get().volume, 3);
  assert.equal(x.prefs.get().screen.quality, 40);
  x.prefs.patch({ volume: NaN });
  assert.equal(x.prefs.get().volume, 3);
  assert.equal(x.prefs.get().screen.approval, "ask");
  assert.equal(x.events.length, 5);
});
test("app sharing has exactly one owner; any window can stop; closing owner revokes consent", () => {
  const events = [],
    commands = [],
    cancelled = [];
  const control = createSharing({
    broadcast: (fn) => events.push(fn),
    cancel: () => cancelled.push(true),
  });
  const web = (id) =>
    Object.assign(new EventEmitter(), {
      id,
      isDestroyed: () => false,
      send: (...a) => commands.push([id, ...a]),
    });
  const a = web(1),
    b = web(2);
  control.publish(a, { sid: "s", name: "A", source: "screen", mode: "ask" });
  assert.equal(control.snapshot(a).owner, true);
  assert.equal(control.snapshot(b).owner, false);
  assert.equal(control.snapshot(b).state.sid, "s");
  control.mode("on_turn", 180);
  assert.equal(commands.at(-1)[0], 1);
  control.stop();
  assert.equal(control.snapshot(a).state, null);
  assert.equal(cancelled.length, 1);
  control.publish(b, { sid: "t", mode: "observe" });
  b.emit("destroyed");
  assert.equal(control.active(), false);
});

test("sharing keeps a hidden owner's timer alive and restores its previous throttling on release",()=>{
  const changes=[];
  const owner=Object.assign(new EventEmitter(),{id:9,isDestroyed:()=>false,send(){},getBackgroundThrottling:()=>true,setBackgroundThrottling:v=>changes.push(v)});
  const control=createSharing({broadcast(){},cancel(){}});
  control.publish(owner,{sid:'s',mode:'ask'});
  assert.deepEqual(changes,[false]);
  control.publish(owner,null);
  assert.deepEqual(changes,[false,true]);
  control.publish(owner,{sid:'s',mode:'observe'});
  control.stop();
  assert.deepEqual(changes,[false,true,false,true]);
});
