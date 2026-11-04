// Real Electron playback and lifecycle events; isolated API + fake model, local WAV instead of paid TTS.
const {App,fill,until,sleep}=require('./screen-capture-e2e');
const {chromium}=require('playwright-core');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const [server,password]=process.argv.slice(2),shots=process.env.SCREEN_SHOTS;
function wav(){
 const rate=16000,n=rate/4,b=Buffer.alloc(44+n*2);
 b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
 for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/rate)*500),44+i*2);
 return b;
}
(async()=>{
 const app=new App(fs.mkdtempSync(path.join(os.tmpdir(),'geny-proactive-voice-')),9660,10160);let browser;
 const requests=[],results={};
 try{
  app.start();const connect=await app.page(/connect\.html/);await until('connect',()=>connect.eval('!!window.hrhConnect'));await connect.eval(fill(server,'admin',password));
  await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)(?!\\?surface=)'));
  browser=await chromium.connectOverCDP('http://127.0.0.1:9660');const ctx=browser.contexts()[0];
  await ctx.route(/\/api\/mates\/[^/]+\/speech$/,async route=>{
   requests.push({page:route.request().frame().url(),text:route.request().postDataJSON().text});
   await route.fulfill({contentType:'audio/wav',body:wav()});
  });
  await ctx.addInitScript(()=>{
   localStorage.setItem('hrh_lang','ko');window.__audio=[];
   const play=HTMLMediaElement.prototype.play;
   HTMLMediaElement.prototype.play=function(){
    return play.call(this).then(v=>{if(!this.dataset.mateSilent)window.__audio.push('played');return v;},err=>{window.__audio.push(err.name);throw err;});
   };
   if(new URLSearchParams(location.search).has('fast-voice')){
    const Native=window.WebSocket;
    window.WebSocket=class extends Native{
     constructor(...args){super(...args);if(String(args[0]).includes('/ws/chat/'))this.addEventListener('open',()=>setTimeout(()=>{
      if(window.__fastDelivered)return;window.__fastDelivered=Date.now();
      const device=window.hrhNative?.deviceIdentity?.deviceId||localStorage.getItem('hrh_device_id'),stamp=new Date().toISOString();
      const events=[['user.message',{text:'internal',internal:true,client_msg_id:'thinking~'+device}],['session.start',{voice_device:device}],['text.delta',{text:'빠르게 끝난 말걸기도 한 번 읽어요.'}],['turn.complete',{text:'빠르게 끝난 말걸기도 한 번 읽어요.'}]];
      for(const [n,[type,data]] of events.entries())this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type,data,eid:9000000+n,timestamp:stamp})}));
      // Replay overlap must not flush and read the answer twice.
      setTimeout(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'turn.complete',data:events[3][1],eid:9000003,timestamp:stamp})})),1000);
     },10));}
    };
   }
  });
  const api=async(url,method='GET',data)=>{const r=await ctx.request.fetch(server+url,{method,...(data?{data}:{})});assert(r.ok(),await r.text());return r.json();};
  const mate=await api('/api/mates','POST',{name:'자동 말걸기 음성 확인',voice:{auto_read:true,tts:{engine:'openai'}}});
  await api(`/api/mates/${mate.id}/conversation`,'POST');
  const runtime=await until('hidden controller',()=>ctx.pages().find(p=>p.url().includes('surface=device-runtime')));
  await runtime.reload();await runtime.waitForFunction(()=>!!window.hrhNative?.device&&!!window.__audio);
  // Console stays on a coding screen. The hidden runtime is the only reader and receives no gesture.
  await runtime.evaluate(id=>window.hrhNative.device.patch({volume:1,screen:{proactive_enabled:true,proactive_mate:id}}),mate.id);
  await until('lifecycle TTS requested',()=>requests.length>0,20000);await sleep(2500);
  results.startup={tts:requests.length,audio:await runtime.evaluate(()=>window.__audio),blocked:await runtime.evaluate(()=>window.__hrhMateAudio?.getState().blocked)};
  console.log('STARTUP',JSON.stringify(results.startup));
  {
   await until('all greeting sentences play',async()=> (await runtime.evaluate(()=>window.__audio.filter(x=>x==='played').length))>=5,15000);
   assert(!results.startup.audio.includes('NotAllowedError'));
   results.startup.audio=await runtime.evaluate(()=>window.__audio);
   console.log('PASS app lifecycle greeting actually plays without a gesture in the hidden controller');
   // A prior question from another device must not route this device's autonomous greeting there.
   await until('idle',async()=>!(await api(`/api/sessions/${mate.session_id|| (await api(`/api/mates/${mate.id}/conversation`,'POST')).session_id}`)).running);
   const conv=await api(`/api/mates/${mate.id}/conversation`,'POST');
   await runtime.evaluate(async sid=>{
    const ws=new WebSocket(location.origin.replace('http','ws')+'/ws/chat/'+sid);
    await new Promise(r=>ws.onopen=r);ws.send(JSON.stringify({type:'chat',input:'question from another device',client_msg_id:'m-test~otherdevice'}));
    await new Promise(r=>setTimeout(r,100));ws.close();
   },conv.session_id);
   await until('foreign reply complete',async()=>!(await api(`/api/sessions/${conv.session_id}`)).running,20000);
   const before=requests.length;
   await runtime.evaluate(async id=>{
    const c=await window.hrhNative.device.context();
    const ws=new WebSocket(location.origin.replace('http','ws')+'/ws/sessions');
    await new Promise(r=>ws.onopen=r);
    ws.send(JSON.stringify({type:'client',device:c.deviceId,surface:'device-runtime',capture:1,
     screen_policy:{enabled:true,fixed:true,mate_id:id},device_runtime:true,device_boot:c.bootId,device_mate_id:id,
     device_events:[{id:crypto.randomUUID(),type:'enabled',mate_id:id}]}));
    await new Promise(r=>setTimeout(r,250));ws.close();
   },mate.id);
   if(process.env.VOICE_EXPECT_BROKEN==='1'){
    await sleep(6500);assert.equal(requests.length,before,'reproduces autonomous TTS incorrectly routed to the previous device');
   }else await until('own autonomous reply plays after foreign input',()=>requests.length>=before+5,20000);
   await sleep(1500);results.targeted={tts:requests.length-before,audio:await runtime.evaluate(()=>window.__audio)};
   console.log(process.env.VOICE_EXPECT_BROKEN==='1'?'REPRODUCED own autonomous greeting has no TTS after foreign-device input':'PASS autonomous greeting targets its initiating device even after a foreign-device question');
   // Three visible surfaces share a single reader. Reloaded history must not duplicate buffered replies.
  }
  const page=ctx.pages().find(p=>p.url().startsWith(server)&&!p.url().includes('surface='));
  const conv=await api(`/api/mates/${mate.id}/conversation`,'POST');
  // Read-only legacy fixture: older live data used to stamp the completion before its buffered delta.
  await ctx.route('**/api/history/'+conv.session_id+'?*',async route=>{
   const response=await route.fetch(),body=await response.json();let delta=null;
   for(const event of body.events){
    if(event.type==='text.delta')delta=event;
    if(event.type==='turn.complete'&&delta&&event.data.text===delta.data.text)
      event.timestamp=new Date(Date.parse(delta.timestamp)-1).toISOString();
   }
   await route.fulfill({response,json:body});
  });
  await page.goto(server+'/?view=mate&mate='+mate.id);await page.evaluate(id=>localStorage.setItem('hrh_mate_active',id),mate.id);await page.reload();
  await page.getByTestId('mate-settings-open').waitFor();await sleep(500);
  const history=await api('/api/history/'+conv.session_id),answer=history.messages.find(m=>m.role==='assistant'&&!m.meta?.kind)?.content;
  assert(answer);const shown=await page.getByTestId('mate-bubble').allTextContents();
  results.legacyCopies=shown.filter(s=>s.trim()===answer.trim()).length;
  assert.equal(results.legacyCopies,process.env.VOICE_EXPECT_BROKEN==='1'?2:1);
  await page.screenshot({path:path.join(shots,process.env.VOICE_EXPECT_BROKEN==='1'?'before-proactive-voice.png':'after-proactive-voice.png')});
  if(process.env.VOICE_EXPECT_BROKEN!=='1'){
   const fast=await api('/api/mates','POST',{name:'빠른 말걸기',voice:{auto_read:true,tts:{engine:'openai'}}});
   const before=requests.length;
   await page.evaluate(id=>window.hrhNative.mate.setMate(id).then(()=>window.hrhNative.mate.openChat()),fast.id);
   const fastPage=await until('new fast window',()=>ctx.pages().find(p=>p.url().includes('surface=mate-chat')));
   await fastPage.goto(server+'/?surface=mate-chat&mate='+fast.id+'&fast-voice=1');
   try{await until('fast reply plays after election',()=>requests.length===before+1);}catch(err){
    console.log('FAST DEBUG',await fastPage.evaluate(()=>({delivered:window.__fastDelivered,audio:window.__audio,text:document.body.innerText,identity:window.hrhNative?.deviceIdentity})));throw err;
   }
   await sleep(1400);assert.equal(requests.length,before+1,'replayed completion is not spoken twice');
   results.fast={tts:1,replayDuplicates:0};console.log('PASS reply completed before election is read once; replay overlap does not read it twice');
   await page.evaluate(id=>window.hrhNative.mate.showAvatar(id).then(()=>window.hrhNative.mate.openChat()),mate.id);
   const overlay=await until('visible overlay',()=>ctx.pages().find(p=>p.url().includes('surface=mate-overlay')));
   const chat=await until('visible chat',()=>ctx.pages().find(p=>p.url().includes('surface=mate-chat')&&!p.url().includes('fast-voice')));
   await overlay.reload();await chat.reload();
   await overlay.getByTestId('mate-overlay').waitFor();await chat.getByTestId('mate-chat-window').waitFor();await sleep(1000);
   await overlay.evaluate(()=>{
    const play=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(){if(this.dataset.mateSilent)return play.call(this);window.__audio.push('forced-block');return Promise.reject(new DOMException('Forced autoplay failure','NotAllowedError'));};
   });
   const at=requests.length;
   await runtime.evaluate(async id=>{
    const c=await window.hrhNative.device.context(),ws=new WebSocket(location.origin.replace('http','ws')+'/ws/sessions');await new Promise(r=>ws.onopen=r);
    ws.send(JSON.stringify({type:'client',device:c.deviceId,surface:'device-runtime',capture:1,screen_policy:{enabled:true,fixed:true,mate_id:id},device_runtime:true,device_boot:c.bootId,device_mate_id:id,device_events:[{id:crypto.randomUUID(),type:'enabled',mate_id:id}]}));
    await new Promise(r=>setTimeout(r,250));ws.close();
   },mate.id);
   await until('blocked overlay hands voice to chat',async()=>await chat.evaluate(()=>window.__audio.filter(x=>x==='played').length)>=5,20000);
   assert((await overlay.evaluate(()=>window.__audio)).includes('forced-block'));
   assert.equal((await overlay.evaluate(()=>window.__audio)).filter(x=>x==='played').length,0);
   const spoken=requests.slice(at).filter(r=>r.page.includes('surface=mate-chat')).map(r=>r.text);
   assert.equal(spoken.length,5);assert(spoken[0].includes('sentence number 1'));
   results.handoff={chatPlayed:5,overlayPlayed:0,firstSentencePreserved:true};
   await chat.screenshot({path:path.join(shots,'after-voice-handoff.png')});
   console.log('PASS blocked highest-rank overlay relinquishes voice; chat actually plays all five sentences once');
  }
  results.requests=requests;fs.writeFileSync(path.join(shots,'voice-results.json'),JSON.stringify(results,null,2));
  if(process.env.VOICE_EXPECT_BROKEN!=='1')console.log('PROACTIVE VOICE E2E OK');
 }finally{await app.stop();if(browser)await browser.close().catch(()=>{});}
})().catch(e=>{console.error(e);process.exit(1)});
