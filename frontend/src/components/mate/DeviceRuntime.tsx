import {useEffect,useState} from "react";
import {useSessionSync} from "../../hooks/useSessionSync";
import {useMateStore} from "../../stores/mateStore";
import {devicePreferences,loadDevicePreferences,patchDevicePreferences,useDevicePreferences,subscribeDevicePreferences} from "../../stores/devicePreferences";
import {resumeSharing,subscribeSharing} from "../../mate/localScreen";
import {setDeviceEventHello} from "../../mate/deviceEvents";
import {useMateConversation} from "../../mate/useMateConversation";
import {ScreenCaptureApproval} from "../composer/LocalScreenControls";
/** A hidden app-lifetime renderer owns connections/capture while every user-facing window may close. */
export default function DeviceRuntime(){
 useSessionSync({sessions:false});
 const prefs=useDevicePreferences(),mates=useMateStore(s=>s.mates);
 const [selected,setSelected]=useState<string|null>(null);
 const targetId=prefs.screen.proactive_enabled ? prefs.screen.proactive_mate||selected : prefs.sharing.mate_id||selected;
 const mate=mates.find(m=>m.id===targetId)||null;
 useMateConversation(mate,{connect:!!prefs.screen.proactive_enabled||prefs.sharing.enabled});
 useEffect(()=>{
  let alive=true,busy=false;
  const tick=async()=>{
   if(busy||!alive)return;busy=true;
   try{
    const prefs=await loadDevicePreferences();
    const store=useMateStore.getState();
    if(!store.loaded||store.error)await store.load();
    const context=await window.hrhNative?.device?.context?.();
    const mates=useMateStore.getState().mates;
    const id=prefs.screen.proactive_mate||context?.mateId;
    const mate=mates.find(m=>m.id===id)||mates.find(m=>m.is_default)||mates[0];
    if(!mate||!context)return;
    if(prefs.screen.proactive_enabled && !prefs.screen.proactive_mate)
      await patchDevicePreferences({screen:{proactive_mate:mate.id}});
    if(alive)setSelected(mate.id);
    const events=await window.hrhNative?.device?.events?.(mate.id)||[];
    if(alive)setDeviceEventHello({device_runtime:true,device_boot:context.bootId,device_start_reason:context.startReason,device_mate_id:mate.id,device_events:events});
    // Conversation recreation never changes saved device intent. Resolve the same Mate only.
    const intent=devicePreferences().sharing;
    if(intent.enabled && intent.origin===location.origin && intent.mate_id){
     const target=mates.find(m=>m.id===intent.mate_id);
     if(target && target.session_id!==intent.sid){
      const r=await fetch(`/api/mates/${encodeURIComponent(target.id)}/conversation`,{method:"POST"});
      if(r.ok){const v=await r.json();await patchDevicePreferences({sharing:{sid:v.session_id}});}
     }
    }
    await resumeSharing();
   }finally{busy=false;}
  };
  void tick().catch(()=>{});
  const timer=setInterval(()=>void tick().catch(()=>{}),5000);
  const offPrefs=subscribeDevicePreferences(()=>{void tick().catch(()=>{});});
  const off=subscribeSharing(()=>{void tick().catch(()=>{});});
  return()=>{alive=false;clearInterval(timer);off();offPrefs();};
 },[]);
 // Native consent dialogs are separate visible windows; this renderer itself never becomes visible.
 return <ScreenCaptureApproval/>;
}
