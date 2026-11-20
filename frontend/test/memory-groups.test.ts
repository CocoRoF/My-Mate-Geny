// The 기억 tab's memories gathered by what they are about (src/mate/memoryGroups.ts): one card per thing, the user
// first, then the two of them, then her, then the rest by the latest change; the ones not put in order yet last.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByEntity } from "../src/mate/memoryGroups.ts";
import type { GraphKind, Memory } from "../src/api/mates.ts";

const mem = (id: string, at: string, entity?: [string, GraphKind]) =>
  ({ id, text: id, kind: "fact", updated_at: at, entity: entity && { id: entity[0], name: entity[0], kind: entity[1] } }) as unknown as Memory;

test("one group per thing, in the order of who they are about", () => {
  const groups = groupByEntity([
    mem("a", "2026-11-03", ["DJMAX", "game"]),
    mem("b", "2026-11-01", ["나", "user"]),
    mem("c", "2026-11-05"),
    mem("d", "2026-11-02", ["DJMAX", "game"]),
    mem("e", "2026-11-04", ["채린", "self"]),
    mem("f", "2026-11-06", ["민수", "person"]),
    mem("g", "2026-11-01", ["우리 사이", "us"]),
    mem("h", "2026-11-02", ["나", "user"]),
  ]);
  assert.deepEqual(groups.map((g) => g.key), ["나", "우리 사이", "채린", "민수", "DJMAX", ""]);
  assert.deepEqual(groups[0].items.map((m) => m.id), ["b", "h"]);
  assert.deepEqual(groups[4].items.map((m) => m.id), ["a", "d"]);
  assert.equal(groups[4].at, "2026-11-03");
  assert.equal(groups[5].entity, null);
});
