// Actual Electron/X11, native IPC and isolated API. UI before/after, live two-window synchronization.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{execFileSync}=require('child_process');
const {App,fill,until,sleep}=require('../../../desktop/test/e2e/screen-capture-e2e');
const [server,password,workspace,shots]=process.argv.slice(2),before=process.env.SETTINGS_BEFORE==='1';
const app=new App(fs.mkdtempSync(path.join(os.tmpdir(),'geny-settings-')),9690,10190);
const click=(p,s)=>p.eval(`document.querySelector(${JSON.stringify(s)}).click(),true`);
const select=(p,s,v)=>p.eval(`(()=>{const e=document.querySelector(${JSON.stringify(s)});e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const value=(p,s)=>p.eval(`document.querySelector(${JSON.stringify(s)})?.value`);
const shot=async(p,name)=>{const r=await p.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shots,name+'.png'),Buffer.from(r.data,'base64'));};
const rootShot=name=>execFileSync('/tmp/hrh-test-venv/bin/python',['-c',`from PIL import ImageGrab;ImageGrab.grab().save(${JSON.stringify(path.join(shots,name+'.png'))})`]);
(async()=>{try{
 app.start();const login=await app.page(/connect\.html/);await until('connect',()=>login.eval('!!window.hrhConnect'));await login.eval(fill(server,'admin',password));
 const con=await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)(?!\\?surface=)'));
 const mates=await con.eval("fetch('/api/mates').then(r=>r.json())"),mate=mates[0];
 await con.eval("localStorage.setItem('hrh_lang','ko');localStorage.setItem('hrh_theme','dark');localStorage.setItem('hrh_theme_device','1');true");
 await con.eval(`window.hrhNative.mate.setMate(${JSON.stringify(mate.id)}).then(()=>window.hrhNative.mate.showAvatar(${JSON.stringify(mate.id)})).then(()=>window.hrhNative.mate.openChat())`);
 const chat=await app.page(/surface=mate-chat/);
 await con.eval("location.href='/?view=mate',true");await until('settings',()=>con.eval("!!document.querySelector('[data-testid=mate-settings-open]')"));await click(con,'[data-testid=mate-settings-open]');await until('proactive tab',()=>con.eval("!!document.querySelector('[data-testid=mate-tab-proactive]')"));await click(con,'[data-testid=mate-tab-proactive]');
 await until('rules',()=>con.eval("document.querySelectorAll('details textarea').length>0"));
 let preservedPrompts;
 if(!before){
  preservedPrompts=await con.eval(`(async()=>{const preset=await fetch('/api/sessions/screen/geny-preset').then(r=>r.json());const prompt=preset.prompts.find(p=>p.id==='first_idle__1');prompt.content={en:'USER-KEPT: please ask about my unfinished drawing.',ko:'사용자 문구 보존 확인: 아직 그리던 그림에 대해 물어봐.'};await fetch('/api/mates/${mate.id}',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefs:{proactive:{preset}}})});return preset.prompts;})()`);
  await until('custom prompt loaded',()=>con.eval("[...document.querySelectorAll('details textarea')].some(e=>e.value.includes('사용자 문구 보존 확인'))"));
 }

 await con.eval("(()=>{const e=document.querySelector('[data-testid=trigger-category-first_idle]')||[...document.querySelectorAll('details')].find(e=>e.textContent.includes('첫 침묵'));e.open=true;e.scrollIntoView();return true})()");
 await shot(con,before?'before-rules':'after-rules');
 if(!before){
  assert.equal(await con.eval("document.body.innerText.includes('기본 규칙으로 되돌리기')||document.body.innerText.includes('기본값으로 되돌리기')"),false);
  const slider='[data-testid=trigger-weight-first_idle]';
  await con.eval(`(()=>{const e=document.querySelector(${JSON.stringify(slider)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'123.25');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  assert.equal(await con.eval("document.querySelector('[data-testid=trigger-save-state]').innerText.includes('미리보기')"),true);
  await con.eval(`document.querySelector(${JSON.stringify(slider)}).dispatchEvent(new PointerEvent('pointerup',{bubbles:true})),true`);
  await until('slider saved',()=>con.eval(`fetch('/api/mates/${mate.id}').then(r=>r.json()).then(m=>m.prefs.proactive.preset.categories.find(c=>c.id==='first_idle').weight===123.25)`));
  const sliderBox=await con.eval(`(()=>{const r=document.querySelector(${JSON.stringify(slider)}).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
  const mx=sliderBox.x+sliderBox.w*.7,my=sliderBox.y+sliderBox.h/2;
  await con.send('Input.dispatchMouseEvent',{type:'mousePressed',x:mx,y:my,button:'left',clickCount:1});
  await con.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:mx+10,y:my,buttons:1});
  assert.equal(await con.eval(`fetch('/api/mates/${mate.id}').then(r=>r.json()).then(m=>m.prefs.proactive.preset.categories.find(c=>c.id==='first_idle').weight)`),123.25,'drag is only preview before release');
  await con.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:mx+10,y:my,button:'left',clickCount:1});
  await until('mouse release saved',()=>con.eval(`fetch('/api/mates/${mate.id}').then(r=>r.json()).then(m=>m.prefs.proactive.preset.categories.find(c=>c.id==='first_idle').weight>500)`));
  const beforeKey=Number(await value(con,slider));
  await con.eval(`document.querySelector(${JSON.stringify(slider)}).focus(),true`);
  await con.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  await con.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  await until('keyboard slider saved',()=>con.eval(`fetch('/api/mates/${mate.id}').then(r=>r.json()).then(m=>m.prefs.proactive.preset.categories.find(c=>c.id==='first_idle').weight>${beforeKey})`));
  await con.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36});
  await con.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36});
  await until('Home disables situation',()=>con.eval(`fetch('/api/mates/${mate.id}').then(r=>r.json()).then(m=>m.prefs.proactive.preset.categories.find(c=>c.id==='first_idle').weight===0)`));
  await click(con,'[data-testid=trigger-cooldown-first_idle-60]');
  await until('cooldown saved',()=>con.eval(`fetch('/api/mates/${mate.id}').then(r=>r.json()).then(m=>m.prefs.proactive.preset.categories.find(c=>c.id==='first_idle').cooldown_seconds===60)`));
  const prompts=await con.eval(`fetch('/api/mates/${mate.id}').then(r=>r.json()).then(m=>m.prefs.proactive.preset.prompts.filter(p=>p.id.startsWith('first_idle')).map(p=>p.content.en))`);assert.ok(prompts[0].startsWith('A brief silence has settled'));
  assert.deepEqual(await con.eval(`fetch('/api/mates/${mate.id}').then(r=>r.json()).then(m=>m.prefs.proactive.preset.prompts)`),preservedPrompts);
  await con.eval("(()=>{for(const [id,v] of [['first_idle','100'],['continued_idle','333.25']]){const e=document.querySelector('[data-testid=trigger-weight-'+id+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));}return true})()");
  await until('rapid multi-field saves retained',()=>con.eval(`fetch('/api/mates/${mate.id}').then(r=>r.json()).then(m=>{const c=m.prefs.proactive.preset.categories;return c.find(x=>x.id==='first_idle').weight===100 && c.find(x=>x.id==='continued_idle').weight===333.25})`));
  assert.deepEqual(await con.eval(`fetch('/api/mates/${mate.id}').then(r=>r.json()).then(m=>m.prefs.proactive.preset.prompts)`),preservedPrompts);
  await shot(con,'after-weight-preview-saved');
  console.log('PASS slider preview → release save, decimal weights retained, cooldown preset saved, English seed prompts untouched, reset button absent');
 }
 const xid=await app.main("return cwin().getNativeWindowHandle().readUInt32LE(0)");execFileSync('xprop',['-id',String(xid),'-f','WM_STATE','32c','-set','WM_STATE','1']);
 await click(con,'[data-testid=mate-tab-screen]');await until('device settings',()=>con.eval("!!document.querySelector('[data-testid=device-capture-size]')"));
 await until('chat composer',()=>chat.eval("!!document.querySelector('[data-testid=mate-attach]')"));await click(chat,'[data-testid=mate-attach]');await click(chat,'[data-testid=attach-share-screen]');await until('start settings',()=>chat.eval("!!document.querySelector('[data-testid=screen-setup]')"));
 await app.main("cwin().setBounds({x:0,y:0,width:1000,height:1000});win('surface=mate-chat').setBounds({x:1010,y:0,width:850,height:1000});win('surface=mate-overlay').setBounds({x:1680,y:760,width:220,height:300});return true");
 rootShot(before?'before-two-settings':'after-two-settings-initial');
 await select(chat,'[data-testid=screen-mode]','ask');await click(chat,'[data-testid=screen-start]');await until('picker',()=>chat.eval("!!document.querySelector('[data-testid=share-source]')"));await click(chat,'[data-testid=share-source]');await click(chat,'[data-testid=share-go]');await until('sharing active',async()=>!!(await chat.eval('window.hrhNative.capture.sharing.get()')).state);
 await click(chat,'[data-testid=mate-attach]');await click(chat,'[data-testid=attach-share-screen]');await until('active setup',()=>chat.eval("!!document.querySelector('[data-testid=screen-setup]')"));
 await select(chat,'[data-testid=screen-mode]','on_turn');await until('mode stored',async()=>(await con.eval('window.hrhNative.device.get()')).sharing.mode==='on_turn');await sleep(300);
 const liveMode=(await con.eval('window.hrhNative.capture.sharing.get()')).state.mode;
 if(before){assert.equal(liveMode,'ask');fs.writeFileSync(path.join(shots,'before-sync-proof.json'),JSON.stringify({stored:'on_turn',live:liveMode}));console.log('REPRODUCED saved on_turn but live ask until Apply');return;}
 assert.equal(liveMode,'on_turn');assert.equal(await value(con,'[data-testid=screen-mode]'),'on_turn');
 for(const [s,v] of [['device-capture-size','1280'],['device-capture-format','jpeg'],['device-capture-approval','allow']]){await select(con,`[data-testid=${s}]`,v);await until(s+' con to chat',async()=>await value(chat,`[data-testid=${s}]`)===v);}
 rootShot('after-con-to-chat');
 for(const [s,v] of [['device-capture-size','2560'],['device-capture-format','png'],['device-capture-approval','ask']]){await select(chat,`[data-testid=${s}]`,v);await until(s+' chat to con',async()=>await value(con,`[data-testid=${s}]`)===v);}
 await click(con,'[data-testid=device-proactive-enabled]');await select(con,'[data-testid=device-proactive-interval]','60');
 await until('reach-out synced',()=>chat.eval("document.querySelector('[data-testid=device-proactive-enabled]').checked && document.querySelector('[data-testid=device-proactive-interval]').value==='60'"));
 await click(con,'[data-testid=device-proactive-enabled]');
 await click(con,'[data-testid=mate-screen-enabled]');await until('permission synced',()=>chat.eval("document.querySelector('[data-testid=device-mate-permission]').dataset.enabled==='true'"));
 rootShot('after-chat-to-con');
 await con.eval('window.hrhNative.mate.openQuick()');const quick=await app.page(/surface=mate-quick/);const overlay=await app.page(/surface=mate-overlay/);
 for(const p of [chat,quick,overlay]){const prefs=await p.eval('window.hrhNative.device.get()');assert.equal(prefs.screen.max_edge,2560);assert.equal(prefs.screen.format,'png');assert.equal(prefs.sharing.mode,'on_turn');}
 execFileSync('xdotool',['mousemove','1780','900']);const bar=await app.page(/bar\.html/);await until('toolbar sharing on',()=>bar.eval("document.querySelector('[data-act=screen]')?.classList.contains('sharing')"));
 // Change an actual native capture target: stop everywhere; never apply it to an existing share silently.
 const options=await con.eval("[...document.querySelector('[data-testid=device-capture-source]').options].map(e=>e.value)");
 const target=options.find(id=>id.startsWith('window:'));assert.ok(target);
 await until('previous capture toast gone',async()=>{const n=await Promise.all([con,chat,quick,overlay].map(p=>p.eval("document.querySelectorAll('[data-testid=capture-toast]').length")));return n.every(x=>x===0);});
 await select(con,'[data-testid=device-capture-source]',target);await until('source stop',async()=>!(await con.eval('window.hrhNative.device.get()')).sharing.enabled);
 await until('all sharing stopped',async()=>(await chat.eval('window.hrhNative.capture.sharing.get()')).state===null);
 await until('toolbar sharing off',()=>bar.eval("!document.querySelector('[data-act=screen]')?.classList.contains('sharing')"));
 await until('source reflected',async()=>await value(chat,'[data-testid=device-capture-source]')===target);
 await until('one source-change notice',async()=>{const n=await Promise.all([con,chat,quick,overlay].map(p=>p.eval("document.querySelectorAll('[data-testid=capture-toast]').length")));return n.reduce((a,b)=>a+b,0)===1;});
 rootShot('after-source-change-stopped');
 await con.send('Page.reload');await until('reload settings entry',()=>con.eval("!!document.querySelector('[data-testid=mate-settings-open]')"));await click(con,'[data-testid=mate-settings-open]');await until('reloaded tabs',()=>con.eval("!!document.querySelector('[data-testid=mate-tab-screen]')"));await click(con,'[data-testid=mate-tab-screen]');await until('reloaded values',async()=>await value(con,'[data-testid=device-capture-size]')==='2560');
 assert.equal((await con.eval('window.hrhNative.capture.sharing.get()')).state,null);
 console.log('PASS actual two-window bidirectional source/approval/size/format/mode synchronization; live owner changes immediately; Geny and mate permission sync; quick/avatar mirror; source change stops; reload retains values');
 await app.main("cwin().setBounds({x:0,y:0,width:430,height:900});return true");await sleep(500);await until('phone tab ready',()=>con.eval("!!document.querySelector('[data-testid=mate-tab-proactive]')"));await click(con,'[data-testid=mate-tab-proactive]');await until('phone rules',()=>con.eval("!!document.querySelector('[data-testid=trigger-rules-editor]')"));await con.eval("document.querySelector('[data-testid=trigger-rules-editor]').scrollIntoView(),true");await shot(con,'after-rules-phone');
 await con.eval("(()=>{const d=document.querySelector('[data-testid=trigger-category-first_idle]');d.open=true;document.querySelector('[data-testid=trigger-weight-first_idle]').scrollIntoView({block:'center'});return true})()");await sleep(150);
 const touchBox=await con.eval("(()=>{const r=document.querySelector('[data-testid=trigger-weight-first_idle]').getBoundingClientRect();return {x:r.x+r.width*.4,y:r.y+r.height/2}})()");
 const beforeTouch=Number(await value(con,'[data-testid=trigger-weight-first_idle]'));
 await con.send('Emulation.setTouchEmulationEnabled',{enabled:true});
 await con.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:touchBox.x,y:touchBox.y}]});
 await con.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touchBox.x+20,y:touchBox.y}]});
 await con.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await until('touch release saved',()=>con.eval(`fetch('/api/mates/${mate.id}').then(r=>r.json()).then(m=>m.prefs.proactive.preset.categories.find(c=>c.id==='first_idle').weight!==${beforeTouch})`));
 await shot(con,'after-rules-phone-touch');console.log('PASS native mouse drag, keyboard and touch input save on completion');

 console.log('SETTINGS UX E2E OK');
}finally{await app.stop();}})().catch(e=>{console.error(e);process.exitCode=1;});
