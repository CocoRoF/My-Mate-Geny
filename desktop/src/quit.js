// A user Quit is terminal for this process, even if a renderer vetoes unload or stops responding.
"use strict";
const QUIT_DEADLINE_MS = 5000;
function createQuitController({app,windows,prepare,log=()=>{},setTimeout:st=setTimeout,clearTimeout:ct=clearTimeout,deadline=QUIT_DEADLINE_MS}){
  let stopping=false,explicit=false,timer=null;
  const safe=(name,fn)=>{try{fn();}catch(e){log(`quit cleanup failed (${name}): ${e?.message||e}`);}};
  function force(){
    if(!stopping)return;
    log(`quit deadline: destroying ${windows().length} remaining window(s)`);
    for(const win of windows())safe('window',()=>{if(!win.isDestroyed())win.destroy();});
    safe('exit',()=>app.exit(0));
  }
  function begin(update=false){
    if(stopping)return false;
    stopping=true;explicit=!update;
    // Arm before cleanup: a failed cleanup must never leave an uncancellable Quit.
    timer=st(force,deadline);timer.unref?.();
    safe('prepare',()=>prepare({update}));
    return true;
  }
  function request(source='user'){
    if(stopping)return false;
    log(`quit requested: ${typeof source==='string'?source:'menu'}`);
    begin(false);safe('app.quit',()=>app.quit());return true;
  }
  function bindWindow(win){
    win.webContents.on('will-prevent-unload',event=>{
      if(!stopping)return;
      // Electron: cancelling will-prevent-unload allows the window to close.
      event.preventDefault();log('quit: ignored renderer unload veto');
    });
  }
  app.on('quit',()=>{ct(timer);timer=null;log('quit completed');});
  return {request,beforeQuit:(update=false)=>begin(update),bindWindow,force,isQuitting:()=>stopping,isExplicit:()=>explicit};
}
module.exports={createQuitController,QUIT_DEADLINE_MS};
