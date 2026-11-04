// Real Electron + real isolated API. Numeric task fixtures only, no model calls.
const { App, fill, until, sleep } = require('../../../desktop/test/e2e/screen-capture-e2e');
const { chromium } = require('playwright-core');
const { execFileSync } = require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [server,password,workspace]=process.argv.slice(2),shots=process.env.SCREEN_SHOTS;
const before=process.env.PANEL_BASELINE==='1';
const seed=String.raw`
import os,sqlite3,json,sys,datetime
sid=json.load(sys.stdin)['sid'];db=sqlite3.connect(os.environ['DB_PATH']);base=datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=1)
for turn in range(8):
 at=base+datetime.timedelta(seconds=turn*1000)
 db.execute('INSERT INTO messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)',(sid+'-m'+str(turn),sid,'user','Fixture turn '+str(turn),at.isoformat()))
 for job in range(150):
  stamp=at+datetime.timedelta(seconds=job+1)
  db.execute('INSERT INTO bg_tasks(session_id,task_id,description,task_type,status,started_at,ended_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',(sid,f't{turn}-{job:03}',f'Turn {turn} task {job:03}','local_bash','completed',stamp.timestamp(),stamp.timestamp()+1,stamp.isoformat()))
db.execute('INSERT INTO bg_tasks(session_id,task_id,description,task_type,status,started_at,updated_at) VALUES(?,?,?,?,?,?,?)',(sid,'old-running','Older turn still running','local_bash','running',base.timestamp(),base.isoformat()))
db.commit()
`;
(async()=>{
 const app=new App(path.join(process.env.SCREEN_TEST_ROOT,'panel-profile'),9690,10190);let browser;
 try{
  for(let i=0;i<150;i++)fs.writeFileSync(path.join(workspace,`file-${String(i).padStart(3,'0')}.txt`),'fixture');
  app.start();const connect=await app.page(/connect\.html/);await until('connect',()=>connect.eval('!!window.hrhConnect'));await connect.eval(fill(server,'admin',password));
  await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)(?!\\?surface=)'));
  browser=await chromium.connectOverCDP('http://127.0.0.1:9690');const ctx=browser.contexts()[0];
  const page=ctx.pages().find(p=>p.url().startsWith(server)&&!p.url().includes('surface='));
  let taskRequests=[],outputs=0,fsRequests=0;
  page.on('request',r=>{if(/\/tasks(?:\/page)?(?:\?|$)/.test(r.url()))taskRequests.push(r.url());if(/\/output/.test(r.url()))outputs++;if(/\/api\/fs\//.test(r.url()))fsRequests++;});
  const response=await ctx.request.post(server+'/api/sessions',{data:{provider:'claude',model:'haiku',connection_id:null,workspace_path:workspace,title:before?'Before sidebar':'Stable sidebar'}});assert(response.ok());const session=await response.json();
  execFileSync('/tmp/hrh-test-venv/bin/python',['-c',seed],{input:JSON.stringify({sid:session.id}),env:process.env});
  await page.evaluate(()=>{localStorage.setItem('hrh_lang','ko');localStorage.setItem('hrh_workbench_v1',JSON.stringify({version:1,state:{bySession:{},explorerOpen:false,explorerWidth:418,showHidden:false,pinnedRoots:{},expanded:{}}}));});
  await page.goto(server+'/?view=chat&session='+session.id);await page.getByTestId('topbar').waitFor();
  await page.locator('[data-topbar-item=tasks]').click();
  if(before){
   await until('legacy 1000 tasks',()=>page.locator('[class*="rounded-xl"]').filter({hasText:'Turn '}).count().then(n=>n>=1000));
   await page.screenshot({path:path.join(shots,'tasks-before.png')});
  }else{
   await until('first bounded tasks',()=>page.getByTestId('task-row').count().then(n=>n===51));
   assert(!await page.getByTestId('tasks-list').textContent().then(t=>t.includes('Turn 5 task')));
   assert(taskRequests.every(url=>url.includes('/tasks/page')),'must not fetch legacy 1000-row task list');
   assert.equal(outputs,0,'collapsed outputs must remain lazy');
   await page.screenshot({path:path.join(shots,'tasks-after.png')});
   const count=taskRequests.length;await sleep(250);assert.equal(taskRequests.length,count,'no automatic older page fetch');
   await page.getByTestId('tasks-more').click();await until('second bounded page',()=>page.getByTestId('task-row').count().then(n=>n===101));
   for(let n=0;n<5;n++){await page.getByTestId('tasks-more').click();await until('page '+n,()=>page.getByTestId('tasks-more').isEnabled());}
   assert((await page.getByTestId('tasks-list').textContent()).includes('Turn 5 task'));
   await page.getByTestId('task-row').filter({hasText:'Turn 5 task'}).first().locator('button').first().click();
   await until('one output loaded',()=>outputs===1);
   console.log('Latest 2 turns, 50-row cap, pinned running work, explicit older pages and lazy output: OK');
  }
  await page.keyboard.press('Escape');
  if(await page.locator('[data-topbar-item=panel]').getAttribute('aria-pressed')!=='true') await page.locator('[data-topbar-item=panel]').click();
  if(!before) await until('session panel',()=>page.locator('[data-testid=right-sidebar][data-panel=session]').isVisible());
  const panelWidth=await page.getByTestId('topbar').evaluate(el=>el.getBoundingClientRect().width);
  await page.screenshot({path:path.join(shots,'panel-'+(before?'before':'after')+'.png')});
  if(before){
    await page.locator('[data-topbar-item=explorer]').click();await sleep(500);
    const explorerWidth=await page.getByTestId('topbar').evaluate(el=>el.getBoundingClientRect().width);
    console.log('BASELINE main area widths',{panelWidth,explorerWidth});
    await page.screenshot({path:path.join(shots,'explorer-before.png')});
  }else{
    const workspaceSection=page.getByTestId('session-panel').locator('section').first();
    await workspaceSection.locator('button').first().click();
    assert.equal(await workspaceSection.locator(':scope > div').count(),1);
    // Keep a reference and sample EVERY animation frame, including transitions.
    await page.evaluate(()=>{window.__shell=document.querySelector('[data-testid=right-sidebar]');window.__sizes=[];window.__sampling=true;const sample=()=>{if(!window.__sampling)return;window.__sizes.push([window.__shell.isConnected,window.__shell.getBoundingClientRect().width,document.querySelector('[data-testid=topbar]').getBoundingClientRect().width]);requestAnimationFrame(sample)};sample();});
    await page.locator('[data-topbar-item=explorer]').click();await page.getByText('file-000.txt',{exact:true}).waitFor();
    const directoryCalls=fsRequests;
    const scroll=page.locator('[data-testid=explorer-panel] .overflow-y-auto').first();await scroll.evaluate(el=>el.scrollTop=200);
    for(let n=0;n<8;n++){await page.locator('[data-topbar-item=panel]').click();await page.locator('[data-topbar-item=explorer]').click();}
    assert(await scroll.evaluate(el=>el.scrollTop)>=190,'tree scroll position must survive switching');
    await sleep(200);assert.equal(fsRequests,directoryCalls,'switching cached explorer must not refetch folders');
    await page.locator('[data-topbar-item=panel]').click();
    assert.equal(await workspaceSection.locator(':scope > div').count(),1,'collapsed sections survive switching');
    await page.locator('[data-topbar-item=explorer]').click();
    await page.screenshot({path:path.join(shots,'explorer-after.png')});
    const frames=await page.evaluate(()=>{window.__sampling=false;return window.__sizes});
    assert(frames.every(f=>f[0]&&f[1]===418&&Math.abs(f[2]-panelWidth)<1),'no shell removal, width jump or squeezed chat frame');
    await page.locator('[data-testid=right-sidebar] [role=separator]').focus();await page.keyboard.press('ArrowLeft');
    await page.locator('[data-topbar-item=panel]').click();
    assert.equal(await page.getByTestId('right-sidebar').evaluate(el=>el.getBoundingClientRect().width),438);
    await page.screenshot({path:path.join(shots,'panel-resized.png')});
    await page.reload();await page.getByTestId('topbar').waitFor();assert.equal(await page.getByTestId('right-sidebar').evaluate(el=>el.getBoundingClientRect().width),438);
    console.log('Persistent sidebar shell, 418px width in both views, keyboard resize and refresh persistence: OK; sampled frames='+frames.length);
    await page.setViewportSize({width:390,height:844});await page.getByTestId('right-sidebar-backdrop').click({position:{x:3,y:200},force:true});await page.locator('[data-topbar-item=explorer]').click();
    assert((await page.getByTestId('right-sidebar').boundingBox()).y>=36,'drawer header must clear native title bar');
    await page.screenshot({path:path.join(shots,'sidebar-phone.png')});
    assert((await page.getByTestId('right-sidebar').boundingBox()).width<=390*.92+1);
    await page.getByTestId('right-sidebar-backdrop').click({position:{x:3,y:200},force:true});await until('mobile drawer closes',()=>page.getByTestId('right-sidebar').isHidden());
    console.log('Mobile drawer width, backdrop close and shared content: OK');
  }
  console.log(before?'BASELINE TASKS SIDEBAR CAPTURED':'TASKS SIDEBAR E2E OK');
 }finally{await app.stop();if(browser)await browser.close().catch(()=>{});}
})().catch(e=>{console.error(e);process.exit(1)});
