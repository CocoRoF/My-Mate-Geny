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
  assert.equal(p.screen.max_edge, 2560);
  assert.equal(p.screen.hide_avatar, false);
  assert.equal(p.migration.mates["https://one:a"].volume, 0);
  assert.equal(p.migration.sources.a.id, "screen:a");
  assert.equal(p.sharing.enabled, false);
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
  x.prefs.patch({ screen: { max_edge: 1280 } });
  x.prefs.migrate({
    activeId: "a",
    mates: [{ id: "a", volume: 3, screen: { format: "png" } }],
  });
  assert.equal(x.prefs.get().volume, 0);
  assert.equal(x.prefs.get().screen.max_edge, 1280);
  x.prefs.patch({ volume: 99, screen: { max_edge: 7 } });
  assert.equal(x.prefs.get().volume, 3);
  assert.equal(x.prefs.get().screen.max_edge, 1280);
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

test("persistent intent survives restart and owner destruction; explicit stop cannot be undone by a late restore", () => {
  const x=store();x.prefs.patch({sharing:{enabled:true,origin:"https://one",sid:"s",mode:"on_turn",interval:60},screen:{proactive_enabled:true,proactive_interval:60}});
  const restarted=store(x.data());assert.equal(restarted.prefs.get().sharing.enabled,true);
  const web=id=>Object.assign(new EventEmitter(),{id,isDestroyed:()=>false,send(){}});
  const a=web(1),b=web(2);
  const sharing=createSharing({preferences:restarted.prefs,broadcast(){},cancel(){}});
  assert.equal(sharing.claim(a,"https://other"),false);
  assert.equal(sharing.claim(a,"https://one"),true);
  assert.equal(sharing.claim(b,"https://one"),false);
  sharing.stop();
  sharing.publish(a,{sid:"s",mode:"on_turn",restoring:true});
  assert.equal(sharing.active(),false);assert.equal(restarted.prefs.get().sharing.enabled,false);
  restarted.prefs.patch({sharing:{enabled:true}});
  assert.equal(sharing.claim(a,"https://one"),true);
  sharing.publish(a,{sid:"s",mode:"on_turn",restoring:true});
  a.emit("destroyed");
  assert.equal(sharing.active(),false);assert.equal(restarted.prefs.get().sharing.enabled,true);
  assert.equal(sharing.claim(b,"https://one"),true);
});
test("malformed device settings recover safe defaults while preserving valid legacy values",()=>{
  const x=store({devicePreferences:{version:1,revision:"bad",screen:{format:"jpeg",quality:NaN,max_edge:-1},volume:2.5,sharing:{enabled:true,sid:42,origin:[]}}});
  const p=x.prefs.get();assert.equal(p.screen.format,undefined);assert.equal(p.screen.max_edge,1920);assert.equal(p.screen.quality,undefined);assert.equal(p.volume,2.5);assert.equal(p.sharing.enabled,true);assert.equal(p.sharing.sid,"");assert.equal(p.sharing.origin,"");assert.equal(p.revision,0);
  x.prefs.migrate({origin:"https://one",activeId:"a",mates:[{id:"a",proactive:{enabled:true,interval:60}}]});
  assert.equal(x.prefs.get().screen.proactive_enabled,true);assert.equal(x.prefs.get().screen.proactive_interval,60);
});
