import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../api/client";
import { useT } from "../../i18n";
import { useCliToolsStore } from "../../stores/cliToolsStore";
import { useProviderStore } from "../../stores/providerStore";
import Icon from "../ui/Icon";

type Job={phase:string;step?:string;log:string[];error:string;transferred?:number;total?:number};
type State={tools:{id:string;installed:boolean;job:Job}[];node:{installed:boolean;node:string|null;npm:string|null;git:string|null;version:string|null;job:Job};busy:boolean};
export type Installations=ReturnType<typeof useInstallations>;
export function useInstallations(){
 const [data,setData]=useState<State|null>(null),[error,setError]=useState('');const reload=useRef<()=>void>(()=>{}),channel=useRef<BroadcastChannel|null>(null);
 useEffect(()=>{let alive=true,timer:ReturnType<typeof setTimeout>|undefined,working=false,queued=false;let previous:State|null=null;
  const load=async()=>{if(working){queued=true;return;}working=true;clearTimeout(timer);let supported=true;try{const next=await apiFetch<State>('/api/setup/installations');if(!alive)return;setData(next);setError('');for(const tool of next.tools)if(tool.job.phase==='done'&&previous?.tools.find(t=>t.id===tool.id)?.job.phase==='installing'){void useCliToolsStore.getState().check(tool.id);void useProviderStore.getState().load();}if(next.node.job.phase==='done'&&previous?.node.job.phase==='installing')void useCliToolsStore.getState().check();previous=next;}
  catch(e:any){if(e.status===404)supported=false;else if(alive)setError(e.message);}finally{working=false;if(alive&&queued&&supported){queued=false;void load();}else if(alive&&supported)timer=setTimeout(()=>void load(),previous?.busy?1000:10000);}};
  reload.current=()=>void load();void load();const focus=()=>void load();window.addEventListener('focus',focus);
  if(typeof BroadcastChannel!=='undefined'){channel.current=new BroadcastChannel('geny-cli-installations');channel.current.onmessage=focus;}
  return()=>{alive=false;clearTimeout(timer);window.removeEventListener('focus',focus);channel.current?.close();channel.current=null;};
 },[]);
 const action=async(tool:string,cancel=false,dependencies=false)=>{setError('');try{await apiFetch(`/api/setup/${tool}/${cancel?'cancel':'install'}`,{method:'POST',...(cancel?{}:{body:JSON.stringify({dependencies})})});reload.current();channel.current?.postMessage('changed');}catch(e:any){setError(e.message);reload.current();}};
 return {data,error,action};
}
function Progress({job,cancel}:{job:Job;cancel:()=>void}){
 const t=useT(),active=job.phase==='installing';if(job.phase==='idle')return null;
 return <div className="mt-2 space-y-2 text-xs" role="status">
  <p className={job.phase==='error'?'text-danger':'text-content-muted'}>{active?t(job.step==='nodeDownload'?'cliTools.downloadingNode':job.step==='nodeExtract'?'cliTools.extractingNode':'cliTools.installingTool'):job.phase==='done'?t('cliTools.installDone'):job.phase==='cancelled'?t('cliTools.installCancelled'):job.error}</p>
  {active&&!!job.total&&<progress className="w-full accent-accent" max={job.total} value={job.transferred||0}/>}
  {active&&<button className="btn-ghost !px-0" onClick={cancel}>{t('common.cancel')}</button>}
  {!!job.log.length&&<details><summary className="cursor-pointer text-content-faint">{t('cliTools.showLog')}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 p-2">{job.log.join('\n')}</pre></details>}
 </div>;
}
export function Dependencies({installations,otherJob}:{installations:Installations;otherJob:boolean}){
 const t=useT(),data=installations.data;if(!data)return null;
 return <div className="mt-4 rounded-xl border border-border bg-surface/50 p-3" data-testid="cli-dependencies">
  <div className="flex flex-wrap items-center gap-2"><Icon name="cpu" size={16} className="text-accent"/><h4 className="text-sm font-medium">{t('cliTools.dependencies')}</h4><span className="text-xs text-content-muted">{data.node.installed?t('cliTools.dependenciesReady'):t('cliTools.dependenciesMissing')}</span></div>
  <p className="mt-1 text-xs text-content-faint">{t('cliTools.dependenciesHint')}</p>
  {!data.node.installed&&<button className="btn-soft mt-3" disabled={data.busy||otherJob} onClick={()=>void installations.action('node')} data-testid="install-node"><Icon name="download" size={14}/>{t('cliTools.installNode')}</button>}
  {!data.node.git&&<p className="mt-2 text-xs text-content-muted">{t('cliTools.gitHint')} <a className="text-accent underline" href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">{t('cliTools.installGit')}</a></p>}
  <Progress job={data.node.job} cancel={()=>void installations.action('node',true)}/>
  {installations.error&&<p className="mt-2 text-xs text-danger" role="alert">{installations.error}</p>}
 </div>;
}
export function InstallTool({tool,installations,otherJob}:{tool:string;installations:Installations;otherJob:boolean}){
 const t=useT(),data=installations.data,item=data?.tools.find(x=>x.id===tool);if(!data||!item)return null;
 const withNode=!data.node.installed;
 return <div className="mt-3" data-testid={`install-tool-${tool}`}>
  {!item.installed&&item.job.phase!=='installing'&&<button className="btn-primary" disabled={data.busy||otherJob} onClick={()=>void installations.action(tool,false,withNode)}><Icon name="download" size={14}/>{t(withNode?'cliTools.installWithNode':'cliTools.installTool')}</button>}
  <Progress job={item.job} cancel={()=>void installations.action(tool,true)}/>
 </div>;
}
