/**
 * The first start (docs/settings.md): 1. the language-model tools (Claude Code, Codex: install, sign in) — 2. the
 * mate: what she calls you, whether she is on the desktop (the default mate, Chaerin), reading replies aloud. Done →
 * the Mate view. (No folder or chat to start here: a chat is started from Chat when it is wanted.)
 */
import { useT } from "../../i18n";
import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client';
import { getVoiceSettings, putVoiceSettings } from '../../api/mates';
import { AUTH_CHANGED_EVENT } from '../../api/admin';
import { desktopMate } from '../../mate/desktop';
import { useMateStore } from '../../stores/mateStore';
import { useProviderStore } from '../../stores/providerStore';
import { useUIStore } from '../../stores/uiStore';
import ProviderOAuthModal from '../providers/ProviderOAuthModal';
import { Toggle } from '../mate/settings/ui';
import Icon from '../ui/Icon';

type Job={phase:string;log:string[];error:string};
type Tool={id:string;label:string;installed:boolean;path:string|null;version:string;connected:boolean;job:Job};
type Setup={execution_mode:string;platform:string;home:string;tools:Tool[]};
export const SETUP_KEY='hrh_setup_completed_v1';
const SEEN_KEY='hrh_setup_seen_v2';
const nativeSetup=()=> (window.hrhNative as any)?.setup;
export async function setupCompleted():Promise<boolean>{
  try{if(nativeSetup())return await nativeSetup().state()===true;return localStorage.getItem(SEEN_KEY)==='1'||localStorage.getItem(SETUP_KEY)==='1'||!!localStorage.getItem('hrh_last_session')||!!localStorage.getItem('hrh_last_conversation');}catch{return false;}
}
async function complete(){if(nativeSetup())await nativeSetup().complete();localStorage.setItem(SETUP_KEY,'1');}

function Steps({step}:{step:1|2}){
  const t=useT();
  return <ol className="flex items-center gap-2 text-xs text-content-faint" aria-label={t("setup.steps")}>
    {([1,2] as const).map(n=><li key={n} className={`flex items-center gap-1.5 ${n===step?'font-medium text-accent':''}`} aria-current={n===step?'step':undefined}>
      <span className={`grid h-5 w-5 place-items-center rounded-full border text-[11px] ${n===step?'border-accent bg-accent-soft':n<step?'border-success/50 text-success':'border-border'}`}>{n<step?<Icon name="check" size={11}/>:n}</span>
      {t(n===1?"setup.stepTools":"setup.stepMate")}
      {n===1&&<span className="mx-1 text-border-strong">—</span>}
    </li>)}
  </ol>;
}

function ToolsStep({onNext}:{onNext:()=>void}){
  const t=useT();
  const [data,setData]=useState<Setup|null>(null),[error,setError]=useState('');
  const [login,setLogin]=useState(''),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    let alive=true,working=false;
    const load=async()=>{if(working)return;working=true;try{const d=await apiFetch<Setup>('/api/setup');if(alive){setData(d);setError('');}}catch(e:any){if(alive)setError(e.message);}finally{working=false;}};
    void load();const timer=setInterval(load,2500);return()=>{alive=false;clearInterval(timer);};
  },[refresh]);
  const local=data?.execution_mode==='local';
  const action=async(tool:string,cancel=false)=>{setError('');try{await apiFetch(`/api/setup/${tool}/${cancel?'cancel':'install'}`,{method:'POST',...(cancel?{}:{body:JSON.stringify({dependencies:true})})});setRefresh(x=>x+1);}catch(e:any){setError(e.message);}};
  const connected=!!data?.tools.some(tool=>tool.connected);
  return <>
    <header><h1 className="text-xl font-semibold">{t("setup.title")}</h1>
      <p className="mt-2 text-sm text-content-muted">{local?t("setup.localIntro"):t("setup.serverIntro")}</p>
    </header>
    <section className="card p-5"><h2 className="mb-2 font-medium">{t("setup.toolsTitle")}</h2>
      <p className="text-xs text-content-faint mb-4">{local?t("setup.localTools"):t("setup.serverTools")}</p>
      {!data&&!error&&<p role="status">{t("setup.detecting")}</p>}
      <div className="space-y-3">{data?.tools.map(tool=><div key={tool.id} className={`rounded-xl border p-4 ${tool.connected?'border-accent/30 bg-accent-soft':'border-border'}`}>
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h3 className="font-medium">{tool.label}</h3><p className="text-xs text-content-muted mt-1">{tool.installed?(tool.connected?t("setup.connected"):t("setup.needsLogin")):t("setup.notInstalled")} {tool.version&&<span>· {tool.version}</span>}</p></div>
          <div className="flex gap-2">{tool.connected?<Icon name="check" size={20} className="text-success"/>:tool.installed?<button className="btn-primary" onClick={()=>setLogin(tool.id)}>{t("setup.login")}</button>:tool.job.phase==='installing'?<button className="btn" onClick={()=>void action(tool.id,true)}>{t("setup.cancelInstall")}</button>:<button className="btn-primary" onClick={()=>void action(tool.id)} disabled={data.tools.some(t=>t.job.phase==='installing')}>{local?t("setup.installLocal"):t("setup.installServer")}</button>}</div>
        </div>
        {tool.path&&<p className="mt-2 text-[11px] text-content-faint break-all">{tool.path}</p>}
        {tool.job.phase==='installing'&&<p className="mt-2 text-xs" role="status">{t("setup.installing")}</p>}
        {tool.job.error&&<p className="mt-2 text-xs text-danger">{tool.job.error}</p>}
        {!!tool.job.log.length&&<details className="mt-2 text-xs"><summary>{t("setup.installLog")}</summary><pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all text-content-muted">{tool.job.log.join('\n')}</pre></details>}
      </div>)}</div>
      <button className="mt-3 text-xs text-accent" onClick={()=>setRefresh(x=>x+1)}>{t("setup.refresh")}</button>
    </section>
    {error&&<p role="alert" className="rounded-xl border border-danger/30 p-3 text-sm text-danger">{error}</p>}
    <div className="flex flex-wrap items-center justify-end gap-4">
      {!connected&&<button className="min-h-11 rounded-lg px-1 text-sm text-content-muted hover:text-content hover:underline" onClick={onNext} data-testid="setup-later">{t("setup.later")}</button>}
      <button className="btn-primary min-h-11" disabled={!connected} onClick={onNext} data-testid="setup-next">{t("setup.next")}</button>
    </div>
    {login&&<ProviderOAuthModal provider={login} onClose={()=>setLogin('')} onConnected={()=>{void useProviderStore.getState().load();setRefresh(x=>x+1);}}/>}
  </>;
}

function MateStep({onBack,onDone}:{onBack:()=>void;onDone:()=>void}){
  const t=useT();
  const mates=useMateStore(s=>s.mates);
  const muted=useMateStore(s=>s.muted);
  const mate=mates.find(m=>m.is_default)??mates[0];
  const desk=desktopMate();
  const [name,setName]=useState(''),[show,setShow]=useState(true),[read,setRead]=useState(!muted);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    const st=useMateStore.getState();if(!st.loaded)void st.load().catch(()=>{});
    getVoiceSettings().then(s=>setName(n=>n||s.user_name||'')).catch(()=>{});
  },[]);
  const finish=async()=>{
    setBusy(true);setError('');
    try{
      if(name.trim())await putVoiceSettings({user_name:name.trim()});
      useMateStore.getState().setMuted(!read);
      if(desk)await (show?desk.showAvatar(mate?.id):desk.hideAvatar());
      await complete();
      window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
      void useMateStore.getState().load();void useProviderStore.getState().load();
      onDone();
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  };
  return <>
    <header><h1 className="text-xl font-semibold">{t("setup.mateTitle",{name:mate?.name||"Geny"})}</h1>
      <p className="mt-2 text-sm text-content-muted">{t("setup.mateIntro")}</p>
    </header>
    <section className="card space-y-5 p-5">
      <form onSubmit={e=>{e.preventDefault();void finish();}}>
        <label className="block">
          <span className="block font-medium">{t("setup.callYou")}</span>
          <span className="mt-0.5 block text-xs text-content-faint">{t("setup.callYouHint")}</span>
          <input className="field mt-2" value={name} maxLength={80} autoFocus onChange={e=>setName(e.target.value)} placeholder={t("settings.yourNamePh")} data-testid="setup-your-name"/>
        </label>
      </form>
      {desk&&<Toggle on={show} onChange={setShow} label={t("setup.showMate",{name:mate?.name||"Geny"})} hint={t("setup.showMateHint")} testId="setup-show-mate"/>}
      <Toggle on={read} onChange={setRead} label={t("mateSettings.defReadHere")} hint={t("setup.readHint")} testId="setup-read-aloud"/>
    </section>
    {error&&<p role="alert" className="rounded-xl border border-danger/30 p-3 text-sm text-danger">{error}</p>}
    <div className="flex flex-wrap items-center justify-between gap-4">
      <button className="min-h-11 rounded-lg px-1 text-sm text-content-muted hover:text-content hover:underline" onClick={onBack}>{t("setup.back")}</button>
      <button className="btn-primary min-h-11" disabled={busy} onClick={()=>void finish()} data-testid="setup-finish">{busy?t("setup.starting"):t("setup.finish")}</button>
    </div>
  </>;
}

export default function SetupAssistant({onDone}:{onDone:()=>void}){
  const [step,setStep]=useState<1|2>(1);
  useEffect(()=>{try{localStorage.setItem(SEEN_KEY,'1');}catch{}void nativeSetup()?.seen?.().catch(()=>{});},[]);
  const done=()=>{useUIStore.getState().setView("mate");onDone();};
  return <div className="h-full overflow-y-auto p-4 md:p-8" data-testid="setup-assistant">
    <div className="mx-auto w-full max-w-2xl space-y-5 pb-10">
      <div className="flex items-center gap-3"><div className="inline-flex rounded-xl bg-accent-soft p-2.5 text-accent"><Icon name="sparkles" size={20}/></div><Steps step={step}/></div>
      {step===1?<ToolsStep onNext={()=>setStep(2)}/>:<MateStep onBack={()=>setStep(1)} onDone={done}/>}
    </div>
  </div>;
}
