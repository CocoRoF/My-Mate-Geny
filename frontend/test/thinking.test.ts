import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatStore } from "../src/stores/chatStore.ts";
import type { ProviderEvent } from "../src/types/index.ts";

const BASE = 1800000000000;
const ev = (type: ProviderEvent["type"], ms: number, data: Record<string, unknown> = {}): ProviderEvent =>
  ({ type, seq: ms, timestamp: new Date(BASE + ms).toISOString(), data });
const send = (events: ProviderEvent[]) => {
  const store = createChatStore();
  for (const event of events) store.getState().applyEvent(event);
  return store;
};

test("Thinking is visible before any text and closes at engine time, not tool arrival", () => {
  const store = send([ev("session.start", 0), ev("thinking.start", 1000, {id: "r"})]);
  let flow = store.getState().turns.at(-1)!.flow;
  assert.deepEqual(flow, [{kind: "thinking", id: "r", text: "", startedAt: BASE + 1000, timingKnown: true}]);
  store.getState().applyEvent(ev("thinking.delta", 8000, {id: "r", text: "Reviewing"}));
  store.getState().applyEvent(ev("thinking.end", 9000, {id: "r"}));
  store.getState().applyEvent(ev("tool.use", 15000, {id: "cmd", name: "shell", input: {command: "pwd"}}));
  flow = store.getState().turns.at(-1)!.flow;
  const think = flow[0];
  assert.equal(think.kind, "thinking");
  if (think.kind === "thinking") {
    assert.equal(think.endedAt! - think.startedAt, 8000);
    assert.equal(think.text, "Reviewing");
  }
});

test("Old completed-only reasoning does not claim a measured millisecond duration", () => {
  const store = send([ev("session.start", 0), ev("thinking.delta", 1000, {text: "Finished"}), ev("text.delta", 1002, {text: "Answer"}), ev("turn.complete", 1003)]);
  const thinking = store.getState().turns.at(-1)!.flow[0];
  assert.equal(thinking.kind, "thinking");
  if (thinking.kind === "thinking") assert.equal(thinking.timingKnown, false);
});

test("Response wait has its own scope; hidden item timing cannot turn it into 0 ms reasoning", () => {
  const store = send([
    ev("session.start", 0), ev("thinking.start", 100, {id: "response", scope: "response"}),
    ev("thinking.end", 4100, {id: "response", scope: "response"}),
    ev("thinking.start", 4100, {id: "hidden"}), ev("thinking.end", 4100, {id: "hidden", timing_known: false}),
    ev("text.delta", 4110, {text: "Answer"}), ev("turn.complete", 4200),
  ]);
  const [response, hidden] = store.getState().turns.at(-1)!.flow;
  assert.equal(response.kind, "thinking");
  if (response.kind === "thinking") {
    assert.equal(response.scope, "response");
    assert.equal(response.endedAt! - response.startedAt, 4000);
  }
  if (hidden.kind === "thinking") assert.equal(hidden.timingKnown, false);
});

test("Interrupted and hidden reasoning close without opening another reply", () => {
  const store = send([ev("session.start", 0), ev("thinking.start", 1000, {id: "r"}), ev("error", 4000, {code: "turn.interrupted", message: "Stopped"})]);
  assert.equal(store.getState().turns.length, 1);
  const flow = store.getState().turns[0].flow[0];
  if (flow.kind === "thinking") assert.equal(flow.endedAt, BASE + 4000);
  store.getState().applyEvent(ev("thinking.end", 4001, {id: "r"}));
  assert.equal(store.getState().turns.length, 1);
});

test("Codex child thinking nests, live task status survives, and never becomes the main answer", () => {
  const store = send([
    ev("session.start", 0),
    ev("tool.use", 10, {id: "spawn", name: "Agent", input: {run_in_background: true, subagent_type: "Codex"}}),
    ev("task.update", 11, {task_id: "child", tool_use_id: "spawn", status: "running"}),
    ev("tool.result", 12, {id: "spawn", output: "launched", agent: {is_async: true}}),
    ev("thinking.start", 20, {id: "cr", parent: "spawn"}),
    ev("thinking.delta", 1000, {id: "cr", parent: "spawn", text: "Checking"}),
    ev("thinking.end", 2020, {id: "cr", parent: "spawn"}),
    ev("subagent.text", 2030, {parent: "spawn", text: "Child report"}),
    ev("task.update", 2031, {task_id: "child", tool_use_id: "spawn", status: "completed"}),
    ev("text.delta", 2100, {text: "Main answer"}), ev("turn.complete", 2200),
  ]);
  const turn = store.getState().turns.at(-1)!;
  assert.equal(turn.text, "Main answer");
  assert.equal(turn.flow.some(f => f.kind === "thinking"), false);
  const tool = turn.tools[0];
  assert.equal(tool.task!.status, "completed");
  assert.deepEqual(tool.sub?.[0], {kind: "thinking", text: "Checking", at: BASE + 20, id: "cr", timingKnown: true, endedAt: BASE + 2020});
});
