import {test} from 'node:test';
import assert from 'node:assert/strict';
const device='dev_0123456789abcdef0123456789abcdef';
Object.assign(globalThis,{window:Object.assign(new EventTarget(),{hrhNative:{deviceIdentity:{deviceId:device}}}),localStorage:{getItem:()=> 'olderdevice',setItem(){}}});
Object.defineProperty(globalThis,'BroadcastChannel',{value:undefined,configurable:true});
const interval=globalThis.setInterval;globalThis.setInterval=((...args:any[])=>{const t=(interval as any)(...args);t.unref();return t;}) as typeof interval;
const {deviceId,deviceOf,clientMsgId}=await import('../src/mate/voiceOwner.ts');
globalThis.setInterval=interval;
test('stable native device identity is preserved through message and TTS ownership routing',()=>{
 assert.equal(deviceId,device);assert.equal(deviceOf(clientMsgId('m')),device);
 assert.equal(deviceOf('reply~olderdevice'),'olderdevice');
 assert.equal(deviceOf('reply~dev_bad'),null);assert.equal(deviceOf(null),null);
});
