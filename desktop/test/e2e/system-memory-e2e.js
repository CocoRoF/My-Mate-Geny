// Actual Electron UI and kernel-backed monitor in an isolated backend; no mocked memory values.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {App,fill,until,sleep}=require('./screen-capture-e2e');
const [server,password,workspace,shots]=process.argv.slice(2),before=process.env.MEMORY_BEFORE==='1';
const app=new App(fs.mkdtempSync(path.join(os.tmpdir(),'geny-memory-')),9670,10170);
(async()=>{try{
 app.start();const login=await app.page(/connect\.html/);await until('connect',()=>login.eval('!!window.hrhConnect'));await login.eval(fill(server,'admin',password));
 const con=await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)(?!\\?surface=)'));
 await con.eval("localStorage.setItem('hrh_lang','ko');localStorage.setItem('hrh_theme','dark');location.href='/?view=settings&tab=admin';true");
 await until('system tab',()=>con.eval("[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='시스템')"));
 await con.eval("[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='시스템').click(),true");
 await until('real memory',()=>con.eval("fetch('/api/admin/system/now').then(r=>r.json()).then(s=>s.mem.total>0)"));await sleep(2200);
 const snapshot=await con.eval("fetch('/api/admin/system/now').then(r=>r.json())");
 assert.equal(snapshot.mem.occupied,snapshot.mem.total-snapshot.mem.free);assert.equal(snapshot.mem.non_cache+snapshot.mem.cache+snapshot.mem.free,snapshot.mem.total);
 assert.equal(snapshot.m.mem_occupied,snapshot.mem.occupied);
 if(!before){await until('host explanation',()=>con.eval("!!document.querySelector('[data-testid=host-memory-summary]')"));assert.equal(await con.eval("document.body.innerText.includes('서버 메모리 · 캐시 포함')"),true);assert.equal(await con.eval("document.body.innerText.includes('Geny 프로세스 RSS 합산')"),true);}
 await app.main("cwin().setBounds({x:0,y:0,width:1500,height:1080});return true");
 const r=await con.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shots,before?'memory-before.png':'memory-after.png'),Buffer.from(r.data,'base64'));
 fs.writeFileSync(path.join(shots,'memory-snapshot.json'),JSON.stringify({mem:snapshot.mem,genyRss:snapshot.m.tree_rss,cgroup:snapshot.cgroup,host:snapshot.host},null,2));
 console.log('PASS kernel memory equations: total = non-cache occupancy + cache + unused; Geny RSS shown separately; OS availability labelled as estimate');
 console.log(JSON.stringify({total:snapshot.mem.total,occupied:snapshot.mem.occupied,cache:snapshot.mem.cache,unused:snapshot.mem.free,available:snapshot.mem.available,genyRss:snapshot.m.tree_rss}));
 console.log('SYSTEM MEMORY E2E OK');
}finally{await app.stop();}})().catch(e=>{console.error(e);process.exitCode=1;});
