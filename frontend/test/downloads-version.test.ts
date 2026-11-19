// Each platform's own version (src/api/downloads.ts versionFor): every platform is published the moment it is built, so
// an app compares itself with its own platform's newest build — never another's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { versionFor } from "../src/api/downloads.ts";
import type { AppRelease } from "../src/api/downloads.ts";

const asset = (platform: string, arch: string, version?: string) =>
  ({ id: 1, name: `x-${version}-${platform}`, size: 1, platform, arch, kind: "k", label: "l", url: "/", ...(version ? { version } : {}) }) as any;

test("an app's newest build is its own platform's, a Mac's its own architecture's", () => {
  const rel = {
    available: true,
    version: "1.1.9",
    assets: [asset("windows", "x64", "1.1.9"), asset("android", "universal", "1.1.3"), asset("macos", "arm64", "1.1.9"), asset("macos", "x64", "1.1.8")],
    ios: { version: "1.1.2", testflight: "https://testflight.apple.com/join/x" },
  } as AppRelease;
  // the Android app is not told about the desktop's 1.1.9
  assert.equal(versionFor(rel, "android"), "1.1.3");
  assert.equal(versionFor(rel, "windows"), "1.1.9");
  assert.equal(versionFor(rel, "macos", "x64"), "1.1.8");
  assert.equal(versionFor(rel, "macos", "arm64"), "1.1.9");
  // (a desktop from before it said its architecture: the newest Mac build)
  assert.equal(versionFor(rel, "macos"), "1.1.9");
  assert.equal(versionFor(rel, "ios"), "1.1.2");
  // no build of it: nothing to update to
  assert.equal(versionFor(rel, "linux"), undefined);
  assert.equal(versionFor({ ...rel, ios: null }, "ios"), undefined);
  // a browser: the release's
  assert.equal(versionFor(rel, null), "1.1.9");
});

test("a server from before per-platform versions: the release's version for any platform it has", () => {
  const rel = { available: true, version: "1.1.0", assets: [asset("android", "universal"), asset("windows", "x64")] } as AppRelease;
  assert.equal(versionFor(rel, "android"), "1.1.0");
  assert.equal(versionFor(rel, "linux"), undefined);
});
