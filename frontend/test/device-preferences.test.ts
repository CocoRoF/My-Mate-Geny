import {test} from 'node:test';
import assert from 'node:assert/strict';
Object.defineProperty(globalThis,'BroadcastChannel',{value:undefined,configurable:true});
const data=new Map<string,string>();
Object.assign(globalThis,{window:new EventTarget(),localStorage:{getItem:(k:string)=>data.get(k)||null,setItem:(k:string,v:string)=>data.set(k,v)},location:{origin:'https://device-test'}});
const prefs=await import('../src/stores/devicePreferences.ts');
test('broken local JSON recovers safely; valid partial settings survive normalization',async()=>{
 data.set('hrh_device_preferences_v1','broken JSON');
 const p=await prefs.loadDevicePreferences();assert.equal(p.sharing.enabled,false);assert.equal(p.screen.approval,'ask');
 data.set('hrh_device_preferences_v1',JSON.stringify({version:1,screen:{format:'jpeg',max_edge:-1},volume:2.75,sharing:{enabled:true,origin:'https://device-test',sid:'s',mode:'invalid'}}));
 const q=await prefs.loadDevicePreferences();assert.equal(q.screen.format,'jpeg');assert.equal(q.screen.max_edge,1920);assert.equal(q.volume,2.75);assert.equal(q.sharing.mode,'ask');
});
test('browser intent and settings persist locally, stop survives reload, and active legacy mate is migrated once',async()=>{
 await prefs.patchDevicePreferences({sharing:{enabled:true,origin:'https://device-test',sid:'s',mode:'on_turn',interval:60},screen:{proactive_enabled:true,proactive_interval:60}});
 assert.equal((await prefs.loadDevicePreferences()).sharing.enabled,true);
 assert.equal(prefs.devicePreferences().sharing.mode,'on_turn');
 await prefs.patchDevicePreferences({sharing:{enabled:false}});
 assert.equal((await prefs.loadDevicePreferences()).sharing.enabled,false);
 assert.equal(prefs.devicePreferences().volume,2.75);
 await prefs.migrateDevicePreferences([{id:'m',voice:{volume:1},prefs:{proactive:{enabled:false,interval:300}}}],'m');
 assert.equal(prefs.devicePreferences().screen.proactive_enabled,true,'explicit device policy wins');
});
