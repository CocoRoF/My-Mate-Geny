'use strict';
const {chromium}=require('playwright-core');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {App,until,fill}=require('./screen-capture-e2e');
const [server,password,workspace,shots]=process.argv.slice(2);
fs.mkdirSync(shots,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME,headless:true,args:['--no-sandbox']});
 let app;
 try{
  for(const mobile of [false,true]){
   const ctx=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile});
   await ctx.addInitScript(()=>{localStorage.setItem('hrh_lang','ko');localStorage.setItem('hrh_theme','dark');});
   const login=await ctx.request.post(server+'/api/auth/login',{data:{username:'admin',password}});assert.equal(login.status(),200);
   const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(server+'/');await page.locator('[data-testid=setup-assistant]').waitFor();
   await page.getByText('연결됨',{exact:false}).first().waitFor();
   const setup=await (await ctx.request.get(server+'/api/setup')).json();assert.equal(setup.execution_mode,'server');
   assert.equal(await page.getByRole('button',{name:'로컬 폴더 선택',exact:true}).count(),0);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:path.join(shots,mobile?'server-mobile-setup.png':'server-desktop-setup.png')});
   await page.getByRole('button',{name:'설정 완료 · 기존 화면 열기',exact:true}).click();await page.locator('[data-testid=setup-assistant]').waitFor({state:'detached'});
   await page.reload();await page.waitForTimeout(800);assert.equal(await page.locator('[data-testid=setup-assistant]').count(),0);assert.deepEqual(errors,[]);
   await ctx.close();
  }
  // Real Electron: selecting Server retains the existing login flow with Local also available.
  const home=fs.mkdtempSync(path.join(path.dirname(shots),'server-native-'));
  app=new App(home,9873,10373);app.start();let page=await app.page(/connect\.html/);
  await until('server form',()=>page.eval('!!document.getElementById("modeServer")'));
  await page.eval(fill(server,'admin',password));
  page=await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login|\\?surface)'),30000);
  await until('server assistant',()=>page.eval('!!document.querySelector("[data-testid=setup-assistant]")'));
  const cfg=await page.eval('fetch("/api/config").then(r=>r.json())');assert.equal(cfg.execution_mode,'server');
  await page.eval('window.hrhNative.switchServer()');page=await app.page(/connect\.html/);
  await until('local tab',()=>page.eval('!!document.getElementById("modeLocal")'));
  await page.eval('document.getElementById("modeLocal").click();document.getElementById("go").click()');
  page=await app.page(/^http:\/\/127\.0\.0\.1:\d+\/(?!\?surface|login)/,65000);
  await until('local config',()=>page.eval('fetch("/api/config").then(r=>r.json()).then(c=>c.execution_mode==="local")'));
  const localOrigin=await page.eval('location.origin');
  const localSession=await page.eval(`fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'claude',workspace_path:${JSON.stringify(workspace)},title:'LOCAL-ISOLATION-TEST'})}).then(r=>r.json())`);
  assert.ok(localSession.id);
  await page.eval('window.hrhNative.switchServer()');page=await app.page(/connect\.html/);
  await until('server return form',()=>page.eval('!!document.getElementById("modeServer")'));
  assert.equal(await page.eval('document.getElementById("server").value'),server);
  await page.eval(fill(server,'admin',password));
  page=await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login|\\?surface)'),30000);
  assert.equal(await page.eval(`fetch('/api/sessions').then(r=>r.json()).then(s=>s.some(x=>x.id===${JSON.stringify(localSession.id)}))`),false);
  await until('local backend stopped on server switch',async()=>{try{await fetch(localOrigin+'/health');return false;}catch{return true;}},7000);
  await page.eval('window.hrhNative.switchServer()');page=await app.page(/connect\.html/);
  await until('local restart form',()=>page.eval('!!document.getElementById("modeLocal")'));
  await page.eval('document.getElementById("modeLocal").click();document.getElementById("go").click()');
  page=await app.page(/^http:\/\/127\.0\.0\.1:\d+\/(?!\?surface|login)/,65000);
  await until('local data survived switch',()=>page.eval(`fetch('/api/sessions').then(r=>r.json()).then(s=>s.some(x=>x.id===${JSON.stringify(localSession.id)}))`));
  console.log('SERVER_SETUP_DESKTOP_MOBILE_AND_NATIVE_OK; LOCAL_SERVER_SWITCH_AND_DATA_ISOLATION_OK');
 }finally{if(app)await app.stop();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
