import { test } from "node:test";
import assert from "node:assert/strict";
import { changesOf, latestChangeTurn, CHANGE_PREVIEW_LIMIT } from "../src/lib/turnChanges.ts";
import type { Turn } from "../src/stores/chatStore.ts";
const turn = (key: string, extra = {}): Turn => ({ key, role: "assistant", text: "", tools: [], flow: [], complete: true, ...extra });
const edit = (path: string, extra = {}) => ({ id: path, name: "Edit", input: { file_path: path }, startedAt: 0, ...extra });
test("only the latest turn; older history cannot contribute", () => {
  const turns = [turn("old", { tools: [edit("old.py")] }), turn("new", { tools: [edit("new.py")] })];
  assert.deepEqual(changesOf(latestChangeTurn(turns)).map(c => c.path), ["new.py"]);
  turns.unshift(turn("older", { tools: [edit("older.py")] }));
  assert.deepEqual(changesOf(latestChangeTurn(turns)).map(c => c.path), ["new.py"]);
});
test("a new turn with no changes never shows an earlier result; notices do not reset it", () => {
  const old = turn("old", { tools: [edit("old.py")] });
  assert.deepEqual(changesOf(latestChangeTurn([old, turn("user", { role: "user" })])), []);
  assert.deepEqual(changesOf(latestChangeTurn([old, turn("running", { complete: false })])), []);
  assert.deepEqual(changesOf(latestChangeTurn([old, turn("notice", { role: "system" })])).map(c => c.path), ["old.py"]);
  assert.deepEqual(changesOf(latestChangeTurn([])), []);
});
test("git snapshots are authoritative, including an empty snapshot", () => {
  assert.deepEqual(changesOf(turn("a", { tools: [edit("stale")], changes: { repos: [] } })), []);
  assert.deepEqual(changesOf(turn("a", { changes: { repos: [{ root: "/repo", files: [{ path: "new.py", status: "A" }] }] } })),
    [{ path: "/repo/new.py", ops: 1, created: true, failed: false }]);
});
test("nested subagent tools are included only in their owning turn and paths deduplicate", () => {
  const result = changesOf(turn("a", { tools: [edit("a"), edit("b", { parent: "agent" }), edit("a")] }));
  assert.deepEqual(result.map(c => [c.path, c.ops]), [["a", 2], ["b", 1]]);
});
test("ten-file preview leaves all files available to expand", () => {
  const result = changesOf(turn("a", { tools: Array.from({ length: 25 }, (_, i) => edit(`file${i}`)) }));
  assert.equal(result.slice(0, CHANGE_PREVIEW_LIMIT).length, 10);
  assert.equal(result.length, 25);
});
