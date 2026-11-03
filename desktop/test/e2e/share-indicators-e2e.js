// Real Electron/X11: persistent sharing bars must not affect any composer.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {App,fill,until,sleep}=require('./screen-capture-e2e');
const [server,password,workspace,shots]=process.argv.slice(2);
const app=new App(fs.mkdtempSync(path.join(os.tmpdir(),'geny-indicator-')),9670,10170);
const before=process.env.SCREEN_UI_BEFORE==='1';
const click=(p,s)=>p.eval(`document.querySelector(${JSON.stringify(s)}).click(),true`);
const shot=async(p,n)=>{const r=await p.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shots,n+'.png'),Buffer.from(r.data,'base64'));};
(async()=>{try{
 app.start();const connect=await app.page(/connect\.html/);await until('connect',()=>connect.eval('!!window.hrhConnect'));await connect.eval(fill(server,'admin',password));
 const con=await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)'));
 const mates=await con.eval("fetch('/api/mates').then(r=>r.json())");const mate=mates[0];
 await con.eval(`window.hrhNative.mate.setMate(${JSON.stringify(mate.id)}).then(()=>window.hrhNative.mate.showAvatar(${JSON.stringify(mate.id)})).then(()=>window.hrhNative.mate.openChat()).then(()=>true)`);
 const chat=await app.page(/surface=mate-chat/);await app.main("win('surface=mate-overlay').setBounds({x:180,y:60,width:220,height:320});return true");require('child_process').execFileSync('xdotool',['mousemove','280','220']);const bar=await app.page(/bar\.html/);await until('composer',()=>chat.eval("!!document.querySelector('[data-testid=mate-input]')"));
 await click(bar,'[data-act=screen]');await until('setup',()=>chat.eval("!!document.querySelector('[data-testid=screen-start]')"));await click(chat,'[data-testid=screen-start]');await until('sources',()=>chat.eval("!!document.querySelector('[data-testid=share-source]')"));await click(chat,'[data-testid=share-source]');await click(chat,'[data-testid=share-go]');await sleep(600);
 await shot(chat,before?'before-chat':'after-chat');
 await con.eval('window.hrhNative.mate.openQuick().then(()=>true)');const quick=await app.page(/surface=mate-quick/);await until('quick',()=>quick.eval("!!document.querySelector('[data-testid=mate-input]')"));
 await quick.eval("(()=>{let e=document.querySelector('[data-testid=mate-input]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'채린아 뭐하고 있어');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()");await sleep(300);await shot(quick,before?'before-quick':'after-quick');
 if(!before){
 const selectors='[data-testid=screen-sharing-banner],[data-testid=local-screen-controls],[data-testid=screen-stop],[data-testid=screen-setup-open]';
 for(const p of [chat,quick,con])assert.equal(await p.eval(`document.querySelectorAll(${JSON.stringify(selectors)}).length`),0);
 const geometry=await quick.eval("(()=>{let r=document.querySelector('[data-testid=mate-input]').getBoundingClientRect();return {width:r.width,height:r.height}})()");
 const overlay=await app.page(/surface=mate-overlay/);
 const pages=[con,chat,quick,overlay];
 assert.equal(await overlay.eval(`document.querySelectorAll(${JSON.stringify(selectors)}).length`),0);
 // Actual native capture must produce one short, floating notification, not a broadcast.
 const sources=await chat.eval('window.hrhNative.capture.sources()');
 const capture=chat.eval(`window.hrhNative.capture.grab({sourceId:${JSON.stringify(sources[0].id)},id:'indicator-test',maxEdge:640,format:'png'}).then(()=>true)`);
 await until('single toast',async()=>{const n=await Promise.all(pages.map(p=>p.eval("document.querySelectorAll('[data-testid=capture-toast]').length")));return n.reduce((a,b)=>a+b,0)===1;});await shot(chat,'after-capture-toast');await capture;await sleep(1800);
 assert.equal((await Promise.all(pages.map(p=>p.eval("document.querySelectorAll('[data-testid=capture-toast]').length")))).reduce((a,b)=>a+b,0),0);
 await click(bar,'[data-act=screen]');await sleep(300);
 assert.deepEqual(await quick.eval("(()=>{let r=document.querySelector('[data-testid=mate-input]').getBoundingClientRect();return {width:r.width,height:r.height}})()"),geometry);
 await shot(quick,'after-stopped');console.log('PASS no persistent bars across console/chat/quick; one native capture toast; sharing stop leaves input geometry unchanged');
 await con.eval("location.href='/?view=mate',true");await until('settings entry',()=>con.eval("!!document.querySelector('[data-testid=mate-settings-open]')"));await click(con,'[data-testid=mate-settings-open]');await until('screen tab',()=>con.eval("!!document.querySelector('[data-testid=mate-tab-screen]')"));await click(con,'[data-testid=mate-tab-screen]');await until('settings share start',()=>con.eval("!!document.querySelector('[data-testid=settings-screen-start]')"));await click(con,'[data-testid=settings-screen-start]');await until('settings setup',()=>con.eval("!!document.querySelector('[data-testid=screen-start]')"));assert.equal(await con.eval("document.querySelectorAll('[data-testid=screen-once]').length"),0);await click(con,'[data-testid=screen-start]');await until('settings picker',()=>con.eval("!!document.querySelector('[data-testid=share-source]')"));await click(con,'[data-testid=share-source]');await click(con,'[data-testid=share-go]');await until('settings sharing',()=>con.eval("!!document.querySelector('[data-testid=settings-screen-stop]')"));await shot(con,'after-screen-settings');await click(con,'[data-testid=settings-screen-stop]');await until('settings stop synced',async()=>(await chat.eval('window.hrhNative.capture.sharing.get()')).state===null);console.log('PASS settings start/stop and all-window consent synchronization');
 }
 console.log('SHARING UI E2E OK '+(before?'before':'after'));
}finally{await app.stop();}})().catch(e=>{console.error(e);process.exitCode=1;});
