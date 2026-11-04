// Real Electron, real backend task API, real SSH/MCP bridge; no model calls.
const {App,fill,until,sleep}=require('../../../desktop/test/e2e/screen-capture-e2e');
const {chromium}=require('playwright-core');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [server,password,workspace]=process.argv.slice(2),shots=process.env.SCREEN_SHOTS;
const launch=String.raw`
import os,json,pathlib,subprocess,sys
args=json.load(sys.stdin)
h=dict(next(h for h in json.loads(pathlib.Path('/home/hrjang/.cache/hrh-verify/ssh-job-test-hosts.json').read_text()) if int(h['port'])==2224))
fixture=pathlib.Path(pathlib.Path('/home/hrjang/.cache/hrh-verify/ssh-long-latest').read_text());remote=json.loads((fixture/'context.json').read_text())['remote']
h.update(cwd=remote,roots=[remote],job_root=remote+'/ui-jobs',control_path=str(pathlib.Path(os.environ['SCREEN_TEST_ROOT'])/'ctl'))
root=str(pathlib.Path(os.environ['DB_PATH']).with_suffix('.remote-jobs'))
env={**os.environ,'HRH_REMOTE_HOSTS':json.dumps([h]),'HRH_REMOTE_JOBS_ROOT':root,'HRH_REMOTE_SESSION_ID':args['sid']}
command='echo UI-START; sleep 10; echo UI-END' if args['kind']=='finish' else 'echo STOP-TARGET; trap "" TERM; sleep 20 & wait'
messages=[{'jsonrpc':'2.0','id':1,'method':'initialize'}, {'jsonrpc':'2.0','id':2,'method':'tools/list'}, {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'remote_bash','arguments':{'command':command,'description':'SSH UI '+args['kind'],'yield_time_ms':100}}}]
r=subprocess.run([sys.executable,'app/workspaces/mcp_remote_bridge.py'],input=''.join(json.dumps(m)+'\n' for m in messages),text=True,capture_output=True,env=env,timeout=20)
assert r.returncode==0,r.stderr
rows=[json.loads(s) for s in r.stdout.splitlines()];tools=rows[1]['result']['tools'];assert any(t['name']=='remote_poll' for t in tools)
result=rows[2]['result'];assert not result['isError'],result
print(json.loads(result['content'][0]['text'])['job_id'])
`;
const inspect=String.raw`
import json,pathlib,os,sys
from app.workspaces.remote_jobs import RemoteJobs
args=json.load(sys.stdin);c=RemoteJobs(pathlib.Path(os.environ['DB_PATH']).with_suffix('.remote-jobs'),args['sid']);m=c.manifest(args['id']);r=c.poll(m);print(json.dumps({'status':r['status'],'process_group_alive':r.get('process_group_alive')}))
`;
(async()=>{
 const app=new App(path.join(process.env.SCREEN_TEST_ROOT,'ssh-ui-profile'),9695,10195);let browser,sid;
 const run=(source,data)=>execFileSync('/tmp/hrh-test-venv/bin/python',['-c',source],{input:JSON.stringify(data),env:{...process.env,PYTHONPATH:'.'},cwd:'/home/hr-harnessor/backend',encoding:'utf8'}).trim();
 try{
  app.start();const connect=await app.page(/connect\.html/);await until('connect',()=>connect.eval('!!window.hrhConnect'));await connect.eval(fill(server,'admin',password));
  await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)(?!\\?surface=)'));
  browser=await chromium.connectOverCDP('http://127.0.0.1:9695');const ctx=browser.contexts()[0];
  const page=ctx.pages().find(p=>p.url().startsWith(server)&&!p.url().includes('surface='));
  const resp=await ctx.request.post(server+'/api/sessions',{data:{provider:'claude',model:'haiku',connection_id:null,workspace_path:workspace,title:'SSH command lifecycle'}});assert(resp.ok());sid=(await resp.json()).id;
  await page.evaluate(()=>localStorage.setItem('hrh_lang','ko'));await page.goto(server+'/?view=chat&session='+sid);await page.getByTestId('topbar').waitFor();
  const finishId=run(launch,{sid,kind:'finish'});await page.locator('[data-topbar-item=tasks]').click();
  const row=page.getByTestId('task-row').filter({hasText:'SSH UI finish'});await row.waitFor();
  await row.locator('button').first().click();await until('live SSH output',()=>row.locator('pre').textContent().then(t=>t.includes('UI-START')));
  await page.screenshot({path:path.join(shots,'remote-running.png')});
  await until('complete SSH output',async()=>await row.locator('pre').count() && (await row.locator('pre').textContent()).includes('UI-END'),20000);
  assert.equal(JSON.parse(run(inspect,{sid,id:finishId})).status,'completed');
  await page.screenshot({path:path.join(shots,'remote-completed.png')});
  const stopId=run(launch,{sid,kind:'stop'});const stopRow=page.getByTestId('task-row').filter({hasText:'SSH UI stop'});await stopRow.waitFor();
  await stopRow.locator('button[aria-label]').click();
  await until('SSH process group stopped',async()=>JSON.parse(run(inspect,{sid,id:stopId})).status==='stopped',15000);
  const state=JSON.parse(run(inspect,{sid,id:stopId}));assert.equal(state.process_group_alive,false);
  await until('UI stopped state',()=>stopRow.textContent().then(t=>t.includes('중지됨')));
  await page.screenshot({path:path.join(shots,'remote-stopped.png')});
  console.log('REAL SSH MCP: job ID survives bridge exit; live output, completion, UI stop, child process group cleanup: OK');
 }finally{
  if(sid){try{run(String.raw`import json,os,pathlib,sys
from app.workspaces.remote_jobs import RemoteJobs
sid=json.load(sys.stdin)['sid'];root=pathlib.Path(os.environ['DB_PATH']).with_suffix('.remote-jobs');c=RemoteJobs(root,sid)
for file in c.root.glob('*/manifest.json'):
 m=json.loads(file.read_text());c.stop(m);c.purge(m)
`,{sid})}catch(e){console.error('fixture cleanup failed',e.message)}}
  await app.stop();if(browser)await browser.close().catch(()=>{});
 }
})().catch(e=>{console.error(e);process.exit(1)});
