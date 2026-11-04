import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlainPlayer} from '../src/mate/avatar/player.ts';
import {activityMood} from '../src/mate/activityMood.ts';

test('video intent is conversation activity, with no audio playback input',()=>{
 assert.equal(activityMood(false,false,false,false),'idle');
 assert.equal(activityMood(true,true,false,false),'talking');
 assert.equal(activityMood(true,false,true,true),'thinking');
 assert.equal(activityMood(false,false,true,true),'listening');
 assert.equal(activityMood(false,false,false,true),'away');
});
test('plain slots remain 1x across loop exit, reuse, pause and restore',()=>{
 class Video extends EventTarget {
  duration=5;currentTime=0;readyState=4;seeking=false;paused=true;ended=false;loop=false;playbackRate=1;defaultPlaybackRate=1;src='';style:any={};
  setAttribute(){}removeAttribute(){}load(){}remove(){}pause(){this.paused=true;}play(){this.paused=false;return Promise.resolve();}
 }
 const videos:Video[]=[];
 Object.assign(globalThis,{document:{createElement(){const v=new Video();videos.push(v);return v;}},requestAnimationFrame:()=>0});
 const player=new PlainPlayer({appendChild(){}} as any);
 try{
  player.show('idle.mp4',{loop:true});
  assert(videos.every(v=>v.playbackRate===1&&v.defaultPlaybackRate===1));
  const current=videos.find(v=>!v.paused)!;current.currentTime=2;
  player.prepare('next.mp4');assert.equal(current.currentTime,2);assert.equal(current.loop,true);assert.equal(current.paused,false);
  videos.forEach(v=>{v.playbackRate=4;v.defaultPlaybackRate=4;});player.setPaused(true);
  assert(videos.every(v=>v.paused&&v.playbackRate===1&&v.defaultPlaybackRate===1));
  player.setPaused(false);player.show('talk.mp4');player.show('idle.mp4');
  assert(videos.every(v=>v.playbackRate===1&&v.defaultPlaybackRate===1));
 }finally{player.dispose();}
});
