import assert from "node:assert/strict";
import test from "node:test";

test("a new folder's name is checked before it is sent", async () => {
  const { folderNameProblem } = await import("../src/lib/folderName");
  assert.equal(folderNameProblem("my-project"), null);
  assert.equal(folderNameProblem("  새 프로젝트  "), null);
  assert.equal(folderNameProblem("   "), "workspace.nameEmpty");
  assert.equal(folderNameProblem(".."), "workspace.nameDots");
  assert.equal(folderNameProblem("a/b"), "workspace.nameSlash");
  assert.equal(folderNameProblem("a\\b"), "workspace.nameSlash");
  assert.equal(folderNameProblem("tab\there"), "workspace.nameSlash");
  assert.equal(folderNameProblem("가".repeat(86)), "workspace.nameLong"); // (258 bytes)
  assert.equal(folderNameProblem("가".repeat(85)), null);
});
