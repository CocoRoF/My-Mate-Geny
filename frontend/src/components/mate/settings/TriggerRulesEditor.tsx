import {useEffect,useRef,useState} from "react";
import type {GenyTriggerPreset} from "../../../api/mates";
import {useT} from "../../../i18n";
import {weightShares,frequencyLevel,sliderMaximum,cooldownPresets} from "../../../lib/triggerWeights";
import {Field} from "./ui";
type Props={initial:GenyTriggerPreset;language:string;onSave:(v:GenyTriggerPreset)=>Promise<GenyTriggerPreset>};
const colors=["#6366f1","#14b8a6","#f59e0b","#f472b6","#38bdf8","#a78bfa"];
function PromptEditor({value,label,onSave}:{value:string;label:string;onSave:(text:string)=>void}) {
 const [text,setText]=useState(value);
 const focused=useRef(false),edited=useRef(false);
 useEffect(()=>{if(!focused.current)setText(value);},[value]);
 return <textarea className="field min-h-28 w-full" aria-label={label} value={text}
   onFocus={()=>{focused.current=true;edited.current=false;}}
   onChange={e=>{edited.current=true;setText(e.target.value);}}
   onBlur={()=>{focused.current=false;if(edited.current&&text!==value)onSave(text);else setText(value);edited.current=false;}}/>;
}
export default function TriggerRulesEditor({initial,language,onSave}:Props){
 const t=useT();
 const [draft,setDraft]=useState(initial),[state,setState]=useState<"saved"|"preview"|"saving"|"error">("saved"),[error,setError]=useState("");
 const inFlight=useRef<GenyTriggerPreset|null>(null);
 const current=useRef(initial),pending=useRef<GenyTriggerPreset|null>(null),busy=useRef(false),dirty=useRef(false),save=useRef(onSave);
 save.current=onSave;
 useEffect(()=>{if(!dirty.current&&!busy.current){current.current=initial;setDraft(initial);}},[initial]);
 const update=(v:GenyTriggerPreset)=>{current.current=v;dirty.current=true;setDraft(v);};
 const commit=async()=>{
  if(!dirty.current || inFlight.current===current.current || pending.current===current.current)return;
  pending.current=current.current;
  if(busy.current)return;
  busy.current=true;setState("saving");
  try{while(pending.current){
   const next=pending.current;pending.current=null;inFlight.current=next;
   try{
    const saved=await save.current(next);
    setError("");
    if(!pending.current&&current.current===next){dirty.current=false;current.current=saved;setDraft(saved);setState("saved");}
   }catch(e){setError(String((e as Error).message));setState("error");}
  }}finally{inFlight.current=null;busy.current=false;if(dirty.current&&!error)setState(s=>s==="error"?s:"preview");}
 };
 const changeCategory=(id:string,v:Record<string,unknown>,preview=false)=>{
  const existing=current.current.categories.find(c=>c.id===id);
  if(existing&&Object.entries(v).every(([k,value])=>existing[k]===value))return;
  update({...current.current,categories:current.current.categories.map(c=>c.id===id?{...c,...v}:c)});
  if(preview)setState("preview");else void commit();
 };
 const timing=(key:keyof GenyTriggerPreset["timing"],value:number)=>{
  if(!Number.isFinite(value)||current.current.timing[key]===value)return;
  update({...current.current,timing:{...current.current.timing,[key]:value}});void commit();
 };
 const scale=useRef(sliderMaximum(initial.categories));
 scale.current=Math.max(scale.current,sliderMaximum(draft.categories));
 const shares=weightShares(draft.categories),maximum=scale.current;
 const levels=["screen.frequencyOff","screen.frequencyRare","screen.frequencyNormal","screen.frequencyOften","screen.frequencyVeryOften"] as const;
 const pct=(n:number)=>new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(n);
 return <div className="space-y-3" data-testid="trigger-rules-editor">
  <p role="status" className="text-xs text-content-faint" data-testid="trigger-save-state">{t(state==="preview"?"screen.weightPreview":state==="saving"?"screen.rulesSaving":state==="error"?"screen.rulesError":"screen.rulesSaved")}</p>
  {error&&<div role="alert" className="text-xs text-danger">{error}<button className="btn-ghost" onClick={()=>void commit()}>{t("common.retry")}</button></div>}
  <div className="space-y-2 rounded-xl border border-border p-3" data-testid="trigger-distribution">
   <p className="text-xs font-medium">{t("screen.weightDistribution")}</p>
   <div role="img" aria-label={draft.categories.map((c,i)=>`${c.label}: ${pct(shares[i])}%`).join(", ")} className="flex h-4 overflow-hidden rounded-full bg-surface-3">
    {draft.categories.map((c,i)=>c.weight>0&&<span key={c.id} title={`${c.label}: ${pct(shares[i])}%`} style={{width:`${shares[i]}%`,background:colors[i%colors.length]}}/>)}
   </div>
   <p className="text-xs text-content-faint">{shares.some(Boolean)?t("screen.weightDistributionHint"):t("screen.weightsAllOff")}</p>
  </div>
  {([['base_idle_seconds','screen.baseIdle',5],['max_idle_seconds','screen.maxIdle',5],['adaptive_scale_triggers','screen.adaptiveScale',1]] as const).map(([key,label,min])=><Field key={key} label={t(label)}>
   <input className="field" type="number" min={min} defaultValue={draft.timing[key]} key={draft.timing[key]} onBlur={e=>{if(e.currentTarget.value!==""&&e.currentTarget.checkValidity())timing(key,Number(e.currentTarget.value));}}/>
  </Field>)}
  {draft.categories.map((c,i)=><details className="rounded-xl border border-border p-3 text-xs" key={c.id} data-testid={`trigger-category-${c.id}`}>
   <summary className="cursor-pointer select-none">
    <span aria-hidden="true" className="mr-2 inline-block h-2 w-2 rounded-full" style={{background:colors[i%colors.length],opacity:c.weight>0?1:.3}}/><span className="font-medium">{c.label}</span><span className="ml-2 text-content-dim">{t(levels[frequencyLevel(c.weight,shares[i])])} · {pct(shares[i])}%</span>
   </summary>
   <div className="mt-3 space-y-3">
    <label className="block space-y-1">
     <span className="flex flex-wrap justify-between gap-2"><span>{t("screen.weight")}</span><output>{t(levels[frequencyLevel(c.weight,shares[i])])} · {t("screen.weightValue",{value:c.weight})}</output></span>
     <input type="range" min={0} max={maximum} step="any" value={c.weight} aria-label={`${c.label} ${t("screen.weight")}`} aria-valuetext={`${t(levels[frequencyLevel(c.weight,shares[i])])}, ${c.weight}, ${pct(shares[i])}%`} className="h-11 w-full cursor-pointer accent-accent touch-pan-y" data-testid={`trigger-weight-${c.id}`} onChange={e=>changeCategory(c.id,{weight:Number(e.target.value)},true)} onPointerUp={()=>void commit()} onPointerCancel={()=>void commit()} onKeyUp={()=>void commit()} onBlur={()=>void commit()}/>
     <span className="flex justify-between text-content-faint"><span>{t("screen.frequencyOff")}</span><span>{t("screen.frequencyVeryOften")}</span></span>
    </label>
    <p data-testid={`trigger-ratio-${c.id}`}>{t("screen.weightProbability",{percent:pct(shares[i])})}</p>
    <Field as="div" label={t("screen.cooldown")}>
     <div className="flex flex-wrap gap-2">
      {cooldownPresets.map(n=><button key={n} type="button" className={`btn-ghost min-h-10 ${c.cooldown_seconds===n?'bg-accent-soft text-accent':''}`} aria-pressed={c.cooldown_seconds===n} onClick={()=>changeCategory(c.id,{cooldown_seconds:n})} data-testid={`trigger-cooldown-${c.id}-${n}`}>{n===0?t("screen.noCooldown"):n<60?t("screen.seconds",{count:n}):t("screen.minutes",{count:n/60})}</button>)}
     </div>
     <label className="mt-2 flex flex-wrap items-center gap-2">{t("screen.cooldownCustom")}<input type="number" min={0} step="any" className="field min-w-0 flex-1" aria-label={`${c.label} ${t("screen.cooldownCustom")}`} defaultValue={c.cooldown_seconds} key={c.cooldown_seconds} onBlur={e=>{if(e.currentTarget.value!==""&&e.currentTarget.checkValidity())changeCategory(c.id,{cooldown_seconds:Number(e.target.value)});}}/></label>
    </Field>
    <p>{t("screen.genyPrompts")}</p>
    {c.prompt_refs.map(ref=>{const prompt=draft.prompts.find(x=>x.id===ref.prompt_id);return prompt?<PromptEditor key={`${prompt.id}-${language}`} label={`${c.label} ${t("screen.genyPrompts")}`} value={prompt.content[language]||prompt.content.en||""} onSave={text=>{
     update({...current.current,prompts:current.current.prompts.map(x=>x.id===prompt.id?{...x,content:{...x.content,[language]:text}}:x)});void commit();
    }}/>:null;})}
   </div>
  </details>)}
 </div>;
}
