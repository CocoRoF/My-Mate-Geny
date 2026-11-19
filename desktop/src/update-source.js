"use strict";
// The desktop owns its release source. Neither a Geny server nor its session cookie is needed.
const http=require('http'),crypto=require('crypto'),os=require('os'),{Readable}=require('stream'),{pipeline}=require('stream/promises');
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
/** a build's version, from its file name (my-mate-geny-<version>-…): each platform is published on its own */
function versionOf(name){return /-(\d+\.\d+\.\d+)-/.exec(name)?.[1]||'';}
/** which Mac this is: the app's own architecture (an Intel build under Rosetta updates to the Intel build) */
function macArch(){return process.arch==='arm64'?'arm64':'x64';}
/** this computer's address on the home network (what a phone on the same Wi-Fi reaches), or '' */
function lanAddress(nets=os.networkInterfaces()){
  const all=Object.values(nets).flat().filter(a=>a&&a.family==='IPv4'&&!a.internal);
  const home=all.find(a=>/^(192\.168|10)\.|^172\.(1[6-9]|2\d|3[01])\./.test(a.address));
  return (home||all[0])?.address||'';
}
const PHONE_LINK_MS=30*60000;
function createUpdateSource({readSettings,writeSettings,safeStorage,fetcher=globalThis.fetch,apiBase='https://api.github.com',cliToken,now=Date.now,network=()=>lanAddress()}){
  let memoryToken='',cache=null,inflight=null,epoch=0,server=null,starting=null,cap=crypto.randomBytes(24).toString('hex'),base='',closed=false;
  let auth='none',cliCache=null,visibility=null;const controllers=new Set();
  // the phone's copy of the Android app (the Download page's QR, when the repository is private): served to the home
  // network for a while, under a link only the QR code knows
  let lan=null;
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
    writeSettings({updateSource:next},{strict:true});cache=null;inflight=null;visibility=null;++epoch;cap=crypto.randomBytes(24).toString('hex');auth='none';return config();
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
      // apps-latest holds each platform's newest build, each put there the moment it was built (.github/scripts/
      // apps_publish.py): its installers first, its feed last — a feed never names a file that isn't there yet. (Before
      // 1.1.1 one release held every platform and was pinned by its version: a release that names one is still pinned.)
      let published={};try{published=JSON.parse(/<!--\s*hrh-meta\s*(\{.*?\})\s*-->/.exec(data.body||'')?.[1]||'{}');}catch{}
      if(data.tag_name==='apps-latest'&&/^\d+\.\d+\.\d+$/.test(published.version||'')){
        const stable=await request(`${apiBase}/repos/${repo}/releases/tags/apps-v${published.version}`);
        if(stable.ok)data=await stable.json();else{await stable.body?.cancel();throw sourceError('sourceUnavailable');}
      }
      const files=new Map();
      for(const file of data.assets||[])if(file.state==='uploaded'&&Number.isSafeInteger(file.id)&&/^[\w.+-]+$/.test(file.name)&&file.size>0)files.set(file.name,file);
      let meta={};try{meta=JSON.parse(/<!--\s*hrh-meta\s*(\{.*?\})\s*-->/.exec(data.body||'')?.[1]||'{}');}catch{}
      // A public repository's files can be fetched by anyone straight from GitHub — so a phone can scan a QR code for
      // the APK (the Download page) without reaching this computer. Asked once per repository.
      if(visibility?.repo!==repo){try{const r=await request(`${apiBase}/repos/${repo}`);if(r.ok)visibility={repo,public:(await r.json()).private===false};else await r.body?.cancel();}catch{}}
      // iOS is TestFlight: ios.json says which build and the public link a phone opens (a few hundred bytes)
      let ios=null;const iosFile=files.get('ios.json');
      if(iosFile){try{const r=await request(`${apiBase}/repos/${repo}/releases/assets/${iosFile.id}`,{binary:true});if(r.ok){const j=await r.json();const link=String(j.testflight||'');ios={version:String(j.version||''),build:String(j.build||''),testflight:link.startsWith('https://testflight.apple.com/')?link:'',updated_at:iosFile.updated_at};}else await r.body?.cancel();}catch{}}
      const value={repo,files,ios,public:visibility?.repo===repo&&visibility.public,version:meta.version||String(data.tag_name||'').match(/\d+\.\d+\.\d+[^\s]*/)?.[0],commit:meta.commit,commit_message:meta.commit_message,built_at:meta.built_at||data.published_at,notes:String(data.body||'').replace(/<!--[\s\S]*?-->/g,'').trim()};
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
    const m=await metadata(name.endsWith('.yml'));
    // (each Mac architecture has a feed of its own, published as soon as that build is: it is this Mac's latest-mac.yml)
    const own=name==='latest-mac.yml'&&m.files.get(`latest-mac-${macArch()}.yml`),file=own||m.files.get(name);
    if(!file||!(/^(latest(-linux|-mac)?\.yml)$/.test(name)||classify(name)||/\.blockmap$/.test(name)||/macos-(arm64|x64)\.zip$/.test(name))){res.writeHead(404);res.end();return;}
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
      const direct=f=>m.public&&/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\//.test(f.browser_download_url||'')?{public_url:f.browser_download_url}:{};
      const assets=[...newest.values()].map(f=>({id:f.id,name:f.name,size:f.size,updated_at:f.updated_at,version:versionOf(f.name),url:`${base}/${cap}/${encodeURIComponent(f.name)}`,...direct(f),...classify(f.name)}));
      const top=assets.map(a=>a.version).filter(Boolean).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))[0];
      return {available:assets.length>0||!!m.ios,...(assets.length||m.ios?{}:{reason:'incompatible_source'}),repository:config().repository,product:'My Mate Geny',version:top||m.version,ios:m.ios,commit:m.commit,commit_message:m.commit_message,built_at:m.built_at,notes:m.notes,assets};
    }catch(error){return {available:false,repository:config().repository,reason:error.code||'sourceUnavailable',assets:[]};}
  }
  /** a link a phone on the same Wi-Fi opens to get the Android app: this computer hands it the file for half an hour */
  async function phoneLink(name){
    const m=await metadata(),file=m.files.get(String(name||''));
    if(!file||classify(file.name)?.platform!=='android')throw sourceError('sourceInvalid');
    const ip=network();if(!ip)throw sourceError('noLan');
    if(!lan){
      const caps=new Map();
      const s=http.createServer((req,res)=>{void (async()=>{
        const [,c,n]=/^\/([a-f0-9]{48})\/([\w.+-]+)$/.exec(new URL(req.url,'http://x').pathname)||[];
        const grant=c&&caps.get(c);
        if(!['GET','HEAD'].includes(req.method)||!grant||grant.name!==n||now()>grant.until){res.writeHead(404);res.end();return;}
        const meta=await metadata(),f=meta.files.get(n);if(!f){res.writeHead(404);res.end();return;}
        const remote=await request(`${apiBase}/repos/${meta.repo}/releases/assets/${f.id}`,{binary:true,range:/^bytes=\d*-\d*$/.test(req.headers.range||'')?req.headers.range:undefined});
        if(!remote.ok){await remote.body?.cancel();res.writeHead(remote.status);res.end();return;}
        const headers={'Content-Type':'application/vnd.android.package-archive','Content-Disposition':`attachment; filename="${n}"`,'Cache-Control':'no-store'};
        for(const h of ['content-length','content-range','accept-ranges'])if(remote.headers.get(h))headers[h]=remote.headers.get(h);
        res.writeHead(remote.status,headers);
        if(req.method==='HEAD'){await remote.body?.cancel();res.end();}else if(remote.body)await pipeline(Readable.fromWeb(remote.body),res);else res.end();
      })().catch(()=>{if(!res.headersSent)res.writeHead(502);res.end();});});
      await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'0.0.0.0',resolve);});
      s.unref();lan={server:s,caps,port:s.address().port,timer:null};
    }
    const c=crypto.randomBytes(24).toString('hex');lan.caps.set(c,{name:file.name,until:now()+PHONE_LINK_MS});
    clearTimeout(lan.timer);lan.timer=setTimeout(()=>{lan?.server.close();lan=null;},PHONE_LINK_MS+60000);lan.timer.unref?.();
    return {url:`http://${ip}:${lan.port}/${c}/${encodeURIComponent(file.name)}`,until:now()+PHONE_LINK_MS};
  }
  function close(){closed=true;for(const c of controllers)c.abort();server?.closeAllConnections();server?.close();base='';if(lan){clearTimeout(lan.timer);lan.server.closeAllConnections?.();lan.server.close();lan=null;}}
  return {config,configure,catalog,feedUrl,phoneLink,close};
}
module.exports={DEFAULT_REPOSITORY,repository,classify,versionOf,lanAddress,createUpdateSource};
