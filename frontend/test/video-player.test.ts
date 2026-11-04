import {test} from 'node:test';
import assert from 'node:assert/strict';
import {finishVideo,PlainPlayer} from '../src/mate/avatar/player.ts';

function clip(patch:Record<string,unknown>={}){
 return {duration:5,currentTime:1.2,ended:false,paused:false,loop:true,playbackRate:4,defaultPlaybackRate:4,plays:0,
  play(){this.plays++;this.paused=false;return Promise.resolve();},...patch} as unknown as HTMLVideoElement&{plays:number};
}
test('a voice/reaction transition finishes the remaining motion at 1x without seeking',()=>{
 const v=clip();assert.equal(finishVideo(v,false),true);
 assert.equal(v.playbackRate,1);assert.equal(v.defaultPlaybackRate,1);assert.equal(v.loop,false);
 assert.equal(v.currentTime,1.2);assert.equal(v.plays,0);
});
test('a hidden avatar stays paused; an active avatar can resume without acceleration',()=>{
 const v=clip({paused:true});assert.equal(finishVideo(v,true),true);assert.equal(v.plays,0);
 assert.equal(finishVideo(v,false),true);assert.equal(v.plays,1);assert.equal(v.playbackRate,1);
});
test('ended and not-yet-loaded clips cannot acquire a fast playback rate',()=>{
 for(const patch of [{ended:true},{duration:NaN},{duration:Infinity},{duration:0}]){
  const v=clip(patch);assert.equal(finishVideo(v,false),false);assert.equal(v.playbackRate,1);assert.equal(v.defaultPlaybackRate,1);assert.equal(v.currentTime,1.2);
 }
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
  player.show('idle.mp4',{loop:true});assert.equal(player.finishAtBoundary(),true);
  assert(videos.every(v=>v.playbackRate===1&&v.defaultPlaybackRate===1));
  videos.forEach(v=>{v.playbackRate=4;v.defaultPlaybackRate=4;});player.setPaused(true);
  assert(videos.every(v=>v.paused&&v.playbackRate===1&&v.defaultPlaybackRate===1));
  player.setPaused(false);player.show('talk.mp4');player.show('idle.mp4');
  assert(videos.every(v=>v.playbackRate===1&&v.defaultPlaybackRate===1));
 }finally{player.dispose();}
});
