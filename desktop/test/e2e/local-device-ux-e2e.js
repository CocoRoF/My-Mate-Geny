'use strict';
// Real local app/runtime, with installation HTTP responses intercepted so no provider CLI is installed.
const {App,until,sleep}=require('./screen-capture-e2e');
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const out=process.env.LOCAL_TEST_OUTPUT||fs.mkdtempSync('/home/hrjang/.cache/hrh-local-device-ui-');fs.mkdirSync(out,{recursive:true});
const home=fs.mkdtempSync(path.join(out,'home-'));fs.mkdirSync(path.join(home,'.claude'),{recursive:true});fs.mkdirSync(path.join(home,'.config/hr-harnessor'),{recursive:true});
fs.writeFileSync(path.join(home,'.claude/.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fixture-only',refreshToken:'fixture-only',expiresAt:Date.now()+86400000,scopes:['user:inference']}}));
fs.writeFileSync(path.join(home,'.config/hr-harnessor/settings.json'),JSON.stringify({language:'ko'}));
process.env.CLAUDE_BINARY=path.resolve(__dirname,'fake-claude.py');process.env.HRH_LOCAL_RUNTIME_ROOT=path.resolve(__dirname,'../../local-runtime');
process.env.PLAN_USAGE_FETCH='false';process.env.CLI_UPDATE_CHECK='false';process.env.MONITOR_ENABLED='false';
// Read-only GitHub authentication from this test operator; nothing is copied into a build or fixture profile.
process.env.GH_CONFIG_DIR=process.env.GH_CONFIG_DIR||path.join(os.homedir(),'.config/gh');
const DEFAULT='https://github.com/CocoRoF/My-Mate-Geny';let app=null;const result={};
async function shot(p,name){await sleep(250);const r=await p.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name),Buffer.from(r.data,'base64'));}
async function openSettings(p,tab){await p.eval(`location.href='/?view=settings&tab=${tab}'`);await until('settings '+tab,()=>p.eval(`!!document.querySelector('[data-testid="settings-panel-${tab}"]')`));}
async function quit(){if(!app)return;try{await app.main('const a=require("electron").app;setTimeout(()=>a.quit(),100);return true;');await Promise.race([app.exited,sleep(6500)]);}catch{}await app.stop();app=null;}
(async()=>{try{
 app=new App(home,9891,10391);app.start();let p=await app.page(/connect\.html/);await until('local choice',()=>p.eval('!!document.getElementById("modeLocal")'));await p.eval('document.getElementById("modeLocal").click();document.getElementById("go").click()');
 p=await app.page(/^http:\/\/127\.0\.0\.1:\d+\/(?!\?surface)/,65000);
 await until('first setup',()=>p.eval('!!document.querySelector("[data-testid=setup-assistant]")'));await shot(p,'01-first-visit-setup.png');
 await until('setup visit persisted',()=>p.eval('window.hrhNative.setup.state()'));await p.eval('location.reload()');
 await until('no repeat without completing setup',()=>p.eval('!!document.querySelector("[data-testid=local-workspace-picker]") && !document.querySelector("[data-testid=setup-assistant]")'));result.noRepeatedAssistant=true;
 const origin=await p.eval('location.origin');
 const localRelease=await p.eval('fetch("/api/downloads").then(r=>r.json())');assert.equal(localRelease.available,false);result.localBackendHasNoGitHubToken=true;
 const catalog=await p.eval('window.hrhNative.updates.catalog(true)');assert(catalog.available,JSON.stringify(catalog));assert.equal(catalog.repository,DEFAULT);assert(catalog.assets.some(a=>a.platform==='windows'));result.directGitHubWithoutGenyServer=true;
 await openSettings(p,'updates');await until('source footer',()=>p.eval('!!document.querySelector("[data-testid=update-source]")'));
 assert.equal(await p.eval('!!document.querySelector("[data-testid=settings-web-version]")'),false);
 assert.equal(await p.eval('!!document.querySelector("[data-testid=settings-check-web]")'),false);result.noWebConsoleInLocal=true;
 await shot(p,'02-local-updates.png');
 await p.eval('document.querySelector("[data-testid=update-source] button").click()');await until('source editor',()=>p.eval('!!document.querySelector("[data-testid=update-source-url]")'));
 await p.eval('document.querySelector("[data-testid=update-source-url]").focus()');await p.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await p.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await p.send('Input.insertText',{text:'https://github.com/nodejs/node'});
 await p.eval('Array.from(document.querySelector("[data-testid=update-source]").querySelectorAll("button")).find(b=>b.textContent==="저장").click()');
 await until('source saved',()=>p.eval('window.hrhNative.updates.source().then(s=>s.repository==="https://github.com/nodejs/node")'));result.customRepository=true;
 await until('source operation settled',()=>p.eval('window.hrhNative.updates.getState().then(s=>!["checking","downloading","installing","ready"].includes(s.status))'),45000);
 await shot(p,'03-custom-update-source.png');
 // A second real app window subscribes to source changes through native IPC.
 const secondId=await app.main(`const native=require('electron'),path=require('path');const w=new native.BrowserWindow({show:true,width:1050,height:850,webPreferences:{preload:path.join(native.app.getAppPath(),'src/preload.js'),additionalArguments:['--hrh-surface=console','--hrh-version='+native.app.getVersion()]}});await w.loadURL(${JSON.stringify(origin+'/?view=settings&tab=updates&testSecond=1')});return w.webContents.id;`);
 const second=await app.page(/testSecond=1/);await until('second source view',()=>second.eval('document.querySelector("[data-testid=update-source]")?.innerText.includes("https://github.com/nodejs/node")'));
 await p.eval(`window.hrhNative.updates.setSource({repository:${JSON.stringify(DEFAULT)}})`);
 await until('other window source updates',()=>second.eval(`document.querySelector("[data-testid=update-source]")?.innerText.includes(${JSON.stringify(DEFAULT)})`));result.sourceMultiWindow=true;
 await app.main(`const w=require('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.id===${secondId});w.destroy();return true;`);
 // Intercept installation APIs, including POSTs, before exercising their buttons. Never run a real provider installer.
 const cli=await p.eval('fetch("/api/cli-tools").then(r=>r.json())');for(const tool of cli.tools)if(tool.id!=='claude'){tool.installed={...tool.installed,path:null,version:null,method:'missing'};tool.update_available=false;tool.upgrade={possible:false,code:'npm_missing'};}
 const idle=()=>({phase:'idle',log:[],error:''});const installations={tools:['claude','codex','higgsfield'].map(id=>({id,installed:id==='claude',job:idle()})),node:{installed:false,node:null,npm:null,git:null,version:null,job:idle()},busy:false};const requests=[];
 p.ws.addEventListener('message',event=>{let m;try{m=JSON.parse(event.data);}catch{return;}if(m.method!=='Fetch.requestPaused')return;const {requestId,request}=m.params;
  (async()=>{let body;const route=new URL(request.url).pathname;if(route==='/api/cli-tools')body=cli;
   else if(route==='/api/setup/installations')body=installations;
   else {const tool=/\/api\/setup\/([^/]+)\/(install|cancel)$/.exec(route);assert(tool,'Unexpected installer route');const id=tool[1],job=id==='node'?installations.node.job:installations.tools.find(t=>t.id===id).job;
    if(tool[2]==='install'){requests.push({tool:id,body:JSON.parse(request.postData||'{}')});installations.busy=true;Object.assign(job,{phase:'installing',step:'nodeDownload',log:['Fixture installer only'],error:'',transferred:40,total:100});setTimeout(()=>{installations.node.installed=true;installations.node.node='/fixture/node';installations.node.npm='/fixture/npm';if(id!=='node')installations.tools.find(t=>t.id===id).installed=true;job.phase='done';installations.busy=false;},1300);}else {job.phase='cancelled';installations.busy=false;}
    body=job;
   }
   await p.send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'content-type',value:'application/json'}],body:Buffer.from(JSON.stringify(body)).toString('base64')});
  })().catch(async e=>{console.error(e);await p.send('Fetch.failRequest',{requestId,errorReason:'Aborted'}).catch(()=>{});});
 });
 await p.send('Fetch.enable',{patterns:[{urlPattern:'*/api/setup/installations*'},{urlPattern:'*/api/setup/*/install'},{urlPattern:'*/api/setup/*/cancel'},{urlPattern:'*/api/cli-tools'}]});
 await openSettings(p,'providers');await until('dependency install control',()=>p.eval('!!document.querySelector("[data-testid=install-node]")'));
 await shot(p,'04-provider-installers.png');
 await p.eval('document.querySelector("[data-testid=install-tool-higgsfield] button").click()');
 await until('dependency install request captured',()=>requests.some(r=>r.tool==='higgsfield'));assert(requests.find(r=>r.tool==='higgsfield').body.dependencies);result.higgsfieldInstallWithPrerequisites=true;
 await until('installation progress',()=>p.eval('document.querySelector("[data-testid=install-tool-higgsfield]").innerText.includes("다운로드 중")'));
 await shot(p,'05-install-progress.png');
 await until('installation completion',()=>p.eval('document.querySelector("[data-testid=install-tool-higgsfield]").innerText.includes("설치 완료")'),15000);
 result.installerUi=true;result.providerInstallationWasFixtureOnly=true;
 await p.send('Fetch.disable');
 await quit();app=new App(home,9892,10392);app.start();p=await app.page(/^http:\/\/127\.0\.0\.1:\d+\/(?!\?surface)/,65000);
 await until('restart without assistant',()=>p.eval('!!document.querySelector("[data-testid=local-workspace-picker]")&&!document.querySelector("[data-testid=setup-assistant]")'));assert.equal((await p.eval('window.hrhNative.updates.source()')).repository,DEFAULT);result.restartKeepsVisitedAndSource=true;
 await shot(p,'06-visited-after-restart.png');console.log(JSON.stringify(result));fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2));
 }catch(e){if(app){fs.writeFileSync(path.join(out,'electron.log'),app.out||'');try{const targets=await app.targets();const target=targets.find(t=>!t.url.includes('surface='));if(target)await shot(await app.page(new RegExp(target.url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))),'failure.png');}catch{}}throw e;}
 finally{await quit();}
})().catch(e=>{console.error(e);process.exitCode=1;});
