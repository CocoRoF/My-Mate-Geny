// All current surfaces ignore both actual native completions and older native completion IPC.
const {App,fill,until,sleep}=require('../../../desktop/test/e2e/screen-capture-e2e');
const {chromium}=require('playwright-core');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const [server,password]=process.argv.slice(2),shots=process.env.SCREEN_SHOTS,before=process.env.CAPTURE_NOTICE_BEFORE==='1';
const app=new App(fs.mkdtempSync(path.join(os.tmpdir(),'geny-capture-silent-')),9640,10140);
(async()=>{let browser;try{
 app.start();const connect=await app.page(/connect\.html/);await until('connect',()=>connect.eval('!!window.hrhConnect'));await connect.eval(fill(server,'admin',password));
 await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)(?!\\?surface=)'));
 browser=await chromium.connectOverCDP('http://127.0.0.1:9640');const ctx=browser.contexts()[0];
 await ctx.addInitScript(()=>localStorage.setItem('hrh_lang','ko'));
 const main=ctx.pages().find(p=>p.url().startsWith(server)&&!p.url().includes('surface='));
 const mates=await main.evaluate(()=>fetch('/api/mates').then(r=>r.json())),mate=mates[0];
 await main.goto(server+'/?view=mate');await main.evaluate(async id=>{await window.hrhNative.mate.showAvatar(id);await window.hrhNative.mate.openChat();await window.hrhNative.mate.openQuick()},mate.id);
 const pages=[main];for(const surface of ['mate-overlay','mate-chat','mate-quick'])pages.push(await until(surface,()=>ctx.pages().find(p=>p.url().includes('surface='+surface))));
 for(const p of pages){
  await p.waitForSelector('#root > *');
  await p.evaluate(()=>{window.__captureNotices=[];window.__captureObserver=new MutationObserver(()=>{for(const e of document.querySelectorAll('[data-testid=capture-toast],[data-testid=app-toast]'))if(/Screen captured|Screen shared with|화면을 캡처했어요/.test(e.textContent))window.__captureNotices.push(e.textContent)});window.__captureObserver.observe(document.body,{childList:true,subtree:true})});
 }
 const source=(await main.evaluate(()=>window.hrhNative.capture.sources())).find(s=>s.kind==='screen');assert(source);
 await main.evaluate(src=>window.hrhNative.device.patch({screen:{source:src,approval:'ask'}}),source);
 const results=[];
 // User-initiated native one-shot capture.
 const grabbing=main.evaluate(sourceId=>window.hrhNative.capture.grab({sourceId,id:'manual-no-notice',maxEdge:640,format:'png'}),source.id);
 if(before){
  const recipient=await until('old completion toast',async()=>{for(const p of pages)if(await p.locator('[data-testid=capture-toast]').count())return p;});
  await recipient.screenshot({path:path.join(shots,'before-capture-notice.png')});
  assert((await grabbing).ok);console.log('REPRODUCED capture success toast');return;
 }
 const manual=await grabbing;assert(manual.ok);results.push({case:'manual',ok:manual.ok,width:manual.width});
 // Agent capture retains the approval prompt; Allow captures, but completion is silent.
 const request=pages[2].evaluate(id=>window.hrhNative.capture.request({id:'agent-no-notice',mate_id:id,mate_name:'한채린',max_edge:640,format:'png',reason:'검증 화면 확인'}),mate.id);
 const prompt=await until('approval retained',()=>ctx.pages().find(p=>p.url().includes('capture-ask.html')));
 await prompt.getByTestId('capture-allow').waitFor();await prompt.screenshot({path:path.join(shots,'approval-retained.png')});
 await prompt.evaluate(()=>setTimeout(()=>document.querySelector('[data-testid=capture-allow]').click(),25));
 const agent=await request;assert(agent.ok);results.push({case:'agent-approved',ok:true,width:agent.width});
 const auto=await main.evaluate(id=>window.hrhNative.capture.request({id:'auto-no-notice',mate_id:id,mate_name:'한채린',automatic:true,max_edge:640,format:'jpeg'}),mate.id);assert(auto.ok);results.push({case:'automatic',ok:true,width:auto.width});
 // Old shells may still send completion commands: there must be no remaining frontend receiver.
 await app.main("for(const w of BrowserWindow.getAllWindows())if(w.webContents.getURL().startsWith('http://127.0.0.1:8134'))w.webContents.send('mate:command',{type:'capture',state:'done',notification_id:'legacy-completion'});return true");
 await sleep(350);
 for(const p of pages){const notices=await p.evaluate(()=>window.__captureNotices);assert.deepEqual(notices,[],p.url());results.push({surface:new URL(p.url()).searchParams.get('surface')||'console',completionNotices:0});}
 await pages[2].screenshot({path:path.join(shots,'after-no-capture-notice.png')});
 fs.writeFileSync(path.join(shots,'capture-no-notice.json'),JSON.stringify(results,null,2));console.log('CAPTURE NO NOTICE E2E OK: manual + agent approval + automatic; zero notices across four windows');
}finally{await app.stop();if(browser)await browser.close().catch(()=>{});}})().catch(e=>{console.error(e);process.exitCode=1});
