// Open real workspace files through Explorer -> file tab, then test the shared viewer on desktop and phone.
const {App,fill,until,sleep}=require('../../../desktop/test/e2e/screen-capture-e2e');
const {chromium}=require('playwright-core');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const [server,password,workspace]=process.argv.slice(2),shots=process.env.SCREEN_SHOTS,before=process.env.FILE_IMAGE_BEFORE==='1';
const app=new App(fs.mkdtempSync(path.join(os.tmpdir(),'geny-file-image-')),9627,10127);
(async()=>{let browser,stopped=false;try{
 fs.copyFileSync('/home/hr-harnessor/.claude/verification/reply-speech-toggle-20261104/after-on-toolbar.png',path.join(workspace,'toolbar.png'));
 fs.copyFileSync('/home/hrjang/.hr-harnessor/uploads/sess_0da61eb1771bec00/att_86127921525edadd/pasted-20261104-194606.png',path.join(workspace,'scene.png'));
 app.start();const connect=await app.page(/connect\.html/);await until('connect',()=>connect.eval('!!window.hrhConnect'));await connect.eval(fill(server,'admin',password));
 await app.page(new RegExp('^'+server.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?!login)(?!\\?surface=)'));
 browser=await chromium.connectOverCDP('http://127.0.0.1:9627');const ctx=browser.contexts()[0];await ctx.addInitScript(()=>localStorage.setItem('hrh_lang','ko'));
 let page=ctx.pages().find(p=>p.url().startsWith(server)&&!p.url().includes('surface='));
 const resp=await ctx.request.post(server+'/api/sessions',{data:{provider:'claude',model:'haiku',connection_id:null,workspace_path:workspace,title:'파일 탭 이미지 확대 검증'}});assert(resp.ok());const sid=(await resp.json()).id;
 await page.goto(server+'/?view=chat&session='+sid);await page.locator('[data-topbar-item=explorer]').click();
 const jump=page.getByPlaceholder(/경로로 이동/),results=[];
 async function open(name){
  await jump.fill(path.join(workspace,name));await jump.press('Enter');
  const image=page.locator('img[alt="'+name+'"]');await image.waitFor();await until('loaded '+name,()=>image.evaluate(e=>e.complete&&e.naturalWidth>0));
  assert.equal(await page.getByTestId('image-lightbox').count(),0);return image;
 }
 const tiny=await open('toolbar.png'),base=await tiny.boundingBox();await page.mouse.move(base.x+base.width/2,base.y+base.height/2);await page.mouse.wheel(0,-600);await sleep(180);
 if(before){assert(Math.abs((await tiny.boundingBox()).width-base.width)<1);await page.screenshot({path:path.join(shots,'before-file-tab-wheel.png')});console.log('REPRODUCED actual file tab ignores wheel zoom');return;}
 let viewer=page.locator('[data-testid=file-image-viewer]:visible'),area=viewer.getByTestId('image-zoom-area');const scale=()=>area.getAttribute('data-scale').then(Number);
 assert((await scale())>3);assert((await tiny.boundingBox()).width>base.width*3);results.push({case:'tiny real file wheel zoom',scale:await scale()});
 await page.screenshot({path:path.join(shots,'after-file-tab-toolbar-zoom.png')});
 await viewer.getByTestId('image-zoom-reset').click();assert.equal(await scale(),1);
 const large=await open('scene.png');await until('new file starts fitted',()=>scale().then(s=>s===1));
 const fit=await large.boundingBox(),r=await area.boundingBox(),x=r.x+r.width/2,y=r.y+r.height/2;
 await page.mouse.move(x+40,y);await page.mouse.wheel(0,-500);await sleep(150);assert((await scale())>2);
 const pre=await large.boundingBox();await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+70,y+20,{steps:7});await page.mouse.up();assert(Math.abs((await large.boundingBox()).x-pre.x)>20);
 await page.screenshot({path:path.join(shots,'after-file-tab-scene-zoom.png')});
 const framing=await large.evaluate(e=>e.style.transform);await open('toolbar.png');await sleep(150);await open('scene.png');assert.equal(await large.evaluate(e=>e.style.transform),framing,'switching tabs preserves zoom and pan');
 await viewer.getByTestId('image-actual-size').click();await until('original pixels',async()=>Math.abs((await large.boundingBox()).width-1954)<1);results.push({case:'actual 1:1',width:(await large.boundingBox()).width});
 await viewer.getByTestId('image-zoom-reset').click();
 await jump.fill('');await jump.press('+');assert.equal(await jump.inputValue(),'+');assert.equal(await scale(),1,'typing in Explorer must not zoom a background file tab');
 await large.click();await page.keyboard.press('+');assert((await scale())>1);await page.keyboard.press('0');assert.equal(await scale(),1);
 await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('+');assert.equal(await scale(),1,'unfocused tab must not own global shortcuts');
 await page.getByTitle('탐색기 닫기',{exact:true}).click();
 const prefs=await page.evaluate(()=>localStorage.getItem('hrh_workbench_v1')),cookies=await ctx.cookies();
 await app.stop();stopped=true;await browser.close();browser=null;
 browser=await chromium.launch({executablePath:process.env.CHROME,args:['--no-sandbox']});
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});await mobile.addCookies(cookies);
 await mobile.addInitScript(p=>{localStorage.setItem('hrh_lang','ko');localStorage.setItem('hrh_workbench_v1',p)},prefs);
 page=await mobile.newPage();await page.goto(server+'/?view=chat&session='+sid);viewer=page.locator('[data-testid=file-image-viewer]:visible');await viewer.waitFor();
 area=viewer.getByTestId('image-zoom-area');await until('mobile real tab image',()=>viewer.getByTestId('lightbox-image').evaluate(e=>e.complete&&e.naturalWidth>0));
 const cdp=await mobile.newCDPSession(page),box=await area.boundingBox(),cx=box.x+box.width/2,cy=box.y+box.height/2;
 const touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,x,y])=>({id,x,y,radiusX:4,radiusY:4,force:1}))});
 await touch('touchStart',[[1,cx-45,cy],[2,cx+45,cy]]);for(let k=1;k<=8;k++)await touch('touchMove',[[1,cx-45-k*7,cy],[2,cx+45+k*7,cy]]);await touch('touchEnd',[]);
 await until('mobile tab pinch',()=>scale().then(s=>s>2));const old=await viewer.getByTestId('lightbox-image').boundingBox();
 await touch('touchStart',[[3,cx,cy]]);await touch('touchMove',[[3,cx+40,cy]]);await touch('touchEnd',[]);await sleep(100);assert(Math.abs((await viewer.getByTestId('lightbox-image').boundingBox()).x-old.x)>20);
 assert.equal(await page.evaluate(()=>visualViewport.scale),1);results.push({case:'mobile real file tab pinch + pan',scale:await scale()});
 for(const b of await viewer.locator('button').all()){const r=await b.boundingBox();assert(r.x>=0&&r.x+r.width<=391,JSON.stringify(r));}
 await page.screenshot({path:path.join(shots,'after-file-tab-mobile-pinch.png')});await viewer.getByTestId('image-zoom-reset').tap();await until('mobile tab reset',()=>scale().then(s=>s===1));
 await page.setViewportSize({width:844,height:390});await sleep(200);assert.equal(await scale(),1);assert((await area.boundingBox()).height>0);results.push({case:'resize and focused-only shortcuts',passed:true});
 fs.writeFileSync(path.join(shots,'file-image-results.json'),JSON.stringify(results,null,2));console.log('FILE IMAGE ZOOM E2E OK');
}finally{if(!stopped)await app.stop();if(browser)await browser.close().catch(()=>{});}})().catch(e=>{console.error(e);process.exitCode=1});
