import { useT } from "../../i18n";
import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client';
import { useProviderStore } from '../../stores/providerStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useConfigStore } from '../../stores/configStore';
import { useUIStore } from '../../stores/uiStore';
import { folderBridge } from '../../lib/localFolder';
import WorkspacePicker from '../workspaces/WorkspacePicker';
import ProviderOAuthModal from '../providers/ProviderOAuthModal';
import Icon from '../ui/Icon';

type Job={phase:string;log:string[];error:string};
type Tool={id:string;label:string;installed:boolean;path:string|null;version:string;connected:boolean;job:Job};
type Setup={execution_mode:string;platform:string;home:string;tools:Tool[]};
export const SETUP_KEY='hrh_setup_completed_v1';
const nativeSetup=()=> (window.hrhNative as any)?.setup;
export async function setupCompleted():Promise<boolean>{
  try{if(nativeSetup())return await nativeSetup().state()===true;return localStorage.getItem(SETUP_KEY)==='1';}catch{return false;}
}
async function complete(){if(nativeSetup())await nativeSetup().complete();localStorage.setItem(SETUP_KEY,'1');}

export default function SetupAssistant({onDone}:{onDone:()=>void}){
  const t=useT();
  const [data,setData]=useState<Setup|null>(null),[error,setError]=useState('');
  const [selected,setSelected]=useState(''),[path,setPath]=useState<string|null>(null),[connectionId,setConnectionId]=useState<string|null>(null);
  const [login,setLogin]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
  const catalog=useConfigStore(s=>s.catalog);
  useEffect(()=>{
    let alive=true,working=false;
    const load=async()=>{if(working)return;working=true;try{const d=await apiFetch<Setup>('/api/setup');if(alive){setData(d);setError('');setSelected(prev=>prev||d.tools.find(t=>t.connected)?.id||'');}}catch(e:any){if(alive)setError(e.message);}finally{working=false;}};
    void load();const timer=setInterval(load,2500);return()=>{alive=false;clearInterval(timer);};
  },[refresh]);
  const local=data?.execution_mode==='local';
  const action=async(tool:string,cancel=false)=>{setError('');try{await apiFetch(`/api/setup/${tool}/${cancel?'cancel':'install'}`,{method:'POST'});setRefresh(x=>x+1);}catch(e:any){setError(e.message);}};
  const pick=async()=>{setError('');try{const bridge=folderBridge();if(!bridge)throw new Error(t("setup.folderNative"));const result=await bridge.pick();if(result){setPath(result.path);setConnectionId(null);await bridge.release(result.path);}}catch(e:any){setError(e.message);}};
  const finish=async(start:boolean)=>{
    setBusy(true);setError('');try{
      if(start){if(!path||!selected)throw new Error(t("setup.needToolFolder"));await useSessionStore.getState().create({provider:selected,workspace_path:path,connection_id:connectionId,model:catalog[selected]?.default_model||'',effort:'default',title:path.split(/[\\/]/).filter(Boolean).pop()||'chat'});useUIStore.getState().setView('chat');}
      await complete();await useProviderStore.getState().load();onDone();
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  };
  return <div className="h-full overflow-y-auto p-4 md:p-8" data-testid="setup-assistant">
    <div className="mx-auto w-full max-w-2xl space-y-5 pb-10">
      <header><div className="mb-3 inline-flex rounded-xl bg-accent-soft p-3 text-accent"><Icon name="sparkles" size={25}/></div>
        <h1 className="text-xl font-semibold">{t("setup.title")}</h1>
        <p className="mt-2 text-sm text-content-muted">{local?t("setup.localIntro"):t("setup.serverIntro")}</p>
      </header>
      <section className="card p-5"><h2 className="mb-2 font-medium">{t("setup.toolsTitle")}</h2>
        <p className="text-xs text-content-faint mb-4">{local?t("setup.localTools"):t("setup.serverTools")}</p>
        {!data&&!error&&<p role="status">{t("setup.detecting")}</p>}
        <div className="space-y-3">{data?.tools.map(tool=><div key={tool.id} className={`rounded-xl border p-4 ${selected===tool.id?'border-accent bg-accent-soft':'border-border'}`}>
          <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h3 className="font-medium">{tool.label}</h3><p className="text-xs text-content-muted mt-1">{tool.installed?(tool.connected?t("setup.connected"):t("setup.needsLogin")):t("setup.notInstalled")} {tool.version&&<span>· {tool.version}</span>}</p></div>
            <div className="flex gap-2">{tool.connected?<button className="btn-primary" onClick={()=>setSelected(tool.id)} aria-pressed={selected===tool.id}>{selected===tool.id?t("setup.selected"):t("setup.select")}</button>:tool.installed?<button className="btn-primary" onClick={()=>setLogin(tool.id)}>{t("setup.login")}</button>:tool.job.phase==='installing'?<button className="btn" onClick={()=>void action(tool.id,true)}>{t("setup.cancelInstall")}</button>:<button className="btn-primary" onClick={()=>void action(tool.id)} disabled={data.tools.some(t=>t.job.phase==='installing')}>{local?t("setup.installLocal"):t("setup.installServer")}</button>}</div>
          </div>
          {tool.path&&<p className="mt-2 text-[11px] text-content-faint break-all">{tool.path}</p>}
          {tool.job.phase==='installing'&&<p className="mt-2 text-xs" role="status">{t("setup.installing")}</p>}
          {tool.job.error&&<p className="mt-2 text-xs text-danger">{tool.job.error}</p>}
          {!!tool.job.log.length&&<details className="mt-2 text-xs"><summary>{t("setup.installLog")}</summary><pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all text-content-muted">{tool.job.log.join('\n')}</pre></details>}
        </div>)}</div>
        <button className="mt-3 text-xs text-accent" onClick={()=>setRefresh(x=>x+1)}>{t("setup.refresh")}</button>
      </section>
      {data&&<section className="card p-5"><h2 className="font-medium mb-3">{t("setup.folderTitle")}</h2>
        {local?<><button className="btn" onClick={()=>void pick()}>{t("setup.pickFolder")}</button><p className="mt-3 text-sm break-all text-content-muted">{path||t("setup.folderHint")}</p></>:<WorkspacePicker connectionId={connectionId} setConnectionId={setConnectionId} path={path} setPath={setPath}/>}
      </section>}
      {error&&<p role="alert" className="rounded-xl border border-danger/30 p-3 text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap justify-end gap-3"><button className="btn" disabled={busy} onClick={()=>void finish(false)}>{t("setup.finish")}</button><button className="btn-primary" disabled={busy||!path||!data?.tools.find(t=>t.id===selected)?.connected} onClick={()=>void finish(true)}>{busy?t("setup.starting"):t("setup.start")}</button></div>
    </div>
    {login&&<ProviderOAuthModal provider={login} onClose={()=>setLogin('')} onConnected={()=>{void useProviderStore.getState().load();setRefresh(x=>x+1);}}/>}
  </div>;
}
