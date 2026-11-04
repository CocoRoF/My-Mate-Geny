import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplySpeechControl, readsReplies, voiceSettingsDraft } from '../src/mate/replySpeechControl.ts';
import type { MateVoice } from '../src/api/mates.ts';
const voice = {auto_read:true,volume:2.5,tts:{engine:'browser',speed:1.2},stt:{engine:'whisper',auto_send:true}} as MateVoice;
test('all reply switches use the saved field, device mute and selected voice engine',()=>{
 assert.equal(readsReplies(voice,false),true);
 assert.equal(readsReplies(voice,true),false);
 assert.equal(readsReplies({...voice,auto_read:false},false),false);
 assert.equal(readsReplies({...voice,tts:{...voice.tts,engine:'off'}},false),false);
});
test('saving an old voice draft never overwrites the immediate reply switch or device volume',()=>{
 const draft=voiceSettingsDraft(voice);
 assert.equal('auto_read' in draft,false);assert.equal('volume' in draft,false);
 assert.deepEqual(draft,{tts:voice.tts,stt:voice.stt});
 assert.deepEqual(voiceSettingsDraft({...voice,auto_read:false}),draft);
});
test('turning off hushes every window immediately; rapid clicks make one write',async()=>{
 const events:any[]=[];let finish!:()=>void;
 const c=createReplySpeechControl({hush:id=>events.push(['hush',id]),unmute:()=>events.push(['unmute']),save:(id,on)=>{events.push(['save',id,on]);return new Promise<void>(r=>{finish=r});}});
 const changes:boolean[]=[];c.subscribe(()=>changes.push(c.busy('m')));
 const p=c.set('m',false);assert.equal(c.busy('m'),true);assert.deepEqual(events,[['hush','m']]);
 assert.equal(c.set('m',true),p);await Promise.resolve();finish();await p;
 assert.deepEqual(events,[['hush','m'],['save','m',false]]);assert.deepEqual(changes,[true,false]);
});
test('enabling clears legacy device mute only after a successful partial save; errors unlock retry',async()=>{
 const events:any[]=[];let fail=true;
 const c=createReplySpeechControl({hush:id=>events.push(['hush',id]),unmute:()=>events.push(['unmute']),save:async(id,on)=>{events.push(['save',id,on]);if(fail)throw Error('offline');}});
 await assert.rejects(c.set('m',true),/offline/);assert.equal(c.busy('m'),false);assert.deepEqual(events,[['save','m',true]]);
 fail=false;await c.set('m',true);assert.deepEqual(events,[['save','m',true],['save','m',true],['unmute']]);
});
