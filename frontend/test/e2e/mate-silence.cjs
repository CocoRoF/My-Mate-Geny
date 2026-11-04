// Real Electron transcript layout with normalized autonomous silence events. No model, TTS or capture calls.
const {App,fill,until,sleep}=require('../../../desktop/test/e2e/screen-capture-e2e');
const {chromium}=require('playwright-core'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const [server,password]=process.argv.slice(2),shots=process.env.SCREEN_SHOTS;
function inject(){
 const ws=window.__chat;let tick=Date.now();
 const event=(type,data)=>ws.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type,data,timestamp:new Date(tick++).toISOString()})}));
 const start=()=>{event('user.message',{internal:true,text:'internal trigger'});event('session.start',{});};
 const end=text=>event('turn.complete',{text,silent:!text});
 start();event('text.delta',{text:'침묵 전 답변'});end('침묵 전 답변');
 for(let i=0;i<20;i++){start();event('thinking.delta',{text:'private reasoning'});end('');}
 for(const text of ['[neutral]','(잠시 생각함)']){start();event('text.delta',{text});end(text);}
 start();event('text.delta',{text:'침묵 뒤 답변'});end('침묵 뒤 답변');
 window.__emitMateEvent=event;
}
(async()=>{
 const app=new App(fs.mkdtempSync(path.join(os.tmpdir(),'geny-mate-silence-')),9640,10140);let browser;
 try{
  app.start();const connect=await app.page(/connect\.html/);await until('connect',()=>connect.eval('!!window.hrhConnect'));await connect.eval(fill(server,'admin',password));
  await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)(?!\\?surface=)'));
  browser=await chromium.connectOverCDP('http://127.0.0.1:9640');const ctx=browser.contexts()[0];
  await ctx.addInitScript(()=>{
   localStorage.setItem('hrh_lang','ko');const Native=window.WebSocket;
   window.WebSocket=class extends Native{constructor(...args){super(...args);if(String(args[0]).includes('/ws/chat/'))window.__chat=this;}};
  });
  const api=async(url,method='GET',data)=>{const r=await ctx.request.fetch(server+url,{method,...(data?{data}:{})});assert(r.ok(),await r.text());return r.json();};
  const mate=await api('/api/mates','POST',{name:'침묵 간격 확인',persona:{greeting:''},voice:{auto_read:false}}),results=[];
  const page=ctx.pages().find(p=>p.url().startsWith(server)&&!p.url().includes('surface='));
  const check=async(p,name)=>{
   await p.waitForFunction(()=>window.__chat?.readyState===1);await sleep(400);await p.evaluate(inject);await sleep(400);
   const rows=await p.getByTestId('mate-turn').count(),first=await p.getByTestId('mate-turn').filter({hasText:'침묵 전 답변'}).boundingBox(),last=await p.getByTestId('mate-turn').filter({hasText:'침묵 뒤 답변'}).boundingBox();
   const gap=last.y-first.y-first.height;results.push({surface:name,rows,gap});
   assert.equal(rows,process.env.SILENCE_EXPECT_BROKEN==='1'?24:2);assert(process.env.SILENCE_EXPECT_BROKEN==='1'?gap>200:gap<30);
   await p.screenshot({path:path.join(shots,(process.env.SILENCE_EXPECT_BROKEN==='1'?'before':'after')+'-'+name+'.png')});
   if(process.env.SILENCE_EXPECT_BROKEN!=='1'){
    await p.evaluate(()=>{
     const e=window.__emitMateEvent;e('session.start',{});e('tool.use',{id:'tool-visible',name:'mcp__mate__remember',input:{text:'visible tool'}});e('tool.result',{id:'tool-visible',output:'Remembered',is_error:false});e('turn.complete',{text:''});
     e('session.start',{});e('error',{code:'turn.interrupted',message:'Stopped'});
     e('session.start',{});e('error',{code:'provider.test',message:'실패 상태 유지'});
     e('session.start',{});
    });await sleep(200);
    assert.equal(await p.getByTestId('mate-turn').count(),6);assert.equal(await p.getByTestId('mate-activity').count(),1);
    assert((await p.textContent('body')).includes('실패 상태 유지'));assert((await p.textContent('body')).includes('중지됨'));
   }
  };
  await page.goto(server+'/?view=mate');await page.evaluate(id=>localStorage.setItem('hrh_mate_active',id),mate.id);await page.reload();await page.getByTestId('mate-settings-open').waitFor();await check(page,'console');
  await page.evaluate(id=>window.hrhNative.mate.setMate(id).then(()=>window.hrhNative.mate.openChat()),mate.id);
  const chat=await until('chat window',()=>ctx.pages().find(p=>p.url().includes('surface=mate-chat')));await chat.reload();await chat.getByTestId('mate-chat-window').waitFor();await check(chat,'chat');
  await page.setViewportSize({width:390,height:844});await page.reload();await page.getByTestId('mate-settings-open').waitFor();await check(page,'phone-width');
  fs.writeFileSync(path.join(shots,'silence-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
  console.log(process.env.SILENCE_EXPECT_BROKEN==='1'?'REPRODUCED SILENT ROW GAPS':'MATE SILENCE E2E OK');
 }finally{await app.stop();if(browser)await browser.close().catch(()=>{});}
})().catch(e=>{console.error(e);process.exit(1)});
