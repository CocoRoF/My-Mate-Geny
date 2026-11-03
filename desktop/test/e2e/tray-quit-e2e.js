const assert=require('assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),{execFileSync}=require('child_process');
const {App,fill,until,sleep}=require('./screen-capture-e2e');
const [server,password]=process.argv.slice(2);
(async()=>{
for(const mode of ['normal','sharing','hidden','beforeunload','close-veto','hung']){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'geny-quit-before-')),log=path.join(home,'quit-events.log');
 let app=new App(home,9650,10150);
 try{
 app.start();const c=await app.page(/connect\.html/);await until('connect',()=>c.eval('!!window.hrhConnect'));await c.eval(fill(server,'admin',password));
 let con=await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)(?!\\?surface=)'));
 const m=(await con.eval("fetch('/api/mates').then(r=>r.json())"))[0];
 const conv=await con.eval(`fetch('/api/mates/${m.id}/conversation',{method:'POST'}).then(r=>r.json())`);
 if(mode!=='normal'){
 const source=(await con.eval('window.hrhNative.capture.sources()')).find(s=>s.kind==='screen');
 await con.eval(`window.hrhNative.device.patch({screen:{source:${JSON.stringify(source)},proactive_enabled:true,proactive_mate:'${m.id}'},sharing:{enabled:true,origin:location.origin,sid:'${conv.session_id}',mate_id:'${m.id}',name:'Mate',mode:'ask'}})`);
 await con.eval(`window.hrhNative.mate.showAvatar('${m.id}').then(()=>window.hrhNative.mate.openChat()).then(()=>window.hrhNative.mate.openQuick())`);
 await until('sharing ready',async()=>!!(await con.eval('window.hrhNative.capture.sharing.get()')).state);
 }
 if(mode==='hidden'){
 await app.stop();app=new App(home,9650,10150);app.start(['--hidden']);await app.page(/surface=device-runtime/);await sleep(500);
 }
 if(mode==='beforeunload')await con.eval("window.onbeforeunload=()=>false;true");
 if(mode==='close-veto')await app.main("cwin().on('close',e=>e.preventDefault());setTimeout(()=>require('electron').app.emit('second-instance',{},['manual']),600);return true");
 if(mode==='hung'){await con.eval("setTimeout(()=>{while(true){}},50);true");await sleep(250);}
 await app.main(`
 const E=require('electron'),fs=require('fs');global.quitProbe=(s)=>fs.appendFileSync(${JSON.stringify(log)},Date.now()+' '+s+'\\n');
 E.app.prependListener('before-quit',()=>quitProbe('before-quit'));
 E.app.on('will-quit',()=>quitProbe('will-quit'));E.app.on('quit',()=>quitProbe('quit'));
 for(const w of E.BrowserWindow.getAllWindows()){const url=w.webContents.getURL();w.on('close',()=>quitProbe('close '+url));w.on('closed',()=>quitProbe('closed '+url));w.webContents.on('will-prevent-unload',()=>quitProbe('prevent-unload '+url));}
 const original=E.Tray.prototype.setContextMenu;E.Tray.prototype.setContextMenu=function(menu){global.trayQuitProbe=menu;return original.call(this,menu)};
 Object.values(require.cache).find(m=>m.filename?.endsWith('/src/mate.js')).exports.refresh();E.Tray.prototype.setContextMenu=original;
 const item=trayQuitProbe.items.find(i=>/^(Quit|종료)$/.test(i.label)),click=item.click;
 item.click=(...a)=>{quitProbe('tray-click');return click(...a)};
 quitProbe('menu-ready');trayQuitProbe.popup({x:120,y:120});return true;`);
 execFileSync('xdotool',['key','End','Return']);await sleep(180);if(fs.readFileSync(log,'utf8').includes('tray-click')){app.mainCdp?.close();app.mainCdp=null;}
 let exited=await Promise.race([app.exited.then(()=>true),sleep(7500).then(()=>false)]);
 let lines=fs.existsSync(log)?fs.readFileSync(log,'utf8'):'';
 if(!lines.includes('tray-click')){
  console.log('native menu keyboard did not activate; invoke exact tray MenuItem click callback');
  await app.main("setTimeout(()=>trayQuitProbe.items.find(i=>/^(Quit|종료)$/.test(i.label)).click(),30);return true");
  await sleep(180);app.mainCdp?.close();app.mainCdp=null;
  exited=await Promise.race([app.exited.then(()=>true),sleep(7500).then(()=>false)]);lines=fs.readFileSync(log,'utf8');
 }
 console.log(JSON.stringify({mode,naturalExit:exited,log:lines,home}));assert.equal(exited,true,'tray Quit must exit in '+mode);
 await sleep(600);let alive=false;try{process.kill(app.proc.pid,0);alive=true;}catch{}assert.equal(alive,false);
 const settings=JSON.parse(fs.readFileSync(path.join(home,'.config/hr-harnessor/settings.json'),'utf8'));if(mode!=='normal')assert.equal(settings.devicePreferences.sharing.enabled,true,'Quit must preserve sharing intent for next intentional start');
 }finally{await app.stop();}
}
console.log('TRAY QUIT E2E OK');
})().catch(e=>{console.error(e);process.exitCode=1});
