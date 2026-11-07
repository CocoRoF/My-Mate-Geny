// The native main process owns the loopback backend. The renderer never sees its launch secret.
'use strict';
const fs=require('fs'), path=require('path'), http=require('http'), crypto=require('crypto');
const {spawn,spawnSync}=require('child_process');
function request(origin,route,secret){return new Promise((resolve,reject)=>{
  const req=http.request(origin+route,{method:'POST',headers:{'x-geny-local-bootstrap':secret},timeout:5000},res=>{
    let data='';res.on('data',b=>{data+=b;if(data.length>65536)req.destroy(new Error('oversized runtime response'));});
    res.on('end',()=>{try{if(res.statusCode!==200)throw new Error(`Local runtime HTTP ${res.statusCode}`);resolve(JSON.parse(data));}catch(e){reject(e);}});
  });req.on('timeout',()=>req.destroy(new Error('Local runtime did not respond')));req.on('error',reject);req.end();
});}
function guiEnv(base=process.env){
  const home=base.HOME||base.USERPROFILE||require('os').homedir();
  const dirs=[path.join(home,'.local','bin'),path.join(home,'.cargo','bin'),'/opt/homebrew/bin','/usr/local/bin'];
  if(base.LOCALAPPDATA)dirs.unshift(path.join(base.LOCALAPPDATA,'Programs','OpenAI','Codex','bin'));
  if(base.APPDATA)dirs.push(path.join(base.APPDATA,'npm'));
  const env={...base,PATH:[...dirs,base.PATH||''].join(path.delimiter),PYTHONNOUSERSITE:'1',PYTHONUNBUFFERED:'1'};
  for(const k of ['PYTHONHOME','PYTHONPATH','VIRTUAL_ENV','__PYVENV_LAUNCHER__'])delete env[k];
  return env;
}
function createLocalRuntime({root,dataDir,cookies,log=()=>{},onCrash=()=>{},preferredPort=()=>0,spawnProcess=spawn,timeout=60000}){
  let child=null,origin='',secret='',pending=null,stopping=false,generation=0;
  const manifest=()=>JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  function available(){try{const m=manifest();return m.format===1&&fs.existsSync(path.join(root,m.python));}catch{return false;}}
  function force(proc=child){
    if(!proc?.pid)return;
    if(process.platform==='win32')spawnSync('taskkill',['/pid',String(proc.pid),'/t','/f'],{windowsHide:true,timeout:2500,stdio:'ignore'});
    else{
      // Providers can create separate process groups. Kill descendants before their parent disappears.
      try{const m=manifest();spawnSync(path.join(root,m.python),['-c',
        'import psutil,sys\np=psutil.Process(int(sys.argv[1]))\nfor c in reversed(p.children(recursive=True)):\n try:c.kill()\n except psutil.NoSuchProcess:pass\np.kill()',String(proc.pid)],
        {timeout:1800,stdio:'ignore',env:{...guiEnv(),...(process.platform==='darwin'?{PYTHONDONTWRITEBYTECODE:'1'}:{})}});}catch{}
      try{process.kill(-proc.pid,'SIGKILL');}catch{try{proc.kill('SIGKILL');}catch{}}}
  }
  async function stop(){
    stopping=true;++generation;
    const proc=child,old=origin,key=secret; origin='';secret='';child=null;
    if(proc){
      if(old)await request(old,'/api/local/shutdown',key).catch(()=>{});else force(proc);
      await Promise.race([new Promise(r=>proc.exitCode!==null?r():proc.once('exit',r)),new Promise(r=>setTimeout(r,1800))]);
      if(proc.exitCode===null)force(proc);
    }
    // Wait for a cancelled startup promise to settle before permitting another launch.
    const p=pending;if(p)await p.catch(()=>{});
  }
  function stopNow(){stopping=true;++generation;force();child=null;origin='';secret='';}
  async function start(){
    if(origin&&child?.exitCode===null)return {origin};
    if(pending)return pending;
    stopping=false;const epoch=++generation;
    pending=(async()=>{
      if(!available())throw new Error('The local runtime is missing. Install the complete My Mate Geny desktop package.');
      const m=manifest();secret=crypto.randomBytes(32).toString('hex');
      const proc=spawnProcess(path.join(root,m.python),[path.join(root,m.backend),'--port',String(preferredPort()||0),'--data-dir',dataDir,'--static-dir',path.join(root,m.web)],
        {cwd:root,env:{...guiEnv(),...(process.platform==='darwin'?{PYTHONDONTWRITEBYTECODE:'1'}:{}),LOCAL_BOOTSTRAP_SECRET:secret,GENY_NATIVE_PARENT_PID:String(process.pid)},
         detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe']});
      child=proc;let ready=false;
      proc.stderr.on('data',b=>log(String(b).slice(-3000)));
      const address=await new Promise((resolve,reject)=>{
        let buffer='';const timer=setTimeout(()=>{force(proc);reject(new Error('Local startup timed out. Check the local runtime log and retry.'));},timeout);
        const fail=e=>{clearTimeout(timer);reject(e);};
        proc.once('error',fail);proc.once('exit',(code,signal)=>{if(!ready)fail(new Error(`Local runtime stopped before startup (${code??signal})`));else if(!stopping&&epoch===generation){origin='';child=null;onCrash(`Local runtime stopped (${code??signal}). Reopen Local execution to restart.`);}});
        proc.stdout.on('data',b=>{
          buffer+=b.toString();let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
            if(line.startsWith('GENY_LOCAL_READY ')){try{const {port}=JSON.parse(line.slice(17));if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid local port');ready=true;clearTimeout(timer);resolve(`http://127.0.0.1:${port}`);}catch(e){fail(e);}}
            else log(line.slice(-2000));
          }if(buffer.length>65536)buffer=buffer.slice(-65536);
        });
      });
      if(stopping||epoch!==generation)throw new Error('Local start cancelled');
      const auth=await request(address,'/api/local/bootstrap',secret);
      if(stopping||epoch!==generation)throw new Error('Local start cancelled');
      await cookies.set({url:address,name:auth.name,value:auth.token,httpOnly:true,secure:false,sameSite:'strict',path:'/',expirationDate:Date.now()/1000+auth.expires});
      if(stopping||epoch!==generation)throw new Error("Local start cancelled");
      origin=address;return {origin};
    })().catch(e=>{force(child);child=null;origin='';throw e;}).finally(()=>{pending=null;});
    return pending;
  }
  return {available,start,stop,stopNow,origin:()=>origin,manifest};
}
module.exports={createLocalRuntime,guiEnv};
