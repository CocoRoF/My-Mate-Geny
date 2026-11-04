import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createChatStore} from '../src/stores/chatStore.ts';

test('legacy buffered autonomous events reconstruct one reply even if completion timestamp precedes its delta',()=>{
 const store=createChatStore();
 const text='한 번만 말해야 해요. 화면에 새 창이 열렸네요.';
 const events=[
  {type:'session.start',eid:1,timestamp:'2026-11-04T05:00:00.000+00:00',data:{}},
  {type:'text.delta',eid:2,timestamp:'2026-11-04T05:00:03.002+00:00',data:{text}},
  {type:'turn.complete',eid:3,timestamp:'2026-11-04T05:00:03.001+00:00',data:{text}},
 ];
 store.getState().loadHistory({messages:[],events,running:false} as any);
 const replies=store.getState().turns.filter(t=>t.role==='assistant');
 assert.equal(replies.length,1);
 assert.equal(replies[0].text,text);
 assert.equal(replies[0].status,'done');
 assert.equal(replies[0].complete,true);
});

test('causal event order retains a later user boundary and independent identical replies',()=>{
 const store=createChatStore();const stamp=(ms:number)=>new Date(1800000000000+ms).toISOString();
 store.getState().loadHistory({running:false,messages:[{role:'user',content:'다음 질문',created_at:stamp(10)}],events:[
  {type:'session.start',eid:1,timestamp:stamp(1),data:{}},
  {type:'text.delta',eid:2,timestamp:stamp(4),data:{text:'안녕하세요.'}},
  {type:'turn.complete',eid:3,timestamp:stamp(3),data:{text:'안녕하세요.'}},
  {type:'session.start',eid:4,timestamp:stamp(11),data:{}},
  {type:'text.delta',eid:5,timestamp:stamp(12),data:{text:'안녕하세요.'}},
  {type:'turn.complete',eid:6,timestamp:stamp(13),data:{text:'안녕하세요.'}},
 ]} as any);
 assert.deepEqual(store.getState().turns.map(t=>[t.role,t.text]),[['assistant','안녕하세요.'],['user','다음 질문'],['assistant','안녕하세요.']]);
});
