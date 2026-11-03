"use strict";
// Only an explicit Stop changes saved intent. Transport loss/permissions/targets pause runtime access.
function createSharing({ broadcast, cancel, preferences, changed = () => {} }) {
  let owner=null,state=null,revision=0,reservation=null,reservationOrigin="",reason="waiting_connection",previousThrottling=null;
  const watched=new WeakSet();
  const enabled=()=>preferences ? preferences.get().sharing.enabled : !!state;
  const status=()=>!enabled()?"off":state?"ready":reason;
  function snapshot(sender){return {revision,state,owner:!!owner&&sender?.id===owner.id,enabled:enabled(),status:status()};}
  function announce(){revision++;broadcast(w=>snapshot(w));changed(!!state,!!state?.capturing,status());}
  function release(nextReason,type="pause"){
    const old=owner;reservation=null;reservationOrigin="";
    if(old&&!old.isDestroyed()&&previousThrottling!==null)old.setBackgroundThrottling?.(previousThrottling);
    previousThrottling=null;owner=null;state=null;reason=nextReason;
    cancel();if(old&&!old.isDestroyed())old.send("capture:control",{type,reason:nextReason});announce();
  }
  function pause(value="waiting_connection"){
    const valid=["waiting_connection","waiting_auth","waiting_target","waiting_permission","waiting_session","error"];
    release(valid.includes(value)?value:"error");
  }
  function stop(remember=true){
    if(remember&&preferences)preferences.patch({sharing:{enabled:false}});
    release("waiting_connection",remember?"stop":"pause");
  }
  function publish(sender,next){
    if(!next){if(owner?.id===sender.id)release("waiting_connection");return snapshot(sender);}
    if(typeof next.sid!=="string"||!["ask","on_turn","observe"].includes(next.mode))return snapshot(sender);
    const saved=preferences?.get().sharing;
    if(next.restoring&&(reservation?.id!==sender.id||!enabled()||saved?.sid!==next.sid||saved?.origin!==reservationOrigin))return snapshot(sender);
    if(owner&&owner.id!==sender.id)release("waiting_connection");
    if(!owner){
      owner=sender;previousThrottling=sender.getBackgroundThrottling?.()??true;sender.setBackgroundThrottling?.(false);
      if(!watched.has(sender)){watched.add(sender);sender.once("destroyed",()=>{if(owner?.id===sender.id)pause();if(reservation?.id===sender.id){reservation=null;announce();}});}
    }
    reservation=null;reservationOrigin="";reason="waiting_connection";
    state={sid:next.sid.slice(0,100),name:String(next.name||"").slice(0,100),source:String(next.source||"").slice(0,200),kind:next.kind==="window"?"window":"screen",mode:next.mode,interval:Math.max(60,Math.min(600,Number(next.interval)||180)),capturing:!!next.capturing,error:String(next.error||"").slice(0,400)};
    announce();return snapshot(sender);
  }
  function claim(sender,origin){
    const saved=preferences?.get().sharing;
    if(!saved?.enabled||saved.origin!==origin||owner||(reservation&&!reservation.isDestroyed()&&reservation.id!==sender.id))return false;
    if(reservation?.id===sender.id)return true;
    reservation=sender;reservationOrigin=origin;sender.once("destroyed",()=>{if(reservation?.id===sender.id){reservation=null;reservationOrigin="";announce();}});return true;
  }
  return {snapshot,publish,stop,pause,claim,pending:()=>!!reservation,mode:(mode,interval)=>{if(owner&&!owner.isDestroyed())owner.send("capture:control",{type:"mode",mode,interval});},active:()=>!!state};
}
module.exports={createSharing};
