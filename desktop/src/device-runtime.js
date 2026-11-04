"use strict";
const {randomBytes,randomUUID}=require("node:crypto");
/** Identity, lifecycle outbox and hidden controller live for the app process, independent of UI windows. */
function createDeviceLifecycle({readSettings,writeSettings,autostart=false}){
  let id=readSettings().deviceId;
  if(typeof id!=="string"||!/^dev_[a-f0-9]{32}$/.test(id)){id=`dev_${randomBytes(16).toString('hex')}`;writeSettings({deviceId:id});}
  const bootId=randomUUID(),startupSent=new Set();
  function events(){const raw=readSettings().deviceEvents;return Array.isArray(raw)?raw.filter(e=>e&&typeof e.id==="string"&&typeof e.origin==="string"):[];}
  function pending(origin){return events().filter(e=>e.origin===origin).slice(0,30);}
  function add(type,origin,mateId){
    if(!/^https?:\/\//.test(origin)||!mateId)return;
    const all=events();
    if(type==="startup"&&startupSent.has(origin))return;
    const event={id:randomUUID(),type,origin,mate_id:mateId,device:id,boot_id:bootId,start_reason:autostart?"autostart":"manual",created_at:Date.now()};
    writeSettings({deviceEvents:[...all,event].slice(-60)});
    if(type==="startup")startupSent.add(origin);
  }
  return {started:on=>{autostart=!!on;},info:()=>({deviceId:id,bootId,startReason:autostart?"autostart":"manual"}),pending,add,
    ack:(origin,ids)=>writeSettings({deviceEvents:events().filter(e=>!(e.origin===origin&&ids.includes(e.id)))} )};
}
function createRuntimeWindow({BrowserWindow,preload,version,serverUrl,allowed}){
  let win=null,lastUrl="",retry=null,stopped=false;
  function ensure(){
    if(stopped)return;
    const base=serverUrl();if(!base)return;
    const url=base+"/?surface=device-runtime";
    if(win&&!win.isDestroyed()){if(lastUrl!==url||/\/login(?:[?#]|$)/.test(win.webContents.getURL())){lastUrl=url;void win.loadURL(url).catch(()=>{});}return;}
    lastUrl=url;
    win=new BrowserWindow({show:false,width:32,height:32,skipTaskbar:true,webPreferences:{preload,contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false,autoplayPolicy:"no-user-gesture-required",additionalArguments:[`--hrh-version=${version}`,"--hrh-surface=device-runtime"]}});
    win.webContents.setWindowOpenHandler(()=>({action:"deny"}));
    win.webContents.on("will-navigate",(e,target)=>{if(!allowed(target))e.preventDefault();});
    win.webContents.on("render-process-gone",()=>{clearTimeout(retry);retry=setTimeout(()=>{if(win&&!win.isDestroyed())void win.loadURL(lastUrl).catch(()=>{});},1500);});
    win.webContents.on("did-fail-load",(_e,code)=>{if(code!==-3){clearTimeout(retry);retry=setTimeout(()=>{if(win&&!win.isDestroyed())void win.loadURL(lastUrl).catch(()=>{});},5000);}});
    win.on("closed",()=>{win=null;});
    void win.loadURL(url).catch(()=>{});
  }
  return {ensure,start:()=>{stopped=false;ensure();},window:()=>win,destroy:()=>{stopped=true;clearTimeout(retry);if(win&&!win.isDestroyed())win.destroy();win=null;}};
}
module.exports={createDeviceLifecycle,createRuntimeWindow};
