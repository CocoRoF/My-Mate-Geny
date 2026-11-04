'use strict';
const {chromium}=require('playwright-core');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const [server,password,workspace,shots]=process.argv.slice(2);
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME,headless:true,args:['--no-sandbox']});
 try{
  for(const target of ['sidebar','account']){
   const ctx=await browser.newContext();await ctx.addInitScript(()=>{localStorage.setItem('hrh_setup_completed_v1','1');localStorage.setItem('hrh_lang','ko');});
   const r=await ctx.request.post(server+'/api/auth/login',{data:{username:'admin',password}});assert.equal(r.status(),200);
   const page=await ctx.newPage();await page.goto(server+(target==='account'?'/?view=settings&tab=account':'/'));
   await page.locator(target==='account'?'[data-testid=settings-signout]':'[data-testid=nav-signout]').click();
   await page.waitForURL('**/login');await page.locator('#u').waitFor();await page.locator('#p').waitFor();assert.equal(await page.evaluate('!!window.hrhNative'),false);
   await page.screenshot({path:path.join(shots,'browser-'+target+'-logout.png')});await ctx.close();
  }
  console.log('BROWSER_LOGOUT_LOGIN_FORM_PRESERVED: sidebar and account');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
