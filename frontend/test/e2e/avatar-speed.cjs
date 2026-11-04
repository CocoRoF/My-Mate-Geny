// Actual Electron, actual Han Chaerin MP4s and voice bridge; isolated server, no model/TTS provider calls.
const {App,fill,until,sleep}=require('../../../desktop/test/e2e/screen-capture-e2e');
const {chromium}=require('playwright-core'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const [server,password]=process.argv.slice(2),shots=process.env.SCREEN_SHOTS;
function tone(){const n=8000,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(n,24);b.writeUInt32LE(n*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);return 'data:audio/wav;base64,'+b.toString('base64');}
(async()=>{
 const app=new App(fs.mkdtempSync(path.join(os.tmpdir(),'geny-avatar-speed-')),9650,10150);let browser;
 try{
  app.start();const connect=await app.page(/connect\.html/);await until('connect',()=>connect.eval('!!window.hrhConnect'));await connect.eval(fill(server,'admin',password));
  await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)(?!\\?surface=)'));
  browser=await chromium.connectOverCDP('http://127.0.0.1:9650');const ctx=browser.contexts()[0];
  await ctx.addInitScript(()=>{
   localStorage.setItem('hrh_lang','ko');window.__videos=[];window.__rates=[];
   const make=Document.prototype.createElement;
   Document.prototype.createElement=function(...args){const el=make.apply(this,args);if(String(args[0]).toLowerCase()==='video'){
    window.__videos.push(el);el.addEventListener('ratechange',()=>window.__rates.push({rate:el.playbackRate,at:performance.now()}));
   }return el;};
   const Native=window.WebSocket;window.WebSocket=class extends Native{constructor(...args){super(...args);if(String(args[0]).includes('/ws/chat/'))window.__chat=this;}};
  });
  const api=async(url,method='GET',data)=>{const r=await ctx.request.fetch(server+url,{method,...(data?{data}:{})});assert(r.ok(),await r.text());return r.json();};
  const builtin=(await api('/api/mates')).find(m=>m.name==='한채린');assert(builtin);
  const results=[];
  for(const packing of ['stacked-alpha','plain']){
   const rig=structuredClone(builtin.avatar.rig);
   rig.packing=packing;
   rig.clips=rig.clips.filter(c=>['idle_a','talk_a','smile','doze'].includes(c.id));
   assert(rig.clips.some(c=>c.kind==='react'));
   // Explicit looping idle exercises leaving a loop. Plain uses the same real MP4's full image for timing.
   rig.clips.find(c=>c.id==='idle_a').loop=true;
   const mate=await api('/api/mates','POST',{name:'Avatar speed '+packing,avatar:{kind:'video',rig},voice:{auto_read:false}});
   const page=ctx.pages().find(p=>p.url().startsWith(server)&&!p.url().includes('surface='));
   await page.goto(server+'/?view=mate');await page.evaluate(id=>localStorage.setItem('hrh_mate_active',id),mate.id);await page.reload();
   await page.getByTestId('mate-settings-open').waitFor();
   await page.waitForSelector('[data-mate-shown="1"]');
   await until('native video advancing',()=>page.evaluate(()=>window.__videos.some(v=>!v.paused&&v.currentTime>.15)));
   await page.evaluate(src=>window.__hrhMateAudio.enqueue({source:src,text:'Local playback timing check'}),tone());
   await sleep(250);
   const sample=await page.evaluate(async()=>{
    const v=window.__videos.find(v=>!v.paused&&!v.ended),t=v.currentTime,at=performance.now();
    await new Promise(r=>setTimeout(r,500));
    return {rate:v.playbackRate,slope:(v.currentTime-t)/((performance.now()-at)/1000),rates:window.__rates.map(x=>x.rate)};
   });
   results.push({packing,phase:'voice-start',...sample});
   if(process.env.AVATAR_EXPECT_BROKEN==='1')assert(sample.rates.some(r=>r>1));else{
    assert(sample.rates.every(r=>r===1));assert(sample.slope>.7&&sample.slope<1.3,JSON.stringify(sample));
    await page.evaluate(()=>{
     const ws=window.__chat,stamp=new Date().toISOString();
     for(const [type,data] of [['session.start',{}],['text.delta',{text:'[smile] 반가워요.'}],['turn.complete',{text:'[smile] 반가워요.'}]])
       ws.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type,data,timestamp:stamp})}));
    });
    await until('reaction at a natural boundary',()=>page.evaluate(()=>document.querySelector('[data-mate-body=video]').dataset.mateClip==='smile'),12000);
    await app.main("cwin().minimize();return true");await sleep(300);await app.main("cwin().restore();cwin().show();return true");await sleep(600);
    const rates=await page.evaluate(()=>window.__videos.map(v=>({rate:v.playbackRate,defaultRate:v.defaultPlaybackRate})));
    assert(rates.every(v=>v.rate===1&&v.defaultRate===1));results.push({packing,phase:'reaction-and-restore',rates});
    await until('reaction ends and the reused idle slot resumes',()=>page.evaluate(()=>document.querySelector('[data-mate-body=video]').dataset.mateClip==='idle_a'),10000);
    assert(await page.evaluate(()=>window.__videos.every(v=>v.playbackRate===1&&v.defaultPlaybackRate===1)));
   }
   await page.screenshot({path:path.join(shots,(process.env.AVATAR_EXPECT_BROKEN==='1'?'before':'after')+'-'+packing+'.png')});
   console.log(packing,JSON.stringify(sample));
   if(packing==='stacked-alpha'){
    await page.evaluate(id=>window.hrhNative.mate.showAvatar(id),mate.id);
    const overlay=await until('native avatar overlay',()=>ctx.pages().find(p=>p.url().includes('surface=mate-overlay')));
    await overlay.reload();await overlay.waitForSelector('[data-mate-shown="1"]');
    await until('overlay video advancing',()=>overlay.evaluate(()=>window.__videos.some(v=>!v.paused&&v.currentTime>.15)));
    await overlay.evaluate(src=>window.__hrhMateAudio.enqueue({source:src,text:'Overlay timing check'}),tone());await sleep(250);
    const timing=await overlay.evaluate(async()=>{
     const v=window.__videos.find(v=>!v.paused&&!v.ended),t=v.currentTime,at=performance.now();await new Promise(r=>setTimeout(r,500));
     return {rate:v.playbackRate,slope:(v.currentTime-t)/((performance.now()-at)/1000),rates:window.__rates.map(x=>x.rate)};
    });
    if(process.env.AVATAR_EXPECT_BROKEN==='1')assert(timing.rates.some(r=>r>1));else{assert.equal(timing.rate,1);assert(timing.slope>.7&&timing.slope<1.3);}
    results.push({packing,phase:'native-small-overlay',...timing});
    await overlay.screenshot({path:path.join(shots,(process.env.AVATAR_EXPECT_BROKEN==='1'?'before':'after')+'-native-overlay.png')});
    console.log('native-overlay',JSON.stringify(timing));await page.evaluate(()=>window.hrhNative.mate.hideAvatar());
   }
  }
  fs.writeFileSync(path.join(shots,'avatar-speed.json'),JSON.stringify(results,null,2));
  console.log(process.env.AVATAR_EXPECT_BROKEN==='1'?'REPRODUCED AVATAR SPEEDUP':'AVATAR SPEED E2E OK');
 }finally{await app.stop();if(browser)await browser.close().catch(()=>{});}
})().catch(e=>{console.error(e);process.exit(1)});
