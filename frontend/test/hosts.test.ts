// Folders on any host (src/lib/hosts.ts): workbench keys for paths on other hosts, the folder list of old servers.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { folderFor, isQualified, qualify, sessionFolders, thisHostIds, unqualify } from "../src/lib/hosts.ts";

const remote = { id: "s", connection_id: "c1", workspace_path: "/srv/app", extra_dirs: [] } as any;
const local = { id: "s", connection_id: null, workspace_path: "/home/u/app", extra_dirs: [] } as any;

test("paths on the workspace's host stay plain; others are qualified and come back", () => {
  assert.equal(qualify(remote, "c1", "/srv/app/a.ts"), "/srv/app/a.ts");
  assert.equal(qualify(remote, null, "/home/u/x"), "@local:/home/u/x");
  assert.equal(qualify(local, "c2", "/data"), "@c2:/data");
  assert.equal(qualify(local, null, "/home/u/x"), "/home/u/x");
  for (const [s, conn, p] of [[remote, null, "/home/u/x"], [local, "c2", "/data/y z.md"], [remote, "c3", "~/repos/r"]] as const) {
    const q = qualify(s, conn, p);
    assert.deepEqual(unqualify(s, q), { conn, path: p });
  }
  assert.deepEqual(unqualify(remote, "/srv/app/x"), { conn: "c1", path: "/srv/app/x" });
  assert.equal(isQualified("@c2:/data"), true);
  assert.equal(isQualified("@decorator"), false); // not a path
  assert.equal(isQualified("/@c2:/x"), false);
});

test("an older server's extra_dirs are the workspace's host", () => {
  assert.deepEqual(sessionFolders({ ...remote, extra_dirs: ["/srv/lib"] }), [{ path: "/srv/lib", connection_id: "c1" }]);
  const s = { ...local, folders: [{ path: "/data", connection_id: "c2" }], extra_dirs: [] };
  assert.deepEqual(sessionFolders(s), [{ path: "/data", connection_id: "c2" }]);
  assert.deepEqual(folderFor(s, "/data/x/y.md"), { path: "/data", connection_id: "c2" });
  assert.equal(folderFor(s, "/datax/y.md"), undefined);
});

test("connections that are this machine", () => {
  const ids = thisHostIds([
    { id: null, name: null, local: true, this_host: true },
    { id: "c1", name: "a", local: false, this_host: false },
    { id: "c9", name: "me", local: false, this_host: true },
  ]);
  assert.deepEqual([...ids], ["c9"]);
});
