import {test} from 'node:test';
import assert from 'node:assert/strict';

const documentEvents=new EventTarget();
let rejectPlay=true,finishPlay:(()=>void)|undefined;
class AudioElement extends EventTarget {
 dataset:Record<string,string>={};src='';paused=true;ended=false;volume=1;preload='';error=null;
 setAttribute(){} removeAttribute(){this.src='';} load(){} pause(){this.paused=true;}
 play(){
  if(rejectPlay)return Promise.reject(new DOMException('Gesture required','NotAllowedError'));
  return new Promise<void>(resolve=>{finishPlay=()=>{this.paused=false;resolve();};});
 }
}
Object.assign(globalThis,{document:documentEvents,window:new EventTarget(),Audio:AudioElement,HTMLMediaElement:AudioElement,
 requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{},localStorage:{getItem:()=>null}});
const {MateAudioQueue}=await import('../src/mate/audioQueue.ts');
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('autoplay failure never claims a sentence as spoken; a successful retry claims it once',async()=>{
 const queue=new MateAudioQueue();let starts=0;queue.onItemStart=()=>starts++;
 try{
  queue.enqueue({source:'local.wav',text:'아직 읽지 않았어요.'});await flush();
  assert.equal(queue.getState().blocked,true);assert.equal(starts,0);
  rejectPlay=false;documentEvents.dispatchEvent(new Event('pointerdown'));await flush();
  assert.equal(starts,0,'play promise is still pending');finishPlay!();await flush();
  assert.equal(starts,1);assert.equal(queue.getState().blocked,false);
  documentEvents.dispatchEvent(new Event('pointerdown'));await flush();assert.equal(starts,1);
 }finally{queue.dispose();}
});

test('cancel during synthesis or a pending play never announces the canceled sentence',async()=>{
 const queue=new MateAudioQueue();let starts=0;queue.onItemStart=()=>starts++;
 let resolveClip:(v:string)=>void=()=>{};
 queue.setResolver(()=>new Promise(resolve=>{resolveClip=resolve;}));
 queue.enqueue({text:'취소한 합성'});queue.stop();resolveClip('local.wav');await flush();assert.equal(starts,0);
 queue.enqueue({source:'local.wav',text:'취소한 재생'});await flush();queue.stop();finishPlay!();await flush();
 assert.equal(starts,0);queue.dispose();
});

test('browser speech is claimed on onstart, never at synthesis dispatch or failure',async()=>{
 let utterance:any;
 Object.assign(globalThis,{SpeechSynthesisUtterance:class {text:string;constructor(text:string){this.text=text;}},speechSynthesis:{getVoices:()=>[],cancel(){},speak(u:unknown){utterance=u;}}});
 const queue=new MateAudioQueue();let starts=0,errors=0;queue.onItemStart=()=>starts++;queue.onError=()=>errors++;
 queue.speakBrowser('안녕하세요.');await flush();assert.equal(starts,0);
 utterance.onstart();assert.equal(starts,1);utterance.onend();await flush();
 queue.speakBrowser('재생되지 않아요.');await flush();utterance.onerror({error:'not-allowed'});await flush();
 assert.equal(starts,1);assert.equal(errors,1);queue.dispose();
});
