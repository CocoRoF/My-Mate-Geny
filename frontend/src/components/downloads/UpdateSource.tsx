import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import Icon from "../ui/Icon";
import { useUpdateState } from "./UpdateCard";

type Source={repository:string;defaultRepository:string;hasToken:boolean;tokenPersistent:boolean;authentication:string};
export default function UpdateSource(){
 const t=useT(),bridge=(window.hrhNative as any)?.updates,updater=useUpdateState();
 const [source,setSource]=useState<Source|null>(null),[editing,setEditing]=useState(false),[url,setUrl]=useState(''),[token,setToken]=useState(''),[clearToken,setClearToken]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{if(!bridge?.source)return;void bridge.source().then(setSource);return bridge.onSourceChanged?.((s:Source)=>{setSource(s);window.dispatchEvent(new Event('geny:update-source-changed'));});},[bridge]);
 if(!source)return null;
 const locked=!!updater&&['checking','downloading','ready','installing'].includes(updater.status);
 const save=async()=>{setBusy(true);setError('');try{const s=await bridge.setSource({repository:url,token,clearToken});setSource(s);setToken('');setClearToken(false);setEditing(false);window.dispatchEvent(new Event('geny:update-source-changed'));void bridge.check();}catch(e:any){setError(t(String(e.message).includes('sourceBusy')?'downloads.sourceBusy':'downloads.sourceSaveFailed'));}finally{setBusy(false);}};
 return <section className="card mt-5 p-4" data-testid="update-source">
  <div className="flex flex-wrap items-center gap-2"><Icon name="github" size={16} className="text-content-muted"/><h3 className="text-sm font-medium">{t('downloads.sourceTitle')}</h3><button className="ml-auto btn-ghost text-xs" disabled={busy||locked} onClick={()=>{setUrl(source.repository);setEditing(!editing);setError('');}}>{t('downloads.sourceChange')}</button></div>
  <a href={source.repository} target="_blank" rel="noreferrer" className="mt-2 block break-all text-sm text-accent hover:underline">{source.repository}</a>
  <p className="mt-2 text-xs text-content-muted">{t('downloads.sourceHint')}</p>
  {source.hasToken&&<p className="mt-2 text-xs text-content-muted">{t(source.tokenPersistent?'downloads.sourceTokenSaved':'downloads.sourceTokenSession')}</p>}
  {locked&&<p className="mt-2 text-xs text-content-muted">{t('downloads.sourceBusy')}</p>}
  {editing&&<div className="mt-4 space-y-3">
   <label className="block text-xs text-content-muted">{t('downloads.sourceRepository')}<input className="field mt-1" value={url} onChange={e=>setUrl(e.target.value)} spellCheck={false} autoCapitalize="none" data-testid="update-source-url"/></label>
   <label className="block text-xs text-content-muted">{t('downloads.sourceToken')}<input type="password" className="field mt-1" autoComplete="off" value={token} onChange={e=>{setToken(e.target.value);setClearToken(false);}} data-testid="update-source-token"/></label>
   <p className="text-xs text-content-faint">{t('downloads.sourceAuthHint')}</p>
   {source.hasToken&&<label className="flex gap-2 text-xs"><input type="checkbox" checked={clearToken} onChange={e=>setClearToken(e.target.checked)}/>{t('downloads.sourceClearToken')}</label>}
   <div className="flex flex-wrap gap-2"><button className="btn-primary" disabled={busy||locked} onClick={()=>void save()}>{t('common.save')}</button><button className="btn-ghost" disabled={busy} onClick={()=>setUrl(source.defaultRepository)}>{t('downloads.sourceDefault')}</button><button className="btn-ghost" disabled={busy} onClick={()=>{setEditing(false);setToken('');}}>{t('common.cancel')}</button></div>
  </div>}
  {error&&<p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
 </section>;
}
