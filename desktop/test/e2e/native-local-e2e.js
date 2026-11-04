'use strict';
const {App,until,sleep}=require('./screen-capture-e2e');
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const out=process.env.LOCAL_TEST_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'geny-local-e2e-'));
fs.mkdirSync(out,{recursive:true});
const home=fs.mkdtempSync(path.join(out,'home-')),workspace=path.join(out,'project');
fs.mkdirSync(path.join(home,'.claude'),{recursive:true});fs.mkdirSync(workspace,{recursive:true});
fs.writeFileSync(path.join(home,'.claude','.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fixture-only',refreshToken:'fixture-only',expiresAt:Date.now()+86400000,scopes:['user:inference']}}));
process.env.HRH_LOCAL_RUNTIME_ROOT=path.resolve(__dirname,'../../local-runtime');
process.env.CLAUDE_BINARY=path.resolve(__dirname,'fake-claude.py');
// Pin Korean UI to match the requested screenshots.
fs.mkdirSync(path.join(home,'.config/hr-harnessor'),{recursive:true});
fs.writeFileSync(path.join(home,'.config/hr-harnessor/settings.json'),JSON.stringify({language:'ko'}));
process.env.PLAN_USAGE_FETCH='false';process.env.CLI_UPDATE_CHECK='false';process.env.MONITOR_ENABLED='false';
let app=null;const results={};
async function shot(page,name){const r=await page.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name),Buffer.from(r.data,'base64'));}
const request=(p,route,init={})=>p.eval(`fetch(${JSON.stringify(route)},${JSON.stringify(init)}).then(async r=>({status:r.status,data:await r.json()}))`);
async function start(port){app=new App(home,port,port+500);app.start();return app;}
(async()=>{try{
 await start(9871);let page=await app.page(/connect\.html/);
 await until('local mode',()=>page.eval('document.querySelector("#modeLocal[aria-selected=true]") && !document.getElementById("serverFields").offsetHeight'));
 await shot(page,'01-local-or-server.png');
 await page.eval('document.getElementById("go").click()');
 page=await app.page(/^http:\/\/127\.0\.0\.1:\d+\/(?!\?surface)/,65000);
 await until('setup assistant',()=>page.eval('document.querySelector("[data-testid=setup-assistant]")?.innerText.includes("연결됨")'),40000);
 await shot(page,'02-local-setup-detected.png');
 const setup=await request(page,'/api/setup');assert.equal(setup.status,200);assert.equal(setup.data.execution_mode,'local');assert.equal(setup.data.tools.find(t=>t.id==='claude').connected,true);results.discovery=setup.data.tools.map(({id,installed,connected})=>({id,installed,connected}));
 assert.equal((await request(page,'/api/local/bootstrap',{method:'POST'})).status,403);
 // OS folder dialog is intercepted in the main process; the real bridge/probe/release still execute.
 await app.main(`require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(workspace)}]});return true;`);
 await page.eval('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="로컬 폴더 선택").click()');
 await until('chosen local path',()=>page.eval(`document.body.innerText.includes(${JSON.stringify(workspace)})`));
 await shot(page,'03-local-folder-selected.png');
 await page.eval('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="선택한 폴더에서 시작").click()');
 await until('setup completed',()=>page.eval('!document.querySelector("[data-testid=setup-assistant]")'));
 const sessions=await request(page,'/api/sessions');const session=sessions.data.sessions?.[0]||sessions.data[0];assert.ok(session?.id);assert.equal(session.workspace_path,workspace);results.session=session.id;
 await until('composer',()=>page.eval('!!document.querySelector("textarea")'));
 await page.eval('document.querySelector("textarea").focus()');await page.send('Input.insertText',{text:'local native test message'});
 await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await until('local CLI reply',async()=>{const r=await request(page,`/api/sessions/${session.id}/messages`);return r.status===200&&r.data.some(m=>m.role==='assistant'&&m.content);},30000);
 results.localChat=true;
 results.origin=await page.eval('location.origin');
 await shot(page,'04-local-session.png');
 const firstSettings=JSON.parse(fs.readFileSync(path.join(home,'.config/hr-harnessor/settings.json')));
 assert.equal(firstSettings.launchMode,'local');assert.equal(firstSettings.setupCompleted.local,true);
 await app.stop();app=null;
 await start(9872);page=await app.page(/^http:\/\/127\.0\.0\.1:\d+\/(?!\?surface)/,65000);
 await until('restored local session',async()=>{const r=await request(page,'/api/sessions');return JSON.stringify(r.data).includes(session.id);});
 await sleep(1500);assert.equal(await page.eval('!!document.querySelector("[data-testid=setup-assistant]")'),false);results.restart=true;
 await shot(page,'05-local-restarted.png');
 const mainSettings=await app.main(`return require(${JSON.stringify(path.resolve(__dirname,'../../src/settings.js'))}).readSettings();`);
 const db=path.join(home,'.config/hr-harnessor/local/geny.db');assert.ok(fs.existsSync(db));
 results.restoredOrigin=mainSettings.localOrigin;
 await page.eval('window.hrhNative.switchServer()');page=await app.page(/connect\.html/);await until('server choice rendered',()=>page.eval('!!document.getElementById("modeServer")'));await page.eval('document.getElementById("modeServer").click()');assert.equal(await page.eval('!document.getElementById("serverFields").hidden'),true);results.serverModeSelectable=true;
 await shot(page,'06-server-connection.png');
 await app.stop();app=null;
 // The backend port must close with the app, not remain as a hidden local service.
 await until('backend exited',async()=>{try{await fetch(results.origin+'/health');return false;}catch{return true;}},7000);results.quit=true;
 console.log(JSON.stringify(results,null,2));fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
 }catch(e){if(app){fs.writeFileSync(path.join(out,'electron.log'),app.out||'');try{const pages=await app.targets();for(const target of pages){const p=await app.page(new RegExp(target.url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));await shot(p,'failure.png');break;}}catch{}}throw e;}
 finally{if(app)await app.stop();console.log('Artifacts: '+out);}
})().catch(e=>{console.error(e);process.exitCode=1;});
