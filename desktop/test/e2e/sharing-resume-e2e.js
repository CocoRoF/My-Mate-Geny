// Actual Electron/X11 lifecycle and isolated server. No fake capture bridge.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {App,fill,until,sleep}=require('./screen-capture-e2e');
const [server,password,workspace,shots]=process.argv.slice(2);
const home=fs.mkdtempSync(path.join(os.tmpdir(),'geny-resume-'));
let app;
const shot=async(p,n)=>{const r=await p.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shots,n+'.png'),Buffer.from(r.data,'base64'));};
const launch=async()=>{
 app=new App(home,9680,10180);app.start();
 await until('native page',async()=>{const list=await app.targets();return list.some(t=>t.url.includes('connect.html')||t.url.startsWith(server));});
 if((await app.targets()).some(t=>t.url.includes('connect.html'))){const c=await app.page(/connect\.html/);await until('connect',()=>c.eval('!!window.hrhConnect'));await c.eval(fill(server,'admin',password));}
 const p=await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)(?!\\?surface=)'));
 await until('device bridge',()=>p.eval('!!window.hrhNative?.device'));
 await sleep(400);return p;
};
(async()=>{try{
 let page=await launch();
 await page.eval("localStorage.setItem('hrh_lang','ko');window.dispatchEvent(new StorageEvent('storage',{key:'hrh_lang',newValue:'ko'}));true");
 const mates=await page.eval("fetch('/api/mates').then(r=>r.json())");
 const conv=await page.eval(`fetch('/api/mates/${mates[0].id}/conversation',{method:'POST'}).then(r=>r.json())`);
 const sources=await page.eval('window.hrhNative.capture.sources()');const source=sources.find(s=>s.kind==='screen');assert.ok(source);
 // Use the actual Start UI, then restart the whole app against the same native userData.
 await page.eval(`window.hrhNative.device.patch({screen:{source:${JSON.stringify(source)},format:'jpeg',max_edge:1280,proactive_enabled:false,proactive_interval:60},sharing:{interval:60}})`);
 await page.eval(`window.hrhNative.mate.setMate(${JSON.stringify(mates[0].id)}).then(()=>window.hrhNative.mate.showAvatar(${JSON.stringify(mates[0].id)})).then(()=>window.hrhNative.mate.openChat())`);
 const firstChat=await app.page(/surface=mate-chat/);
 await app.main("win('surface=mate-overlay').setBounds({x:180,y:60,width:220,height:320});return true");
 require('child_process').execFileSync('xdotool',['mousemove','280','220']);
 const bar=await app.page(/bar\.html/);
 await until("toolbar ready",()=>bar.eval("!!document.querySelector('[data-act=screen]')"));
 await until("chat composer ready",()=>firstChat.eval("!!document.querySelector('[data-testid=mate-input]')"));
 await bar.eval("document.querySelector('[data-act=screen]').click(),true");
 await until('start setup',()=>firstChat.eval("!!document.querySelector('[data-testid=screen-mode]')"));
 await firstChat.eval("(()=>{const s=document.querySelector('[data-testid=screen-mode]');s.value='on_turn';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
 await shot(firstChat,'saved-start-settings');
 await firstChat.eval("document.querySelector('[data-testid=screen-start]').click(),true");
 await until('source picker',()=>firstChat.eval("!!document.querySelector('[data-testid=share-source]')"));
 await firstChat.eval("document.querySelector('[data-testid=share-source]').click();document.querySelector('[data-testid=share-go]').click();true");
 await until('first resume',async()=>!!(await page.eval('window.hrhNative.capture.sharing.get()')).state);
 await shot(page,'enabled-before-restart');await app.stop();
 page=await launch();await until('restart automatic resume',async()=>!!(await page.eval('window.hrhNative.capture.sharing.get()')).state);
 const state=await page.eval('window.hrhNative.capture.sharing.get()');assert.equal(state.state.sid,conv.session_id);assert.equal(state.state.mode,'on_turn');assert.equal(state.state.interval,60);
 assert.equal(await page.eval("document.querySelectorAll('[data-testid=screen-setup],[data-testid=local-screen-controls],[data-testid=screen-sharing-banner]').length"),0);
 const settings=await page.eval('window.hrhNative.device.get()');assert.equal(settings.screen.format,'jpeg');assert.equal(settings.screen.max_edge,1280);assert.equal(settings.screen.proactive_interval,60);
 await app.main("win('surface=mate-overlay')?.setBounds({x:180,y:60,width:220,height:320});return true");require('child_process').execFileSync('xdotool',['mousemove','280','220']);
 const restoredBar=await app.page(/bar\.html/);await until('toolbar restored active',()=>restoredBar.eval("document.querySelector('[data-act=screen]')?.classList.contains('sharing')"));await shot(restoredBar,'toolbar-after-restart');
 await shot(page,'enabled-after-restart');console.log('PASS actual app restart restores source, owner, mode and device quality without a dialog');
 await page.send('Page.reload');await until('reload bridge',()=>page.eval('!!window.hrhNative?.capture'));await until('reload auto resume',async()=>!!(await page.eval('window.hrhNative.capture.sharing.get()')).state);await shot(page,'enabled-after-reload');
 await page.eval('window.hrhNative.capture.sharing.stop()');await until('saved off',async()=>!(await page.eval('window.hrhNative.device.get()')).sharing.enabled);await app.stop();
 page=await launch();await sleep(900);assert.equal((await page.eval('window.hrhNative.capture.sharing.get()')).state,null);await shot(page,'disabled-after-restart');console.log('PASS explicit stop survives restart; reload resumes without reopening setup');
 await page.eval(`window.hrhNative.device.patch({screen:{source:{id:'window:missing:0',kind:'window',name:'REMOVED SOURCE'}},sharing:{enabled:true}})`);
 await until('missing source safely off',async()=>!(await page.eval('window.hrhNative.device.get()')).sharing.enabled);assert.equal((await page.eval('window.hrhNative.capture.sharing.get()')).state,null);await shot(page,'missing-source-stopped');
 console.log('PASS missing source switches persistent intent off, never substitutes another screen');
 // Opening several renderer windows must never create multiple owners.
 await page.eval(`window.hrhNative.device.patch({screen:{source:${JSON.stringify(source)}},sharing:{enabled:true}})`);
 await until('sharing ready',async()=>!!(await page.eval('window.hrhNative.capture.sharing.get()')).state);
 await page.eval(`window.hrhNative.mate.showAvatar(${JSON.stringify(mates[0].id)}).then(()=>window.hrhNative.mate.openChat())`);
 const chat=await app.page(/surface=mate-chat/);const overlay=await app.page(/surface=mate-overlay/);
 await until('one restored owner after opening windows',async()=>{const owners=await Promise.all([page,chat,overlay].map(p=>p.eval('window.hrhNative.capture.sharing.get().then(s=>Number(s.owner))')));return owners.reduce((a,b)=>a+b,0)===1;});
 await chat.eval('window.hrhNative.capture.sharing.stop()');await until('stop all windows',async()=>!(await page.eval('window.hrhNative.device.get()')).sharing.enabled);console.log('PASS one owner across console/chat/avatar and stop from any window persists');
 // Stop from the toolbar while restore is waiting for the server; a late response must not re-enable it.
 await app.main("win('surface=mate-chat')?.destroy();return true");
 await page.eval("window.__originalFetch=window.fetch;window.fetch=(url,...args)=>String(url).startsWith('/api/sessions/') ? new Promise(resolve=>{window.__releaseRestore=()=>window.__originalFetch(url,...args).then(resolve)}) : window.__originalFetch(url,...args);true");
 await page.eval("window.hrhNative.device.patch({sharing:{enabled:true}})");
 await until('restore waiting',()=>page.eval("typeof window.__releaseRestore==='function'"));
 require('child_process').execFileSync('xdotool',['mousemove','280','220']);
 const pendingBar=await app.page(/bar\.html/);await until('pending toolbar active',()=>pendingBar.eval("document.querySelector('[data-act=screen]')?.classList.contains('sharing')"));
 await pendingBar.eval("document.querySelector('[data-act=screen]').click(),true");
 await until('pending intent stopped',async()=>!(await page.eval('window.hrhNative.device.get()')).sharing.enabled);
 await page.eval("window.__releaseRestore();window.fetch=window.__originalFetch;true");await sleep(500);
 assert.equal((await page.eval('window.hrhNative.capture.sharing.get()')).state,null);assert.equal((await page.eval('window.hrhNative.device.get()')).sharing.enabled,false);
 console.log('PASS toolbar cancels pending restore; late response cannot restart sharing');
 console.log('SHARING RESUME E2E OK');
}finally{await app?.stop();}})().catch(e=>{console.error(e);process.exitCode=1;});
