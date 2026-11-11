// Real native app, capture and isolated backend. Device preferences survive UI/process lifecycle.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{execFileSync}=require('child_process');
const {App,fill,until,sleep}=require('./screen-capture-e2e');
const [server,password,workspace,shots]=process.argv.slice(2);
const home=fs.mkdtempSync(path.join(os.tmpdir(),'geny-runtime-'));
let app;
const shot=async(p,n)=>{const r=await p.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shots,n+'.png'),Buffer.from(r.data,'base64'));};
const rootShot=n=>execFileSync('/tmp/hrh-test-venv/bin/python',['-c',`from PIL import ImageGrab;ImageGrab.grab().save(${JSON.stringify(path.join(shots,n+'.png'))})`]);
const click=(p,s)=>p.eval(`document.querySelector(${JSON.stringify(s)}).click(),true`);
const select=(p,s,v)=>p.eval(`(()=>{const e=document.querySelector(${JSON.stringify(s)});e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const launch=async()=>{
 app=new App(home,9680,10180);app.start();
 await until('native page',async()=>{const list=await app.targets();return list.some(t=>t.url.includes('connect.html')||t.url.startsWith(server));});
 if((await app.targets()).some(t=>t.url.includes('connect.html'))){const c=await app.page(/connect\.html/);await until('connect',()=>c.eval('!!window.hrhConnect'));await c.eval(fill(server,'admin',password));}
 const p=await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)(?!\\?surface=)'));
 await until('device bridge',()=>p.eval('!!window.hrhNative?.device'));return p;
};
(async()=>{try{
 let con=await launch();
 await con.eval("localStorage.setItem('hrh_lang','ko');localStorage.setItem('hrh_theme','dark');true");
 const mates=await con.eval("fetch('/api/mates').then(r=>r.json())"),mate=mates[0];
 const conv=await con.eval(`fetch('/api/mates/${mate.id}/conversation',{method:'POST'}).then(r=>r.json())`);
 // Old per-Mate OFF must not gate the device share.
 await con.eval(`fetch('/api/mates/${mate.id}',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({screen:{enabled:false}})})`);
 const sources=await con.eval('window.hrhNative.capture.sources()'),source=sources.find(s=>s.kind==='screen');assert.ok(source);
 await con.eval(`window.hrhNative.device.patch({screen:{source:${JSON.stringify(source)},format:'jpeg',max_edge:1280,proactive_enabled:false},sharing:{mode:'on_turn',interval:60}})`);
 await con.eval(`window.hrhNative.mate.setMate(${JSON.stringify(mate.id)}).then(()=>window.hrhNative.mate.showAvatar(${JSON.stringify(mate.id)})).then(()=>window.hrhNative.mate.openChat())`);
 let chat=await app.page(/surface=mate-chat/);
 // speaking first is this device's, set once: Settings → Mate (docs/settings.md)
 await con.eval("location.href='/?view=settings&tab=mate',true");
 await until('one reachout toggle',()=>con.eval("!!document.querySelector('[data-testid=proactive-enabled]')"));
 assert.equal(await con.eval("document.querySelectorAll('[data-testid=mate-proactive] button[role=switch], [data-testid=mate-proactive] input[type=checkbox]').length"),1);
 assert.equal(await con.eval("document.querySelectorAll('[data-testid=mate-proactive] textarea, [data-testid=mate-proactive] input[type=range], [data-testid=mate-proactive] input[type=number]').length"),0);
 await shot(con,'reachout-one-switch');
 // sharing itself starts from the message box (+ → Share screen)
 await con.eval("location.href='/?view=mate',true");await until('composer',()=>con.eval("!!document.querySelector('[data-testid=mate-attach]')"));
 await click(con,'[data-testid=mate-attach]');await until('share entry',()=>con.eval("!!document.querySelector('[data-testid=attach-share-screen]')"));
 await shot(con,'screen-one-switch-before');
 await click(con,'[data-testid=attach-share-screen]');await until('setup',()=>con.eval("!!document.querySelector('[data-testid=screen-start]')"));await click(con,'[data-testid=screen-start]');
 await until('source picker',()=>con.eval("!!document.querySelector('[data-testid=share-source]')"));await click(con,'[data-testid=share-source]');await click(con,'[data-testid=share-go]');
 await until('first ready',async()=>!!(await con.eval('window.hrhNative.capture.sharing.get()')).state);
 let hidden=await app.page(/surface=device-runtime/);assert.equal((await hidden.eval('window.hrhNative.capture.sharing.get()')).owner,true);assert.equal((await con.eval('window.hrhNative.capture.sharing.get()')).owner,false);
 assert.equal((await con.eval('window.hrhNative.device.get()')).sharing.mate_id,mate.id);
 await shot(con,'screen-one-switch-on');
 // The same component in two UI windows, changes immediately reach sole background owner.
 await until('chat input',()=>chat.eval("!!document.querySelector('[data-testid=mate-attach]')"));await click(chat,'[data-testid=mate-attach]');await click(chat,'[data-testid=attach-share-screen]');await until('chat setup',()=>chat.eval("!!document.querySelector('[data-testid=screen-setup]')"));
 await select(chat,'[data-testid=screen-mode]','ask');await until('running mode changed',async()=>(await con.eval('window.hrhNative.capture.sharing.get()')).state?.mode==='ask');
 await select(con,'[data-testid=device-capture-format]','png');await until('format synced',()=>chat.eval("document.querySelector('[data-testid=device-capture-format]').value==='png'"));
 await select(chat,'[data-testid=device-capture-size]','2560');await until('size synced',()=>con.eval("document.querySelector('[data-testid=device-capture-size]').value==='2560'"));
 await app.main("cwin().setBounds({x:0,y:0,width:1000,height:900});win('surface=mate-chat').setBounds({x:1010,y:0,width:850,height:900});return true");rootShot('two-windows-synchronized');
 // An actual MCP see_screen request works while the old per-Mate permission is OFF.
 await click(chat,'[data-testid=screen-apply]');
 await app.main("global.__captureVisibility=[];for(const w of BrowserWindow.getAllWindows())if(!w.webContents.getURL().includes('device-runtime'))for(const kind of ['show','hide','minimize','restore'])w.on(kind,()=>global.__captureVisibility.push(kind));return true");
 const ask=async()=>{await chat.eval("document.querySelector('[data-testid=mate-input]').focus(),true");await chat.send('Input.insertText',{text:'look at my screen'});await chat.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await chat.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});};
 await ask();let prompt=await app.page(/capture-ask\.html/,30000);await until('capture preview',()=>prompt.eval("!!document.querySelector('[data-testid=capture-ask-preview]')"));await shot(prompt,'request-approval-one-switch');
 await prompt.eval("setTimeout(()=>document.querySelector('[data-testid=capture-allow]').click(),50),true");
 await until('image reaches model through MCP',()=>chat.eval("document.body.innerText.includes('SEESCREEN listed=yes error=no images=1')"),90000);
 assert.deepEqual(await app.main('return global.__captureVisibility'),[],'capture must never hide/show any Geny window');
 await shot(chat,'screen-capture-real-attachment');
 console.log('PASS real native pixels reach MCP model and conversation with legacy permission OFF; capturing never hides/shows Geny windows');
 const identity=(await con.eval('window.hrhNative.device.context()')).deviceId;
 await app.stop();con=await launch();
 await until('process restart ready',async()=>!!(await con.eval('window.hrhNative.capture.sharing.get()')).state);hidden=await app.page(/surface=device-runtime/);
 assert.equal((await con.eval('window.hrhNative.device.context()')).deviceId,identity);
 let prefs=await con.eval('window.hrhNative.device.get()');assert.equal(prefs.screen.max_edge,2560);assert.equal(prefs.screen.format,'png');assert.equal(prefs.sharing.mode,'ask');
 await con.send('Page.reload');await until('reload bridge',()=>con.eval('!!window.hrhNative?.device'));await until('reload still ready',async()=>!!(await con.eval('window.hrhNative.capture.sharing.get()')).state);
 console.log('PASS actual start UI has one switch; two-way quality/mode sync; app restart/reload resumes and stable device identity persists');
 // Close every visible app window. Background connection remains the actual share owner.
 await app.main("setTimeout(()=>{for(const w of BrowserWindow.getAllWindows())if(!w.webContents.getURL().includes('surface=device-runtime')&&!w.isDestroyed())w.destroy();},50);return true");await sleep(400);console.log('all user windows closed');
 console.log('remaining windows',await app.main("return BrowserWindow.getAllWindows().map(w=>({id:w.id,url:w.webContents.getURL(),visible:w.isVisible()}))"));
 app.pages.delete(String(/surface=device-runtime/));hidden=await app.page(/surface=device-runtime/);console.log('hidden JS alive',await hidden.eval('1+1'));
 assert.equal((await hidden.eval('window.hrhNative.capture.sharing.get()')).owner,true);console.log('hidden IPC alive');
 const health=await hidden.eval(`fetch('/api/sessions/${conv.session_id}').then(r=>r.status)`);assert.equal(health,200);
 await hidden.eval("window.hrhNative.device.patch({screen:{source:{id:'window:missing:0',name:'MISSING',kind:'window'}}})");
 await until('source waiting retains ON',async()=>{const s=await hidden.eval('window.hrhNative.capture.sharing.get()');return s.status==='waiting_target'&&!s.state&&s.enabled;});
 assert.equal((await hidden.eval('window.hrhNative.device.get()')).sharing.enabled,true);
 await shot(hidden,'background-waiting-source');
 await hidden.eval(`window.hrhNative.device.patch({screen:{source:${JSON.stringify(source)}}})`);
 await until('target returns automatic resume',async()=>!!(await hidden.eval('window.hrhNative.capture.sharing.get()')).state);
 console.log('PASS no visible UI needed; unavailable source pauses with saved ON; selecting source resumes without toggling OFF/ON');
 // Lifecycle events: ON once, startup once; off clears pending. No expensive real model in isolated app.
 await hidden.eval(`window.hrhNative.device.patch({screen:{proactive_enabled:true,proactive_mate:${JSON.stringify(mate.id)}}})`);
 await until('native lifecycle delivered',()=>hidden.eval("window.hrhNative.device.events('"+mate.id+"').then(x=>x.length===0)"));await sleep(1000);
 const dbFile=process.env.SCREEN_TEST_ROOT+'/db.sqlite';
 const dbQuery=sql=>JSON.parse(execFileSync('/tmp/hrh-test-venv/bin/python',['-c',`import sqlite3,json; c=sqlite3.connect(${JSON.stringify(dbFile)});print(json.dumps(c.execute(${JSON.stringify(sql)}).fetchall()))`],{encoding:'utf8'}));
 let rows=dbQuery('SELECT kind,status FROM device_events');assert.ok(rows.some(r=>r[0]==='startup'&&r[1]==='delivered'));assert.ok(rows.some(r=>r[0]==='enabled'&&r[1]==='delivered'));
 await hidden.send('Page.reload');await until('runtime reloaded',()=>hidden.eval('!!window.hrhNative?.device'));await sleep(1200);
 assert.equal(dbQuery("SELECT COUNT(*) FROM device_events WHERE kind='startup'")[0][0],1);
 // Login autostart creates the controller even without opening the console.
 await app.stop();app=new App(home,9680,10180);app.start(['--hidden']);hidden=await app.page(/surface=device-runtime/);
 await until('hidden autostart restored sharing',async()=>!!(await hidden.eval('window.hrhNative.capture.sharing.get()')).state);
 await until('second boot event',()=>dbQuery("SELECT COUNT(*) FROM device_events WHERE kind='startup' AND status='delivered'")[0][0]===2);
 assert.equal(await app.main("return BrowserWindow.getAllWindows().some(w=>!w.webContents.getURL().includes('surface=')&&!w.webContents.getURL().includes('bar.html'))"),false);
 console.log('PASS --hidden login autostart resumes capture and greets once without opening console');
 await hidden.eval('window.hrhNative.device.patch({screen:{proactive_enabled:false}})');
 await hidden.eval('window.hrhNative.capture.sharing.stop()');await until('saved off',async()=>!(await hidden.eval('window.hrhNative.device.get()')).sharing.enabled);await app.stop();con=await launch();await sleep(1000);
 assert.equal((await con.eval('window.hrhNative.device.get()')).sharing.enabled,false);assert.equal((await con.eval('window.hrhNative.capture.sharing.get()')).state,null);
 await shot(con,'off-after-restart');
 console.log('PASS lifecycle ON/startup dedupe, runtime reload does not greet twice; explicit Stop stays OFF after restart');
 console.log('DEVICE RUNTIME E2E OK');
}finally{if(process.exitCode)console.log(app?.out?.slice(-2000));await app?.stop();}})().catch(e=>{console.error(e);process.exitCode=1;});
