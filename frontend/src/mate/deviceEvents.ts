/** Lifecycle messages are owned by the desktop controller, never by each visible window. */
let metadata:Record<string,unknown>={};
const KEY="hrh_browser_device_events";
function browserEvents():{id:string;type:string;mate_id:string}[]{try{const v=JSON.parse(localStorage.getItem(KEY)||"[]");return Array.isArray(v)?v:[];}catch{return [];}}
export function queueBrowserEnabled(mateId:string){
 if(window.hrhNative||!mateId)return;
 localStorage.setItem(KEY,JSON.stringify([...browserEvents(),{id:crypto.randomUUID(),type:"enabled",mate_id:mateId}].slice(-30)));
}
export function ackBrowserEvents(ids:string[]){
 if(window.hrhNative)return;
 localStorage.setItem(KEY,JSON.stringify(browserEvents().filter(e=>!ids.includes(e.id))));
 window.dispatchEvent(new Event("hrh:screen-sharing"));
}
export const deviceEventHello=()=>{
 if(window.hrhNative)return metadata;
 const events=browserEvents();
 return events.length?{device_runtime:true,device_boot:"browser",device_mate_id:events[events.length-1].mate_id,device_events:events}:{};
};
export function setDeviceEventHello(value:Record<string,unknown>){
 if(JSON.stringify(value)===JSON.stringify(metadata))return;
 metadata=value;window.dispatchEvent(new Event("hrh:screen-sharing"));
}
