'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {createLocalRuntime,guiEnv}=require('../src/local-runtime');
test('GUI PATH retains user CLI discovery and real HOME',()=>{const env=guiEnv({HOME:'/users/example',PATH:'/system/bin',LOCALAPPDATA:'/local',APPDATA:'/roam'});assert.ok(env.PATH.includes(path.join('/users/example','.local','bin')));assert.ok(env.PATH.includes(path.join('/local','Programs','OpenAI','Codex','bin')));assert.equal(env.HOME,'/users/example');});
test('missing runtime is a visible failure; no cookies are set',async()=>{const runtime=createLocalRuntime({root:'/missing/local-geny-runtime',dataDir:'/unused',cookies:{set:()=>assert.fail()}});assert.equal(runtime.available(),false);await assert.rejects(runtime.start(),/complete.*package/);});
test('readiness + native bootstrap + one owned process, no secret to renderer',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'geny-runtime-test-'));
 fs.writeFileSync(path.join(root,'python'),'fixture');fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({format:1,python:'python',backend:'main.py',web:'web'}));
 let secret='',spawned=0,seenCookie=null,child;
 const server=http.createServer((req,res)=>{assert.equal(req.headers['x-geny-local-bootstrap'],secret);res.end(JSON.stringify(req.url.endsWith('bootstrap')?{name:'hrh_session',token:'test-only',expires:600}:{ok:true}));if(req.url.endsWith('shutdown'))queueMicrotask(()=>{child.exitCode=0;child.emit('exit',0);});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.close();fs.rmSync(root,{recursive:true,force:true});});
 const runtime=createLocalRuntime({root,dataDir:root,cookies:{set:async c=>seenCookie=c},spawnProcess:(exe,args,opts)=>{
  spawned++;assert.equal(opts.env.HOME,process.env.HOME);secret=opts.env.LOCAL_BOOTSTRAP_SECRET;
  child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null});
  setImmediate(()=>child.stdout.write('GENY_LOCAL_READY '+JSON.stringify({port:server.address().port})+'\n'));return child;
 }});
 const [a,b]=await Promise.all([runtime.start(),runtime.start()]);assert.deepEqual(a,b);assert.equal(spawned,1);assert.deepEqual(Object.keys(a),['origin']);assert.equal(seenCookie.httpOnly,true);assert.equal(seenCookie.sameSite,'strict');await runtime.stop();assert.equal(runtime.origin(),'');
});
test('startup errors do not strand a pending start',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'geny-runtime-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'python'),'fixture');fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({format:1,python:'python',backend:'main.py',web:'web'}));
 let count=0;const rt=createLocalRuntime({root,cookies:{},spawnProcess:()=>{count++;const p=new EventEmitter();Object.assign(p,{stdout:new PassThrough(),stderr:new PassThrough()});setImmediate(()=>p.emit('error',new Error('fixture spawn failure')));return p;}});
 await assert.rejects(rt.start(),/fixture/);await assert.rejects(rt.start(),/fixture/);assert.equal(count,2);
});

test('cancel while cookie installation is pending cannot enter a dead local origin',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'geny-runtime-test-'));
 fs.writeFileSync(path.join(root,'python'),'fixture');fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({format:1,python:'python',backend:'main.py',web:'web'}));
 const server=http.createServer((_req,res)=>res.end(JSON.stringify({name:'hrh_session',token:'fixture',expires:60})));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.close();fs.rmSync(root,{recursive:true,force:true});});
 let release,reached;const waiting=new Promise(r=>reached=r);
 const rt=createLocalRuntime({root,dataDir:root,cookies:{set:()=>{reached();return new Promise(r=>release=r);}},spawnProcess:()=>{
  const p=new EventEmitter();Object.assign(p,{stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null});
  setImmediate(()=>p.stdout.write('GENY_LOCAL_READY '+JSON.stringify({port:server.address().port})+'\n'));return p;
 }});
 const started=rt.start();await waiting;rt.stopNow();release();await assert.rejects(started,/cancelled/);assert.equal(rt.origin(),'');
});
