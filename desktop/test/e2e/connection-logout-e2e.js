'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {App,until,fill,sleep}=require('./screen-capture-e2e');
const [server,password,workspace,shots]=process.argv.slice(2),baseline=process.env.LOGOUT_BASELINE==='1';
fs.mkdirSync(shots,{recursive:true});
let app;const results={};
const consoleRe=new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login|\\?surface)');
async function screenshot(page,name){const r=await page.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shots,name),Buffer.from(r.data,'base64'));}
async function chooser(){const p=await app.page(/connect\.html/);await until('mode chooser',()=>p.eval('!!document.getElementById("modeLocal")&&!!document.getElementById("modeServer")'));return p;}
async function login(){const p=await chooser();await p.eval(fill(server,'admin',password));const page=await app.page(consoleRe);await until('native bridge',()=>page.eval('!!window.hrhNative?.signOut'));await page.eval('window.hrhNative.setup?.complete()');return page;}
(async()=>{try{
 const home=fs.mkdtempSync(path.join(path.dirname(shots),'logout-native-'));
 app=new App(home,9876,10376);app.start();let page=await login();
 await screenshot(page,'before-logout.png');
 if(process.env.LOGOUT_NATIVE_GUARD==='1')await app.main(`const ses=require('electron').session.defaultSession;const original=ses.fetch.bind(ses);ses.fetch=async(url,options)=>{if(String(url).endsWith('/api/auth/logout'))await new Promise(r=>setTimeout(r,400));return original(url,options);};return true;`);
 await page.eval('(()=>{const b=document.querySelector("[data-testid=nav-signout]")||Array.from(document.querySelectorAll("button")).find(b=>/^(Log out|Sign out|로그아웃)$/.test(b.title));if(!b)throw Error("No sidebar sign-out");b.click();})()');
 if(baseline){page=await app.page(/\/login/);await until('web login form',()=>page.eval('!!document.getElementById("u")&&!!document.getElementById("p")'));await screenshot(page,'baseline-web-login-trap.png');results.reproduced=true;results.version=await app.main('return require("electron").app.getVersion();');console.log(JSON.stringify(results));return;}
 page=await chooser();await screenshot(page,'after-sidebar-logout-chooser.png');assert.equal(await page.eval('document.getElementById("server").value'),server);assert.equal(await page.eval('document.getElementById("password").value'),'');results.sidebar=true;
 page=await login();await app.main(`await cwin().loadURL(${JSON.stringify(server+'/?view=settings&tab=account')});`);page=await app.page(consoleRe);await until('account sign-out',()=>page.eval('!!document.querySelector("[data-testid=settings-signout]")'));
 await page.eval('document.querySelector("[data-testid=settings-signout]").click()');await chooser();results.account=true;
 if(process.env.LOGOUT_NATIVE_GUARD==='1'){
  page=await login();await app.main(`const ses=require('electron').session.defaultSession;const list=await ses.cookies.get({url:${JSON.stringify(server)}});for(const c of list)await ses.cookies.remove(${JSON.stringify(server)}+(c.path||'/'),c.name);await cwin().loadURL(${JSON.stringify(server+'/login')}).catch(()=>{});`);await chooser();results.directLoginRecovery=true;
  page=await login();await app.main(`const ses=require('electron').session.defaultSession;const list=await ses.cookies.get({url:${JSON.stringify(server)}});for(const c of list)await ses.cookies.remove(${JSON.stringify(server)}+(c.path||'/'),c.name);cwin().reload();`);await chooser();results.expiredSessionRecovery=true;
 }
 page=await chooser();await page.eval('document.getElementById("modeLocal").click();document.getElementById("go").click()');
 page=await app.page(/^http:\/\/127\.0\.0\.1:\d+\/(?!\?surface|login)/,65000);
 await until('local execution',()=>page.eval('fetch("/api/config").then(r=>r.json()).then(c=>c.execution_mode==="local")'));results.localWithoutServerLogin=true;
 await page.eval('window.hrhNative.setup?.complete()');await page.eval('location.reload()');await until('local sidebar',()=>page.eval('!!document.querySelector("[data-testid=nav-signout]")||Array.from(document.querySelectorAll("button")).some(b=>/^(Log out|Sign out|로그아웃)$/.test(b.title))'));
 const localOrigin=await page.eval('location.origin');
 await page.eval('(()=>{const b=document.querySelector("[data-testid=nav-signout]")||Array.from(document.querySelectorAll("button")).find(b=>/^(Log out|Sign out|로그아웃)$/.test(b.title));b.click();})()');await chooser();await until('owned local backend stopped',async()=>{try{await fetch(localOrigin+'/health');return false;}catch{return true;}},8000);results.localLogout=true;
 page=await login();assert.equal(await page.eval('fetch("/api/config").then(r=>r.json()).then(c=>c.execution_mode)'),'server');results.returnToServer=true;
 if(process.env.LOGOUT_NATIVE_GUARD==='1'){
  await app.stop();
  const hiddenHome=fs.mkdtempSync(path.join(path.dirname(shots),'logout-hidden-'));
  fs.mkdirSync(path.join(hiddenHome,'.config/hr-harnessor'),{recursive:true});
  fs.writeFileSync(path.join(hiddenHome,'.config/hr-harnessor/settings.json'),JSON.stringify({serverUrl:server,lastServer:server,launchMode:'server',connectMigrated:true}));
  app=new App(hiddenHome,9877,10377);app.start(['--hidden']);
  await until('hidden start menu',()=>app.main(`return !!require('electron').Menu.getApplicationMenu();`));
  await app.main(`const menu=require('electron').Menu.getApplicationMenu();const item=menu.items.flatMap(x=>x.submenu?.items||[]).find(x=>/Sign out|로그아웃/.test(x.label));if(!item)throw Error('Sign-out menu missing');await item.click();return true;`);
  await chooser();assert.equal(await app.main('return cwin().isVisible();'),true);assert.equal(app.proc.exitCode,null);results.hiddenStartLogout=true;
 }
 console.log(JSON.stringify(results));fs.writeFileSync(path.join(shots,'logout-results.json'),JSON.stringify(results,null,2));
 }catch(e){if(app){fs.writeFileSync(path.join(shots,'electron.log'),app.out||'');try{const targets=await app.targets();const t=targets.find(t=>!t.url.includes('surface='));if(t){const p=await app.page(new RegExp(t.url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));await screenshot(p,'failure.png');}}catch{}}throw e;}
 finally{if(app)await app.stop();}
})().catch(e=>{console.error(e);process.exitCode=1;});
