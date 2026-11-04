// Actual native toolbar + live settings + chat/quick windows; isolated real server, no paid TTS.
const {App,fill,until,sleep}=require('../../../desktop/test/e2e/screen-capture-e2e');
const {chromium}=require('playwright-core');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const [server,password]=process.argv.slice(2),shots=process.env.SCREEN_SHOTS,baseline=process.env.REPLY_SPEECH_BASELINE==='1';
const app=new App(fs.mkdtempSync(path.join(os.tmpdir(),'geny-reply-switch-')),9650,10150);
if(process.env.REPLY_SPEECH_DESKTOP){
 app.start=function(){
  const env={...process.env,HOME:this.home,XDG_CONFIG_HOME:path.join(this.home,'.config'),LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8'};delete env.XDG_SESSION_TYPE;delete env.WAYLAND_DISPLAY;
  this.proc=spawn('/home/hr-harnessor/desktop/node_modules/.bin/electron',[process.env.REPLY_SPEECH_DESKTOP,'--no-sandbox',`--remote-debugging-port=${this.port}`,`--inspect=${this.iport}`,'--disable-gpu'],{env,stdio:['ignore','pipe','pipe'],detached:true});this.out='';for(const s of [this.proc.stdout,this.proc.stderr])s.on('data',d=>this.out+=d);this.exited=new Promise(r=>this.proc.on('exit',r));
 };
}
function wav(seconds){const n=8000*seconds,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.sin(i/8000*440*Math.PI*2)*1500,44+i*2);return 'data:audio/wav;base64,'+b.toString('base64');}
(async()=>{let browser;
 try{
  app.start();const connect=await app.page(/connect\.html/);await until('connect',()=>connect.eval('!!window.hrhConnect'));await connect.eval(fill(server,'admin',password));
  await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)(?!\\?surface=)'));
  browser=await chromium.connectOverCDP('http://127.0.0.1:9650');const ctx=browser.contexts()[0];
  await ctx.addInitScript(()=>localStorage.setItem('hrh_lang','ko'));
  const api=async(url,method='GET',data)=>{const r=await ctx.request.fetch(server+url,{method,...(data?{data}:{})});assert(r.ok(),await r.text());return r.json();};
  const original=(await api('/api/mates')).find(m=>m.name==='한채린');
  const mate=await api('/api/mates','POST',{name:'한채린 음성 동기화 검증',persona:{greeting:''},avatar:original.avatar,voice:{auto_read:true,tts:{engine:'browser'},stt:{engine:'off'}}});
  const main=ctx.pages().find(p=>p.url().startsWith(server)&&!p.url().includes('surface='));
  await main.goto(server+'/?view=mate');await main.evaluate(id=>{localStorage.setItem('hrh_mate_active',id);localStorage.removeItem('hrh_mate_muted')},mate.id);await main.reload();
  await main.getByTestId('mate-settings-open').click();await main.getByTestId('mate-tab-voice').click();
  await main.evaluate(async id=>{window.hrhNative.setLanguage('ko');await window.hrhNative.mate.showAvatar(id);await window.hrhNative.mate.openChat();await window.hrhNative.mate.openQuick()},mate.id);
  const overlay=await until('overlay',()=>ctx.pages().find(p=>p.url().includes('surface=mate-overlay')));
  const chat=await until('chat',()=>ctx.pages().find(p=>p.url().includes('surface=mate-chat')));
  const quick=await until('quick',()=>ctx.pages().find(p=>p.url().includes('surface=mate-quick')));
  await chat.getByTestId('mate-read-toggle').waitFor();
  await app.main("cwin().setBounds({x:10,y:10,width:1120,height:960});win('surface=mate-overlay').setBounds({x:1460,y:560,width:150,height:180});return true");
  execFileSync('xdotool',['mousemove','1510','620']);
  const bar=await until('native bar',()=>ctx.pages().find(p=>p.url().includes('bar.html')));
  const setting=baseline?main.locator('label').filter({hasText:'답장 소리 내어 읽기'}).getByRole('switch'):main.getByTestId('mate-voice-read-aloud');
  await setting.scrollIntoViewIfNeeded();
  async function screenshot(name){await main.screenshot({path:path.join(shots,name+'-settings.png')});await bar.screenshot({path:path.join(shots,name+'-toolbar.png')});}
  if(baseline){
   assert.equal(await bar.locator('[data-act=voice]').count(),0);
   await chat.getByTestId('mate-read-toggle').click();await until('old composer muted',async()=>await chat.getByTestId('mate-read-toggle').getAttribute('aria-pressed')==='false');
   assert.equal(await setting.getAttribute('aria-checked'),'true');
   await screenshot('before');console.log('REPRODUCED: no mini-avatar voice button; chat OFF while settings ON');return;
  }
  const voice=bar.locator('[data-act=voice]');
  const results=[];
  async function all(on,name){
   const at=Date.now();
   await until(name,async()=>await voice.getAttribute('aria-pressed')===String(on)&&await setting.getAttribute('aria-checked')===String(on)&&await chat.getByTestId('mate-read-toggle').getAttribute('aria-pressed')===String(on)&&!(await voice.isDisabled()));
   assert.equal((await api('/api/mates/'+mate.id)).voice.auto_read,on);
   results.push({name,on,syncMs:Date.now()-at});console.log('PASS',name,results.at(-1).syncMs,'ms');
  }
  await all(true,'initial ON in every window');await screenshot('after-on');
  // Existing device mute is represented consistently, then cleared by the same ON action.
  await main.evaluate(()=>localStorage.setItem('hrh_mate_muted','1'));await main.reload();
  await main.getByTestId('mate-settings-open').click();await main.getByTestId('mate-tab-voice').click();
  await until('legacy mute is OFF everywhere',async()=>await voice.getAttribute('aria-pressed')==='false'&&await setting.getAttribute('aria-checked')==='false'&&await chat.getByTestId('mate-read-toggle').getAttribute('aria-pressed')==='false');
  assert.equal((await api('/api/mates/'+mate.id)).voice.auto_read,true);
  await voice.evaluate(b=>b.click());await all(true,'native ON clears legacy device mute');
  assert.equal(await main.evaluate(()=>localStorage.getItem('hrh_mate_muted')),null);

  // Native senders other than the overlay cannot forge a toolbar state.
  await main.evaluate(id=>window.hrhNative.mate.voiceState({mateId:id,enabled:false,available:true,busy:false}),mate.id);
  await sleep(250);assert.equal(await voice.getAttribute('aria-pressed'),'true');
  // Real AUDIO playback through the actual Mate queue, then stop it from the native bar.
  await until('voice queue',()=>overlay.evaluate(()=>!!window.__hrhMateAudio));
  await overlay.evaluate(src=>window.__hrhMateAudio.enqueue({source:src}),wav(15));
  await until('real WAV playing',()=>overlay.evaluate(()=>!!window.__hrhMateAudio.getState().current));
  const stopAt=Date.now();await voice.evaluate(b=>b.click());
  await until('actual audio stopped',()=>overlay.evaluate(()=>!window.__hrhMateAudio.getState().current));
  results.push({name:'native OFF stops real local WAV',stopMs:Date.now()-stopAt});await all(false,'native OFF -> settings/chat');await screenshot('after-off');
  await setting.click();await all(true,'settings ON -> native/chat');
  await sleep(350);assert.equal(await overlay.evaluate(()=>!!window.__hrhMateAudio.getState().current),false,'enabling does not replay stopped reply');
  await chat.getByTestId('mate-read-toggle').click();await all(false,'chat OFF -> native/settings');
  await setting.click();await all(true,'settings ON again');
  await chat.getByTestId('mate-read-toggle').click();await all(false,'chat OFF again');
  // Dirty voice settings must not lock the reading switch to an outdated draft or save it back.
  await main.getByTestId('mate-tts-speed').focus();await main.getByTestId('mate-tts-speed').press('ArrowRight');
  await voice.evaluate(b=>b.click());await all(true,'native ON while voice form dirty');
  await main.getByTestId('mate-settings-save').click();await sleep(500);
  assert.equal((await api('/api/mates/'+mate.id)).voice.auto_read,true);
  // A failed update rolls back visually, reports an error and unlocks the button for retry.
  await overlay.route('**/api/mates/'+mate.id,route=>route.request().method()==='PATCH'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'verification offline'})}):route.continue());
  await voice.evaluate(b=>b.click());await until('failure unlocks native control',async()=>!(await voice.isDisabled()));
  assert.equal(await voice.getAttribute('aria-pressed'),'true');await overlay.getByTestId('app-toast').waitFor();
  await overlay.unroute('**/api/mates/'+mate.id);
  await voice.evaluate(b=>b.click());await all(false,'retry OFF succeeds');
  await main.reload();await main.getByTestId('mate-settings-open').click();await main.getByTestId('mate-tab-voice').click();await all(false,'reload keeps OFF');
  // Small avatar's independent toolbar stays inside its native window, even at 150px avatar width.
  const bounds=await voice.evaluate(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right,window:innerWidth,height:r.height}});
  assert(bounds.left>=0&&bounds.right<=bounds.window&&bounds.height>0);results.push({name:'small avatar voice button fully visible',...bounds});
  // Full process stop/start retains the server-backed switch and restores the selected avatar.
  await browser.close();browser=null;await app.stop();app.pages.clear();app.mainCdp=null;app.start();
  await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/'));
  browser=await chromium.connectOverCDP('http://127.0.0.1:9650');const ctx2=browser.contexts()[0];
  const overlay2=await until('restored avatar',()=>ctx2.pages().find(p=>p.url().includes('surface=mate-overlay')));
  execFileSync('xdotool',['mousemove','1510','620']);const bar2=await until('restored toolbar',()=>ctx2.pages().find(p=>p.url().includes('bar.html')));
  await until('restart keeps OFF',async()=>await bar2.locator('[data-act=voice]').getAttribute('aria-pressed')==='false'&&!(await bar2.locator('[data-act=voice]').isDisabled()));
  results.push({name:'full application restart retains OFF',passed:true});
  const other=await ctx2.request.post(server+'/api/mates',{data:{name:'No voice configured',voice:{auto_read:false,tts:{engine:'off'}}}}).then(r=>r.json());
  await overlay2.evaluate(id=>window.hrhNative.mate.showAvatar(id),other.id);
  await until('unconfigured voice cannot falsely show ON',async()=>await bar2.locator('[data-act=voice]').isDisabled()&&/음성을 선택|Configure a voice/.test(await bar2.locator('[data-act=voice]').getAttribute('aria-label')));
  await overlay2.evaluate(id=>window.hrhNative.mate.showAvatar(id),mate.id);
  await until("switching back restores this mate's OFF",async()=>await bar2.locator('[data-act=voice]').getAttribute('aria-pressed')==='false'&&!(await bar2.locator('[data-act=voice]').isDisabled()));
  results.push({name:'mate switch restores selected mate and handles no TTS engine',passed:true});
  await overlay2.screenshot({path:path.join(shots,'after-restart-overlay.png')});
  fs.writeFileSync(path.join(shots,'reply-speech-results.json'),JSON.stringify(results,null,2));console.log('REPLY SPEECH TOGGLE E2E OK');
 }finally{await app.stop();if(browser)await browser.close().catch(()=>{});}
})().catch(e=>{console.error(e);process.exitCode=1});
