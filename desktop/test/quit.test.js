const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createQuitController,QUIT_DEADLINE_MS}=require('../src/quit');
function fixture({failPrepare=false}={}){
 const app=new EventEmitter(),calls=[],timers=[];
 app.quit=()=>calls.push('quit');app.exit=code=>calls.push(['exit',code]);
 const wc=new EventEmitter(),win={webContents:wc,isDestroyed:()=>false,destroy:()=>calls.push('destroy')};
 const controller=createQuitController({app,windows:()=>[win],prepare:o=>{calls.push(['prepare',o]);if(failPrepare)throw Error('cleanup failed');},log:s=>calls.push(s),setTimeout:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clearTimeout:t=>{if(t)t.cleared=true;}});
 controller.bindWindow(win);return {app,calls,timers,wc,controller};
}
test('Quit prepares once, marks terminal state before cleanup, and is idempotent across duplicate clicks',()=>{
 const f=fixture();assert.equal(f.controller.request('tray'),true);assert.equal(f.controller.request('tray'),false);
 f.controller.beforeQuit();assert.equal(f.controller.isQuitting(),true);assert.equal(f.controller.isExplicit(),true);
 assert.equal(f.calls.filter(x=>x==='quit').length,1);assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='prepare').length,1);
 assert.equal(f.timers[0].ms,QUIT_DEADLINE_MS);
});
test('normal window close preserves unload veto; app Quit bypasses it',()=>{
 const f=fixture();let cancelled=0;const e={preventDefault:()=>cancelled++};
 f.wc.emit('will-prevent-unload',e);assert.equal(cancelled,0);
 f.controller.request();f.wc.emit('will-prevent-unload',e);assert.equal(cancelled,1);
});
test('an unresponsive renderer is destroyed at the deadline; cleanup errors cannot skip fallback',()=>{
 const f=fixture({failPrepare:true});f.controller.request();f.timers[0].fn();
 assert.ok(f.calls.includes('destroy'));assert.deepEqual(f.calls.at(-1),['exit',0]);
});
test('normal quit cancels the deadline and update-driven quit keeps the update intent',()=>{
 const f=fixture();f.controller.beforeQuit(true);assert.equal(f.controller.isExplicit(),false);
 assert.deepEqual(f.calls.find(x=>Array.isArray(x)&&x[0]==='prepare'),['prepare',{update:true}]);
 f.app.emit('quit');assert.equal(f.timers[0].cleared,true);
});
