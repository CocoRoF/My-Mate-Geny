import {test} from 'node:test';
import assert from 'node:assert/strict';
const intervals=new Map<object,{fn:()=>void;ms:number}>();
globalThis.setInterval=((fn:()=>void,ms:number)=>{const id={unref(){}};intervals.set(id,{fn,ms});return id;}) as any;
globalThis.clearInterval=((id:object)=>{intervals.delete(id);}) as any;
Object.defineProperty(globalThis,'BroadcastChannel',{value:undefined,configurable:true});
const win=new EventTarget() as any;
let changed:(s:any)=>void=()=>{};
win.hrhNative={capture:{version:3,resume:1,request:async()=>({ok:false}),cancel:async()=>{},setChoice:async()=>true,sharing:{
  get:async()=>({revision:0,owner:false,state:null}),publish:async()=>{},stop:async()=>{},mode:async()=>{},
  onChanged:(f:any)=>{changed=f;},onControl:()=>{}
}}};
const storage=new Map<string,string>();
Object.assign(globalThis,{window:win,location:{origin:"https://test"},localStorage:{getItem:(k:string)=>storage.get(k)||null,setItem:(k:string,v:string)=>storage.set(k,v)}});
const screen=await import('../src/mate/localScreen.ts');
await Promise.resolve();
test('late IPC release snapshot cannot permanently stop the new authoritative owner timer',async()=>{
  screen.configureProactive('s',true,60);
  await screen.beginSharing('s','Mate',{id:'screen:1:0',kind:'screen',name:'Screen'});
  assert.ok([...intervals.values()].some(t=>t.ms===60000));
  changed({revision:1,owner:false,state:null});
  assert.equal([...intervals.values()].filter(t=>t.ms===60000).length,0);
  const state={sid:'s',name:'Mate',source:'Screen',kind:'screen',mode:'ask',interval:180,error:'',capturing:false};
  changed({revision:2,owner:true,state});
  const timer=[...intervals].find(([,t])=>t.ms===60000)![0];
  assert.ok(timer);
  changed({revision:3,owner:true,state:{...state,capturing:true}});
  assert.ok(intervals.has(timer),'capture status update must not postpone the next observation');
  screen.stopSharing();
  assert.ok(!intervals.has(timer));
});

test('store policy events update a sharing owner without a mounted composer and do not postpone unchanged timers',async()=>{
  await screen.beginSharing('s2','Mate',{id:'screen:1:0',kind:'screen',name:'Screen'});
  const policy=(enabled:boolean,interval:number)=>win.dispatchEvent(new CustomEvent('hrh:mate-policies',{detail:[{sid:'s2',enabled,interval}]}));
  policy(true,60);
  const timer=[...intervals].find(([,t])=>t.ms===60000)![0];
  assert.ok(timer);
  policy(true,60);
  assert.ok(intervals.has(timer));
  policy(true,180);
  assert.ok(!intervals.has(timer));
  assert.ok([...intervals.values()].some(t=>t.ms===180000));
  policy(false,180);
  assert.ok(![...intervals.values()].some(t=>t.ms===180000));
  assert.deepEqual(screen.sharedScopes(),{s2:'on_turn'});
  screen.stopSharing();
});

test('a share is always "with each message": an older saved mode changes nothing',async()=>{
 const prefs=await import('../src/stores/devicePreferences.ts');
 await screen.beginSharing('sync','Mate',{id:'screen:1:0',kind:'screen',name:'Screen'});
 assert.equal(prefs.devicePreferences().sharing.mode,'on_turn');
 await prefs.patchDevicePreferences({sharing:{mode:'observe',interval:300}});
 assert.equal(screen.sharingSnapshot()?.mode,'on_turn');
 assert.deepEqual(screen.sharedScopes(),{sync:'on_turn'});
 assert.equal([...intervals.values()].filter(t=>t.ms===300000).length,0,'no periodic observation');
 screen.stopSharing();
});

test('changing the saved conversation releases its old grant without turning sharing OFF',async()=>{
 const prefs=await import('../src/stores/devicePreferences.ts');
 await screen.beginSharing('previous','Mate',{id:'screen:1:0',kind:'screen',name:'Screen'});
 assert.deepEqual(screen.sharedScopes(),{previous:'on_turn'});
 await prefs.patchDevicePreferences({sharing:{sid:'recreated'}});
 assert.deepEqual(screen.sharedScopes(),{});
 assert.equal(prefs.devicePreferences().sharing.enabled,true);
 assert.equal(prefs.devicePreferences().sharing.sid,'recreated');
 screen.stopSharing();
});
