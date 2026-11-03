import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatStore } from "../src/stores/chatStore.ts";
function fixture() {
  const store = createChatStore();
  let eid = 0;
  const event = (type: string, data: Record<string, unknown>) =>
    store
      .getState()
      .applyEvent({
        type,
        data,
        eid: ++eid,
        timestamp: new Date(1800000000000 + eid).toISOString(),
      } as any);
  event("session.start", {});
  return { store, event };
}
test("streaming steering creates an ordered user boundary and later prose starts a new block", () => {
  const { store, event } = fixture();
  event("text.delta", { text: "Before." });
  store.getState().pushSteer("User one", [], "u1");
  event("user.steer", { text: "User one", client_msg_id: "u1" });
  event("text.delta", { text: "After." });
  const turn = store.getState().turns.at(-1)!;
  assert.deepEqual(
    turn.flow.map((f) => [f.kind, "text" in f ? f.text : ""]),
    [
      ["text", "Before."],
      ["steer", "User one"],
      ["text", "After."],
    ],
  );
  assert.equal((turn.flow[1] as any).pending, false);
});
test("two rapid messages, tool cards and markdown blocks keep every boundary once", () => {
  const { store, event } = fixture();
  event("text.delta", { text: "```js\nconst a=1;" });
  event("tool.use", {
    id: "tool1",
    name: "mcp__mate__send_to_session",
    input: { message: "sent" },
  });
  event("tool.result", { id: "tool1", output: "Sent", is_error: false });
  store.getState().pushSteer("First", [], "u1");
  store.getState().pushSteer("Second", [], "u2");
  event("user.steer", { text: "First", client_msg_id: "u1" });
  event("user.steer", { text: "Second", client_msg_id: "u2" });
  event("text.delta", { text: "New **reply**." });
  const flow = store.getState().turns.at(-1)!.flow;
  assert.deepEqual(
    flow.map((f) => f.kind),
    ["text", "tool", "steer", "steer", "text"],
  );
  assert.equal(flow.filter((f) => f.kind === "steer").length, 2);
  assert.equal((flow[2] as any).text, "First");
  assert.equal((flow[3] as any).text, "Second");
});

test('parallel speech updates one bubble inside a streaming answer and final delivery never duplicates it',()=>{
 const {store,event}=fixture();event('text.delta',{text:'Before.'});
 event('user.steer',{text:'First',client_msg_id:'v1',speech_group:'v1',speech_pending:true});
 event('text.delta',{text:'After.'});
 event('speech.pending',{text:'First second third',group_id:'v1',role:'steer',at:1800000000,revision:3});
 event('user.steer',{text:'First second third',client_msg_id:'v1',speech_group:'v1',speech_pending:false});
 event('speech.closed',{group_id:'v1'});
 const flow=store.getState().turns.at(-1)!.flow;
 assert.deepEqual(flow.map(f=>[f.kind,'text'in f?f.text:'']),[['text','Before.'],['steer','First second third'],['text','After.']]);
 assert.equal((flow[1] as any).meta.speech_pending,false);
});
test('a received user bubble stays one bubble when a model starts at the merge deadline',()=>{
 const store=createChatStore();let id=0;const event=(type:string,data:any)=>store.getState().applyEvent({type,data,eid:++id,timestamp:new Date(1800000000000+id).toISOString()} as any);
 event('user.message',{text:'First',speech_group:'v1',speech_pending:true});
 event('speech.pending',{text:'First second',group_id:'v1',role:'user',at:1800000000});
 event('user.message',{text:'First second',speech_group:'v1',speech_pending:false});
 event('session.start',{});event('text.delta',{text:'Answer'});
 assert.equal(store.getState().turns.filter(t=>t.role==='user').length,1);
 assert.equal(store.getState().turns[0].text,'First second');
});
