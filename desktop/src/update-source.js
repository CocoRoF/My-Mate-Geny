"use strict";
// The desktop owns its release source. Neither a Geny server nor its session cookie is needed.
const http=require('http'),crypto=require('crypto'),{Readable}=require('stream'),{pipeline}=require('stream/promises');
const {execFile}=require('child_process');
const DEFAULT_REPOSITORY='https://github.com/CocoRoF/My-Mate-Geny';
function repository(value=DEFAULT_REPOSITORY){
  let u;try{u=new URL(String(value).trim());}catch{throw new Error('sourceInvalid');}
  const parts=u.pathname.replace(/\.git\/?$/,'').split('/').filter(Boolean);
  if(u.protocol!=='https:'||u.hostname!=='github.com'||u.port||u.username||u.password||u.search||u.hash||parts.length!==2||parts.some(x=>! /^[\w.-]+$/.test(x)||x==='.'||x==='..'))throw new Error('sourceInvalid');
  return `https://github.com/${parts.join('/')}`;
}
function classify(name){
  for(const [rx,platform,arch,kind,label] of [
    [/windows-x64-setup\.exe$/,'windows','x64','installer','Windows (x64)'],[/macos-arm64\.dmg$/,'macos','arm64','dmg','macOS · Apple Silicon'],
    [/macos-x64\.dmg$/,'macos','x64','dmg','macOS · Intel'],[/linux-x86_64\.AppImage$/,'linux','x64','appimage','Linux AppImage'],
    [/linux-amd64\.deb$/,'linux','x64','deb','Linux .deb'],[/\.apk$/,'android','universal','apk','Android APK']])if(rx.test(name))return {platform,arch,kind,label};
  return null;
}
function sourceError(code){return Object.assign(new Error(code),{code});}
function createUpdateSource({readSettings,writeSettings,safeStorage,fetcher=globalThis.fetch,apiBase='https://api.github.com',cliToken,now=Date.now}){
  let memoryToken='',cache=null,inflight=null,epoch=0,server=null,starting=null,cap=crypto.randomBytes(24).toString('hex'),base='',closed=false;
  let auth='none',cliCache=null;const controllers=new Set();
  function config(){let repo;try{repo=repository(readSettings().updateSource?.repository);}catch{repo=DEFAULT_REPOSITORY;}
    return {repository:repo,defaultRepository:DEFAULT_REPOSITORY,hasToken:!!(memoryToken||readSettings().updateSource?.encryptedToken),authentication:auth,tokenPersistent:!!readSettings().updateSource?.encryptedToken};}
  function encryption(){try{return !!safeStorage?.isEncryptionAvailable?.()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend?.()!=='basic_text');}catch{return false;}}
  function configure(input={}){
    const repo=repository(input.repository||DEFAULT_REPOSITORY),old=readSettings().updateSource||{},next={repository:repo};
    if(input.clearToken){memoryToken='';cliCache=null;}
    else if(typeof input.token==='string'&&input.token.trim()){
      const value=input.token.trim();if(value.length>4096||/[\r\n]/.test(value))throw sourceError('sourceInvalid');
      if(encryption()){memoryToken='';next.encryptedToken=safeStorage.encryptString(value).toString('base64');}else memoryToken=value;
    }else if(old.encryptedToken)next.encryptedToken=old.encryptedToken;
    writeSettings({updateSource:next},{strict:true});cache=null;inflight=null;++epoch;cap=crypto.randomBytes(24).toString('hex');auth='none';return config();
  }
  async function token(){
    if(memoryToken){auth='token';return memoryToken;}
    if(readSettings().updateSource?.encryptedToken){try{auth='token';return safeStorage.decryptString(Buffer.from(readSettings().updateSource.encryptedToken,'base64'));}catch{throw sourceError('sourceCredential');}}
    if(cliCache&&now()-cliCache.at<60000){auth=cliCache.value?'github-cli':'none';return cliCache.value;}
    const value=await (cliToken?cliToken():new Promise(resolve=>execFile('gh',['auth','token','--hostname','github.com'],{timeout:3000,windowsHide:true,maxBuffer:8192},(e,out)=>resolve(e?'':String(out).trim()))));
    cliCache={at:now(),value:String(value||'').trim()};auth=cliCache.value?'github-cli':'none';return cliCache.value;
  }
  async function request(url,{binary=false,range,signal}={}){
    const credential=await token();let current=new URL(url);
    for(let n=0;n<6;n++){
      const trusted=current.origin===new URL(apiBase).origin;
      if(!trusted&&(current.protocol!=='https:'||!/(^|\.)(github\.com|githubusercontent\.com)$/.test(current.hostname)))throw sourceError('sourceInvalid');
      const response=await fetcher(current.href,{redirect:'manual',signal:signal||AbortSignal.timeout(30000),headers:{Accept:binary?'application/octet-stream':'application/vnd.github+json','User-Agent':'My-Mate-Geny','X-GitHub-Api-Version':'2022-11-28',...(trusted&&credential?{Authorization:`Bearer ${credential}`} :{}),...(range?{Range:range}:{})}});
      if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location)throw sourceError('sourceUnavailable');current=new URL(location,current);continue;}
      return response;
    }throw sourceError('sourceUnavailable');
  }
  async function metadata(force=false){
    if(cache&&!force&&now()-cache.at<60000)return cache.value;
    if(inflight)return inflight;
    const generation=epoch,repo=config().repository.slice('https://github.com/'.length);
    const task=(async()=>{
      let response=await request(`${apiBase}/repos/${repo}/releases/tags/apps-latest`);
      if(response.status===404){await response.body?.cancel();response=await request(`${apiBase}/repos/${repo}/releases/latest`);}
      if(!response.ok){await response.body?.cancel();throw sourceError(response.status===404||response.status===401?'sourceAccess':response.status===403||response.status===429?'sourceRateLimit':'sourceUnavailable');}
      let data=await response.json();
      // apps-latest is overwritten asset by asset. Pin its published metadata to the immutable
      // versioned release so a check can never mix new feeds with old installers or notes.
      let published={};try{published=JSON.parse(/<!--\s*hrh-meta\s*(\{.*?\})\s*-->/.exec(data.body||'')?.[1]||'{}');}catch{}
      if(data.tag_name==='apps-latest'&&/^\d+\.\d+\.\d+$/.test(published.version||'')){
        const stable=await request(`${apiBase}/repos/${repo}/releases/tags/apps-v${published.version}`);
        if(stable.ok)data=await stable.json();else{await stable.body?.cancel();throw sourceError('sourceUnavailable');}
      }
      const files=new Map();
      for(const file of data.assets||[])if(file.state==='uploaded'&&Number.isSafeInteger(file.id)&&/^[\w.+-]+$/.test(file.name)&&file.size>0)files.set(file.name,file);
      let meta={};try{meta=JSON.parse(/<!--\s*hrh-meta\s*(\{.*?\})\s*-->/.exec(data.body||'')?.[1]||'{}');}catch{}
      const value={repo,files,version:meta.version||String(data.tag_name||'').match(/\d+\.\d+\.\d+[^\s]*/)?.[0],commit:meta.commit,commit_message:meta.commit_message,built_at:meta.built_at||data.published_at,notes:String(data.body||'').replace(/<!--[\s\S]*?-->/g,'').trim()};
      if(generation!==epoch)throw sourceError('sourceChanged');cache={at:now(),value};return value;
    })();inflight=task;try{return await task;}finally{if(inflight===task)inflight=null;}
  }
  async function start(){
    if(base)return;if(starting)return starting;if(closed)throw sourceError('sourceUnavailable');
    starting=new Promise((resolve,reject)=>{server=http.createServer((req,res)=>{void serve(req,res).catch(()=>{if(!res.headersSent)res.writeHead(502);res.end();});});server.once('error',reject);server.listen(0,'127.0.0.1',()=>{base=`http://127.0.0.1:${server.address().port}`;server.unref();resolve();});});
    try{await starting;}finally{starting=null;}
  }
  async function serve(req,res){
    const pathname=new URL(req.url,'http://127.0.0.1').pathname,prefix=`/${cap}/`;
    if(!['GET','HEAD'].includes(req.method)||!pathname.startsWith(prefix)){res.writeHead(404);res.end();return;}
    let name;try{name=decodeURIComponent(pathname.slice(prefix.length));}catch{res.writeHead(400);res.end();return;}
    const m=await metadata(name.endsWith('.yml')),file=m.files.get(name);
    if(!file||!(/^(latest(-linux|-mac)?\.yml)$/.test(name)||classify(name)||/\.blockmap$/.test(name))){res.writeHead(404);res.end();return;}
    const controller=new AbortController();controllers.add(controller);res.once('close',()=>controller.abort());
    try{
      const range=/^bytes=\d*-\d*$/.test(req.headers.range||'')?req.headers.range:undefined;
      const remote=await request(`${apiBase}/repos/${m.repo}/releases/assets/${file.id}`,{binary:true,range,signal:controller.signal});
      if(!remote.ok){await remote.body?.cancel();res.writeHead(remote.status);res.end();return;}
      const headers={'Content-Type':name.endsWith('.yml')?'text/yaml':'application/octet-stream','Cache-Control':'no-store','Content-Disposition':`attachment; filename="${name}"`};
      for(const h of ['content-length','content-range','accept-ranges'])if(remote.headers.get(h))headers[h]=remote.headers.get(h);
      res.writeHead(remote.status,headers);
      if(req.method==='HEAD'){await remote.body?.cancel();res.end();}else if(remote.body)await pipeline(Readable.fromWeb(remote.body),res);else res.end();
    }finally{controllers.delete(controller);}
  }
  async function feedUrl(){await metadata(true);await start();return `${base}/${cap}/`;}
  async function catalog(force=false){
    try{
      const m=await metadata(force);await start();const newest=new Map();
      for(const file of m.files.values()){const kind=classify(file.name);if(!kind)continue;const key=kind.platform+'/'+kind.arch+'/'+kind.kind,old=newest.get(key);if(!old||String(file.updated_at||'')>=String(old.updated_at||''))newest.set(key,file);}
      const assets=[...newest.values()].map(f=>({id:f.id,name:f.name,size:f.size,url:`${base}/${cap}/${encodeURIComponent(f.name)}`,...classify(f.name)}));
      return {available:assets.length>0,...(assets.length?{}:{reason:'incompatible_source'}),repository:config().repository,product:'My Mate Geny',version:m.version,commit:m.commit,commit_message:m.commit_message,built_at:m.built_at,notes:m.notes,assets};
    }catch(error){return {available:false,repository:config().repository,reason:error.code||'sourceUnavailable',assets:[]};}
  }
  function close(){closed=true;for(const c of controllers)c.abort();server?.closeAllConnections();server?.close();base='';}
  return {config,configure,catalog,feedUrl,close};
}
module.exports={DEFAULT_REPOSITORY,repository,classify,createUpdateSource};
