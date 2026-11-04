const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(){
 const attributes=()=>({attrs:{},classes:new Set(),setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k]},replaceChildren(){},appendChild(){},classList:{}});
 const names=['chat','quick','voice','screen','through','move','hide','console'],buttons={};
 for(const name of names){const b=attributes();b.dataset={act:name};b.classList.toggle=(k,v)=>v?b.classes.add(k):b.classes.delete(k);buttons[name]=b;}
 let render,click;const acts=[];
 const document={documentElement:{lang:'en'},getElementById:id=>id==='bar'?{querySelectorAll:()=>Object.values(buttons),addEventListener:(_,fn)=>{click=fn}}:{},createElementNS:()=>attributes(),addEventListener(){}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/bar.js'),'utf8'),{document,window:{hrhBar:{onState:fn=>{render=fn},act:name=>acts.push(name)}}});
 return {buttons,render,acts,click:name=>click({target:{closest:()=>buttons[name]}})};
}
test('voice toolbar shows the confirmed ON/OFF state and disables loading/unavailable/pending actions',()=>{
 const f=fixture(),b=f.buttons.voice;
 assert.equal(b.disabled,true);f.click('voice');assert.deepEqual(f.acts,[]);
 f.render({voiceReady:true,voiceAvailable:true,voiceEnabled:true});
 assert.equal(b.attrs['aria-pressed'],'true');assert(b.classes.has('on'));assert.match(b.attrs['aria-label'],/on · Turn off/);
 f.click('voice');assert.deepEqual(f.acts,['voice']);
 f.render({voiceReady:true,voiceAvailable:true,voiceEnabled:false});assert.equal(b.attrs['aria-pressed'],'false');assert(!b.classes.has('on'));
 f.render({voiceReady:true,voiceAvailable:true,voiceBusy:true});assert.equal(b.disabled,true);assert.equal(b.attrs['aria-busy'],'true');
 f.render({voiceReady:true,voiceAvailable:false});assert.equal(b.disabled,true);assert.match(b.attrs['aria-label'],/Configure a voice/);
 f.render({voiceReady:true,voiceAvailable:true,voiceEnabled:true,lang:'ko',labels:{voiceOn:'음성으로 말하기 켜짐 · 끄기'}});assert.equal(b.attrs['aria-label'],'음성으로 말하기 켜짐 · 끄기');
});
