'use strict';
// Runs the real packaged interpreter/API, without an installed Python, node CLI, model account or Geny server.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {spawn}=require('child_process');
const {createLocalRuntime}=require('../src/local-runtime');
const root=path.resolve(process.argv[2]||'local-runtime');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'geny-local-smoke-'));
const fixture=path.join(temp,'fixture-cli.py');
fs.writeFileSync(fixture,'import sys,json\nif "--version" in sys.argv: print("0.0.1 (local smoke fixture)")\nelse: print(json.dumps({"loggedIn":False})); sys.exit(1)\n');
fs.chmodSync(fixture,0o755);
let cookie,logs='';
const rt=createLocalRuntime({root,dataDir:path.join(temp,'state'),cookies:{set:async c=>cookie=c},log:m=>logs+=m+'\n',
 spawnProcess:(exe,args,o)=>spawn(exe,args,{...o,env:{...o.env,HOME:temp,USERPROFILE:temp,CLAUDE_BINARY:fixture,PLAN_USAGE_FETCH:'false',CLI_UPDATE_CHECK:'false',MONITOR_ENABLED:'false',MATE_SEARCH_ROOTS:temp}})});
(async()=>{try{
 const {origin}=await rt.start();assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
 assert.equal(cookie.name,'hrh_session');assert.equal(cookie.httpOnly,true);
 const api=async(route,options={})=>{const r=await fetch(origin+route,{...options,headers:{Authorization:'Bearer '+cookie.value,...options.headers}});return {status:r.status,data:await r.json()};};
 assert.equal((await fetch(origin+'/health')).status,200);
 assert.equal((await api('/api/config')).data.execution_mode,'local');
 const setup=await api('/api/setup');assert.equal(setup.status,200);assert.deepEqual(setup.data.tools.map(t=>t.id),['claude','codex']);
 assert.equal(setup.data.tools[0].installed,true);assert.match(setup.data.tools[0].version,/0\.0\.1/);
 assert.equal((await api('/api/local/bootstrap',{method:'POST'})).status,403);
 assert.ok(fs.existsSync(path.join(temp,'state/geny.db')));
 await rt.stop();await assert.rejects(fetch(origin+'/health'));
 console.log('LOCAL_RUNTIME_SMOKE_OK '+JSON.stringify({platform:process.platform,arch:process.arch,local:true,tools:setup.data.tools.map(({id,installed})=>({id,installed})),quit:true}));
 }catch(e){console.error(logs);throw e;}finally{rt.stopNow();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
