"use strict";
function connectionKey(settings, base) {
  if (settings.launchMode === "local" || base === settings.localOrigin) return "local";
  if (base === "local") return base;
  try { const u = new URL(base); return /^https?:$/.test(u.protocol) ? u.origin + u.pathname.replace(/\/+$/, "") : ""; } catch { return ""; }
}
function createSetupHistory({readSettings,writeSettings}) {
  function migrate() {
    const s=readSettings();if(s.setupSeenVersion===1)return s;
    const seen={...s.setupSeen};
    for(const [key,value] of Object.entries(s.setupCompleted||{}))if(value)seen[connectionKey({},key)]=true;
    // An installed app that already connected must not reopen onboarding after an update.
    if(s.localOrigin)seen.local=true;
    if(s.serverUrl){const key=connectionKey(s,s.serverUrl);if(key)seen[key]=true;}
    return writeSettings({setupSeen:seen,setupSeenVersion:1},{strict:true});
  }
  function seen(base){const s=migrate(),key=connectionKey(s,base);return !!key&&!!(s.setupSeen?.[key]||s.setupCompleted?.[key]);}
  function mark(base,complete=false){const s=migrate(),key=connectionKey(s,base);if(!key)return false;
    writeSettings({setupSeen:{...s.setupSeen,[key]:true},...(complete?{setupCompleted:{...s.setupCompleted,[key]:true}}:{})},{strict:true});return true;
  }
  return {migrate,seen,mark};
}
module.exports={connectionKey,createSetupHistory};
