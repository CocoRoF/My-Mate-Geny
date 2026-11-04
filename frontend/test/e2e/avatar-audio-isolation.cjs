// Real Electron + original Han Chaerin media. Verify no VIDEO mutation at audio start/end/stop.
const {App,fill,until,sleep}=require('../../../desktop/test/e2e/screen-capture-e2e');
const {chromium}=require('playwright-core'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const [server,password]=process.argv.slice(2),shots=process.env.SCREEN_SHOTS,baseline=process.env.AVATAR_AUDIO_EXPECT_COUPLED==='1';
function wav(seconds){const rate=8000,n=Math.round(rate*seconds),b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);return 'data:audio/wav;base64,'+b.toString('base64');}
(async()=>{
 const app=new App(fs.mkdtempSync(path.join(os.tmpdir(),'geny-audio-isolation-')),9630,10130);let browser;
 try{
  app.start();const connect=await app.page(/connect\.html/);await until('connect',()=>connect.eval('!!window.hrhConnect'));await connect.eval(fill(server,'admin',password));
  await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)(?!\\?surface=)'));
  browser=await chromium.connectOverCDP('http://127.0.0.1:9630');const ctx=browser.contexts()[0];
  await ctx.addInitScript(()=>{
   localStorage.setItem('hrh_lang','ko');window.__videos=[];window.__videoWrites=[];
   const make=Document.prototype.createElement;Document.prototype.createElement=function(...args){const e=make.apply(this,args);if(String(args[0]).toLowerCase()==='video')window.__videos.push(e);return e;};
   for(const key of ['playbackRate','defaultPlaybackRate','currentTime','loop','src']){
    const d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,key);if(!d?.set)continue;
    Object.defineProperty(HTMLMediaElement.prototype,key,{...d,set(value){if(this.tagName==='VIDEO')window.__videoWrites.push({key,value,at:performance.now()});d.set.call(this,value);}});
   }
   for(const key of ['play','pause','load']){const fn=HTMLMediaElement.prototype[key];HTMLMediaElement.prototype[key]=function(...args){if(this.tagName==='VIDEO')window.__videoWrites.push({key,at:performance.now()});return fn.apply(this,args);};}
  });
  const api=async(url,method='GET',data)=>{const r=await ctx.request.fetch(server+url,{method,...(data?{data}:{})});assert(r.ok(),await r.text());return r.json();};
  const original=(await api('/api/mates')).find(m=>m.name==='한채린'),results=[];
  const main=ctx.pages().find(p=>p.url().startsWith(server)&&!p.url().includes('surface='));
  async function check(page,surface){
   await page.waitForSelector('[data-mate-shown="1"]');
   for(const mode of ['natural-end','cancel','three-short-fragments']){
    await page.evaluate(()=>window.__hrhMateAudio.stop());
    await until('fresh idle cycle',()=>page.evaluate(()=>document.querySelector('[data-mate-body=video]')?.dataset.mateClip==='idle_a'&&window.__videos.some(v=>!v.paused&&v.currentTime>.1&&v.currentTime<.8)),12000);
    const result=await page.evaluate(async({mode,short,long})=>{
     const v=window.__videos.find(v=>!v.paused&&!v.ended),at=performance.now(),t=v.currentTime;
     window.__videoWrites=[];const q=window.__hrhMateAudio;
     if(mode==='three-short-fragments'){
      for(let i=0;i<3;i++){q.enqueue({source:short});await new Promise(r=>setTimeout(r,350));}
      await new Promise(r=>setTimeout(r,700));
     }else{
      q.enqueue({source:long});
      if(mode==='cancel'){await new Promise(r=>setTimeout(r,250));q.stop();}
      await new Promise(r=>setTimeout(r,mode==='cancel'?1000:1800));
     }
     return {mode,writes:window.__videoWrites,clip:document.querySelector('[data-mate-body=video]').dataset.mateClip,videoMood:document.querySelector('[data-mate-body=video]').dataset.videoMood,rate:v.playbackRate,slope:(v.currentTime-t)/((performance.now()-at)/1000),audioFinished:!q.getState().current};
    },{mode,short:wav(.18),long:wav(1)});
    results.push({surface,...result});
    if(baseline)assert(result.writes.length>0,'reproduces residual audio-to-video control');else{
     assert.deepEqual(result.writes,[],surface+' '+mode);assert.equal(result.clip,'idle_a');assert.equal(result.videoMood,'idle');assert.equal(result.rate,1);assert(result.slope>.8&&result.slope<1.2,JSON.stringify(result));assert(result.audioFinished);
    }
    console.log(surface,mode,'video mutations',result.writes.length,'rate',result.rate);
   }
   if(!baseline && (surface==='console-stacked-alpha'||surface==='overlay')){
    await until('fresh cycle for long audio',()=>page.evaluate(()=>window.__videos.some(v=>!v.paused&&v.currentTime>.1&&v.currentTime<.8)),12000);
    const result=await page.evaluate(async src=>{
     window.__videoWrites=[];const at=performance.now(),clips=new Set();
     const timer=setInterval(()=>clips.add(document.querySelector('[data-mate-body=video]').dataset.mateClip),25);
     window.__hrhMateAudio.enqueue({source:src});await new Promise(r=>setTimeout(r,7300));clearInterval(timer);
     return {clips:[...clips],postAudioEndWrites:window.__videoWrites.filter(w=>w.at-at>6300),rates:window.__videos.map(v=>v.playbackRate),audioFinished:!window.__hrhMateAudio.getState().current};
    },wav(6.4));
    assert.deepEqual(result.clips,['idle_a']);assert.deepEqual(result.postAudioEndWrites,[]);assert(result.rates.every(r=>r===1));assert(result.audioFinished);
    results.push({surface,mode:'long-audio-crosses-natural-video-end',...result});
    console.log(surface,'long audio across natural video end: no audio-driven clip change');
   }
   await page.screenshot({path:path.join(shots,(baseline?'before':'after')+'-'+surface+'.png')});
  }
  for(const packing of ['stacked-alpha','plain']){
   const rig=structuredClone(original.avatar.rig);rig.packing=packing;rig.clips=rig.clips.filter(c=>['idle_a','talk_a','smile'].includes(c.id));rig.clips.find(c=>c.id==='idle_a').loop=true;
   const mate=await api('/api/mates','POST',{name:'Audio independent '+packing,persona:{greeting:''},avatar:{kind:'video',rig},voice:{auto_read:true,tts:{engine:'browser'}}});
   await main.goto(server+'/?view=mate');await main.evaluate(id=>localStorage.setItem('hrh_mate_active',id),mate.id);await main.reload();await main.getByTestId('mate-settings-open').waitFor();await check(main,'console-'+packing);
   if(packing==='stacked-alpha'){
    await main.evaluate(id=>window.hrhNative.mate.showAvatar(id).then(()=>window.hrhNative.mate.openChat()),mate.id);
    const overlay=await until('overlay',()=>ctx.pages().find(p=>p.url().includes('surface=mate-overlay')));await overlay.reload();await check(overlay,'overlay');
    const chat=await until('chat',()=>ctx.pages().find(p=>p.url().includes('surface=mate-chat')));await chat.reload();await check(chat,'chat');
    await main.evaluate(()=>window.hrhNative.mate.hideAvatar());
   }
  }
  fs.writeFileSync(path.join(shots,'audio-isolation.json'),JSON.stringify(results,null,2));console.log(baseline?'REPRODUCED RESIDUAL AUDIO COUPLING':'AVATAR AUDIO ISOLATION E2E OK');
 }finally{await app.stop();if(browser)await browser.close().catch(()=>{});}
})().catch(e=>{console.error(e);process.exit(1)});
