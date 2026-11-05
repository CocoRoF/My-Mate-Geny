import test from "node:test";
import assert from "node:assert/strict";
import { mcpArguments, mcpSecrets } from "../src/lib/mcpForm.ts";
import { fromSearch, settingsUrl } from "../src/lib/navUrl.ts";

test("MCP arguments preserve a folder containing spaces without shell parsing", () => {
  assert.deepEqual(mcpArguments("-y\npackage\n/home/me/My Project"), [
    "-y",
    "package",
    "/home/me/My Project",
  ]);
  assert.deepEqual(mcpArguments('["--name", " a b ", ""]'), [
    "--name",
    " a b ",
    "",
  ]);
  assert.throws(() => mcpArguments('["x", 3]'));
  assert.deepEqual(mcpArguments('["--token", null]'), ["--token", null]);
});

test("editing MCP settings preserves existing secrets and removes only deleted rows", () => {
  assert.deepEqual(
    mcpSecrets([
      { name: "KEY", value: "", keep: true },
      { name: "NEW", value: "new-value", keep: false },
    ]),
    { KEY: null, NEW: "new-value" },
  );
  assert.deepEqual(mcpSecrets([]), {});
  assert.deepEqual(
    mcpSecrets([{ name: "KEY", value: "replacement", keep: true }]),
    { KEY: "replacement" },
  );
  assert.throws(() =>
    mcpSecrets([
      { name: "KEY", value: "a", keep: false },
      { name: "KEY", value: "b", keep: false },
    ]),
  );
  assert.throws(() =>
    mcpSecrets(
      [
        { name: "Authorization", value: "a", keep: false },
        { name: "authorization", value: "b", keep: false },
      ],
      true,
    ),
  );
});

test("new provider categories have stable deep links and old provider links still resolve", () => {
  assert.equal(fromSearch("?view=settings&tab=media")?.tab, "media");
  assert.equal(fromSearch("?view=settings&tab=mcp")?.tab, "mcp");
  assert.equal(fromSearch("?view=providers")?.tab, "providers");
  assert.equal(settingsUrl("mcp"), "/?view=settings&tab=mcp");
});
