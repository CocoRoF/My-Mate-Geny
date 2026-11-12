const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createDeviceLifecycle,createRuntimeWindow}=require('../src/device-runtime');
const {createDevicePreferences}=require('../src/device-preferences');
const {createSharing}=require('../src/capture-sharing');
function storage(seed={}){let data=seed;return {readSettings:()=>data,writeSettings:p=>data={...data,...p}};}
test('stable device identity, unique process boot and startup outbox once per origin even after acknowledgement',()=>{
 const disk=storage(),a=createDeviceLifecycle({...disk,autostart:true}),one=a.info();
 assert.match(one.deviceId,/^dev_[a-f0-9]{32}$/);assert.equal(one.startReason,'autostart');
 a.add('startup','https://one','m');a.add('startup','https://one','m');
 assert.equal(a.pending('https://one').length,1);
 const event=a.pending('https://one')[0];a.ack('https://other',[event.id]);assert.equal(a.pending('https://one').length,1);
 a.ack('https://one',[event.id]);a.add('startup','https://one','m');assert.equal(a.pending('https://one').length,0);
 a.add('enabled','https://one','m');assert.equal(a.pending('https://one').length,1);
 const b=createDeviceLifecycle(disk);assert.equal(b.info().deviceId,one.deviceId);assert.notEqual(b.info().bootId,one.bootId);
 b.add('startup','https://one','m');assert.equal(b.pending('https://one').length,2);
});
test('background runtime does not open UI, survives no user windows and does not recreate after shutdown',()=>{
 const made=[];
 class Win extends EventEmitter {constructor(options){super();this.options=options;this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};this.webContents.getURL=()=>this.url;made.push(this);}isDestroyed(){return !!this.dead;}loadURL(url){this.url=url;return Promise.resolve();}destroy(){this.dead=true;this.emit('closed');}}
 const runtime=createRuntimeWindow({BrowserWindow:Win,preload:'/preload',version:'x',serverUrl:()=> 'https://one',allowed:()=>true});
 runtime.ensure();runtime.ensure();assert.equal(made.length,1);assert.equal(made[0].options.show,false);assert.equal(made[0].options.webPreferences.backgroundThrottling,false);assert.equal(made[0].options.webPreferences.autoplayPolicy,'no-user-gesture-required');assert.match(made[0].url,/surface=device-runtime/);
 made[0].destroy();runtime.ensure();assert.equal(made.length,2);
 runtime.destroy();runtime.ensure();assert.equal(made.length,2);
 // a new connection (Local execution's own origin, a server after a sign-out) starts it again: start, not ensure
 let base='https://one';
 const again=createRuntimeWindow({BrowserWindow:Win,preload:'/preload',version:'x',serverUrl:()=>base,allowed:()=>true});
 again.ensure();again.destroy();base='http://127.0.0.1:5000';again.ensure();assert.equal(made.length,3,'stopped: ensure alone does nothing');
 again.start();assert.equal(made.length,4);assert.equal(made[3].url,'http://127.0.0.1:5000/?surface=device-runtime');
});
test('permission, source, transport and owner loss pause runtime while only explicit Stop persists OFF',()=>{
 const disk=storage(),prefs=createDevicePreferences(disk);prefs.patch({sharing:{enabled:true,origin:'https://one',sid:'s',mate_id:'m'}});
 const sender=Object.assign(new EventEmitter(),{id:1,isDestroyed:()=>false,send(){}});
 let stops=0;const controller=createSharing({preferences:prefs,broadcast(){},cancel(){stops++;}});
 for(const reason of ['waiting_permission','waiting_target','waiting_connection','waiting_auth','waiting_session']){
  assert.equal(controller.claim(sender,'https://one'),true);controller.publish(sender,{sid:'s',mode:'ask',restoring:true});assert.equal(controller.active(),true);
  controller.pause(reason);assert.equal(controller.snapshot(sender).status,reason);assert.equal(prefs.get().sharing.enabled,true);
 }
 const restarted=createDevicePreferences(disk);assert.equal(restarted.get().sharing.mate_id,'m');assert.equal(restarted.get().sharing.enabled,true);
 controller.stop();assert.equal(prefs.get().sharing.enabled,false);assert.equal(controller.snapshot(sender).status,'off');assert.ok(stops>=6);
});
test('corrupt target is marked unavailable without silently selecting primary or losing enabled intent',()=>{
 const disk=storage({devicePreferences:{version:1,screen:{source:{id:42}},sharing:{enabled:true,origin:'https://one',sid:'s'}}});
 const prefs=createDevicePreferences(disk);assert.equal(prefs.get().sharing.enabled,true);assert.equal(prefs.get().screen.source_invalid,true);
 assert.equal(createDevicePreferences(disk).get().screen.source_invalid,true);
 prefs.patch({screen:{source:{id:'screen:2',name:'Screen 2'}}});assert.equal(prefs.get().screen.source_invalid,false);
});
test('failed persistence cannot publish a successful device-settings revision',()=>{
 let data={},fail=false,published=0;
 const prefs=createDevicePreferences({readSettings:()=>data,writeSettings:p=>{if(fail)throw new Error('disk unavailable');data={...data,...p};},changed:()=>published++});
 prefs.patch({sharing:{enabled:true,origin:'https://one',sid:'s'}});
 fail=true;assert.throws(()=>prefs.patch({sharing:{enabled:false}}),/disk unavailable/);
 assert.equal(prefs.get().sharing.enabled,true);assert.equal(published,1);
});
test('an in-flight restore cannot publish a stale conversation or server binding',()=>{
 const disk=storage(),prefs=createDevicePreferences(disk);
 prefs.patch({sharing:{enabled:true,origin:'https://one',sid:'old'}});
 const sender=Object.assign(new EventEmitter(),{id:1,isDestroyed:()=>false,send(){}});
 const control=createSharing({preferences:prefs,broadcast(){},cancel(){}});
 assert.equal(control.claim(sender,'https://one'),true);assert.equal(control.pending(),true);
 prefs.patch({sharing:{sid:'new'}});
 assert.equal(control.publish(sender,{sid:'old',mode:'ask',restoring:true}).state,null);
 assert.equal(prefs.get().sharing.enabled,true);
 prefs.patch({sharing:{origin:'https://two'}});
 assert.equal(control.publish(sender,{sid:'new',mode:'ask',restoring:true}).state,null);
 control.pause('waiting_session');assert.equal(control.pending(),false);
 assert.equal(control.claim(sender,'https://two'),true);
 assert.equal(control.publish(sender,{sid:'new',mode:'ask',restoring:true}).state.sid,'new');
});
