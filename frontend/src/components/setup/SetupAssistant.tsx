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
  const pick=async()=>{setError('');try{const bridge=folderBridge();if(!bridge)throw new Error('로컬 폴더 선택은 데스크톱 앱에서 사용할 수 있습니다.');const result=await bridge.pick();if(result){setPath(result.path);setConnectionId(null);await bridge.release(result.path);}}catch(e:any){setError(e.message);}};
  const finish=async(start:boolean)=>{
    setBusy(true);setError('');try{
      if(start){if(!path||!selected)throw new Error('연결된 도구와 작업 폴더를 선택해 주세요.');await useSessionStore.getState().create({provider:selected,workspace_path:path,connection_id:connectionId,model:catalog[selected]?.default_model||'',effort:'default',title:path.split(/[\\/]/).filter(Boolean).pop()||'chat'});useUIStore.getState().setView('chat');}
      await complete();await useProviderStore.getState().load();onDone();
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  };
  return <div className="h-full overflow-y-auto p-4 md:p-8" data-testid="setup-assistant">
    <div className="mx-auto w-full max-w-2xl space-y-5 pb-10">
      <header><div className="mb-3 inline-flex rounded-xl bg-accent-soft p-3 text-accent"><Icon name="sparkles" size={25}/></div>
        <h1 className="text-xl font-semibold">시작 도우미</h1>
        <p className="mt-2 text-sm text-content-muted">{local?'이 컴퓨터의 도구와 폴더를 연결해 시작합니다. Geny 서버 계정은 필요하지 않습니다.':'사용할 도구와 작업 공간을 확인하고 시작합니다.'}</p>
      </header>
      <section className="card p-5"><h2 className="mb-2 font-medium">1. 코딩 도구 연결</h2>
        <p className="text-xs text-content-faint mb-4">{local?'기존 설치와 로그인을 자동으로 확인합니다. 하나만 연결해도 시작할 수 있습니다. 모델 사용에는 해당 제공자의 계정과 네트워크가 필요합니다.':'접속한 서버에 설치된 도구입니다. 하나만 연결해도 시작할 수 있습니다.'}</p>
        {!data&&!error&&<p role="status">설치된 도구를 확인하고 있습니다…</p>}
        <div className="space-y-3">{data?.tools.map(tool=><div key={tool.id} className={`rounded-xl border p-4 ${selected===tool.id?'border-accent bg-accent-soft':'border-border'}`}>
          <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h3 className="font-medium">{tool.label}</h3><p className="text-xs text-content-muted mt-1">{tool.installed?(tool.connected?'연결됨':'설치됨 · 로그인 필요'):'설치되지 않음'} {tool.version&&<span>· {tool.version}</span>}</p></div>
            <div className="flex gap-2">{tool.connected?<button className="btn-primary" onClick={()=>setSelected(tool.id)} aria-pressed={selected===tool.id}>{selected===tool.id?'선택됨':'선택'}</button>:tool.installed?<button className="btn-primary" onClick={()=>setLogin(tool.id)}>로그인 연결</button>:tool.job.phase==='installing'?<button className="btn" onClick={()=>void action(tool.id,true)}>설치 취소</button>:<button className="btn-primary" onClick={()=>void action(tool.id)} disabled={data.tools.some(t=>t.job.phase==='installing')}>{local?'이 컴퓨터에 설치':'서버에 설치'}</button>}</div>
          </div>
          {tool.path&&<p className="mt-2 text-[11px] text-content-faint break-all">{tool.path}</p>}
          {tool.job.phase==='installing'&&<p className="mt-2 text-xs" role="status">공식 설치 프로그램을 실행하고 있습니다…</p>}
          {tool.job.error&&<p className="mt-2 text-xs text-danger">{tool.job.error}</p>}
          {!!tool.job.log.length&&<details className="mt-2 text-xs"><summary>설치 기록</summary><pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all text-content-muted">{tool.job.log.join('\n')}</pre></details>}
        </div>)}</div>
        <button className="mt-3 text-xs text-accent" onClick={()=>setRefresh(x=>x+1)}>다시 확인</button>
      </section>
      <section className="card p-5"><h2 className="font-medium mb-3">2. 작업 폴더 선택</h2>
        {local?<><button className="btn" onClick={()=>void pick()}>로컬 폴더 선택</button><p className="mt-3 text-sm break-all text-content-muted">{path||'이 컴퓨터에서 작업할 폴더를 선택해 주세요.'}</p></>:<WorkspacePicker connectionId={connectionId} setConnectionId={setConnectionId} path={path} setPath={setPath}/>}
      </section>
      {error&&<p role="alert" className="rounded-xl border border-danger/30 p-3 text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap justify-end gap-3"><button className="btn" disabled={busy} onClick={()=>void finish(false)}>설정 완료 · 기존 화면 열기</button><button className="btn-primary" disabled={busy||!path||!data?.tools.find(t=>t.id===selected)?.connected} onClick={()=>void finish(true)}>{busy?'준비 중…':'선택한 폴더에서 시작'}</button></div>
    </div>
    {login&&<ProviderOAuthModal provider={login} onClose={()=>setLogin('')} onConnected={()=>{void useProviderStore.getState().load();setRefresh(x=>x+1);}}/>}
  </div>;
}
