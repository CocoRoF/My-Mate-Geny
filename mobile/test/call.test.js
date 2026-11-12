// node --test test/*.test.js   (from mobile/)
// The phone-call piece of the app (GenyCallPlugin.java, docs/mate-calls.md): registered, the permissions it needs, and
// the same method and event names the console calls (frontend/src/mate/call/native.ts) — the APK itself is built by CI.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const JAVA = path.join(ROOT, "android/app/src/main/java/me/hrletsgo/harnessor");
const read = (p) => fs.readFileSync(p, "utf8");
const plugin = read(path.join(JAVA, "GenyCallPlugin.java"));
const activity = read(path.join(JAVA, "MainActivity.java"));
const manifest = read(path.join(ROOT, "android/app/src/main/AndroidManifest.xml"));
const page = read(path.join(ROOT, "../frontend/src/mate/call/native.ts"));

test("the call plugin is the app's and the activity hands it her notification's taps", () => {
  assert.match(plugin, /@CapacitorPlugin\(name = "GenyCall"\)/);
  assert.match(activity, /registerPlugin\(GenyCallPlugin\.class\)/);
  assert.match(activity, /GenyCallPlugin\.isCallIntent\(intent\)/);
  assert.match(activity, /getPlugin\("GenyCall"\)/);
  // (a tap before the plugin is up — the activity was recreated — is kept until it loads)
  assert.match(plugin, /public void load\(\)[\s\S]*?pendingAction/);
});

test("every method the console calls exists, under the same names", () => {
  const called = [...page.matchAll(/call\("(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(called)].sort(), ["begin", "cancelRing", "end", "ring", "setSpeaker"]);
  for (const m of called) assert.match(plugin, new RegExp(`@PluginMethod\\s+public void ${m}\\(PluginCall call\\)`), m);
  assert.match(page, /eventName: "callAction"/);
  assert.match(plugin, /notifyListeners\("callAction", \w+, true\)/);
  assert.match(page, /isPluginAvailable\?\.\("GenyCall"\)/);
});

test("her ringing is a call: a high-importance channel, category CALL, a full-screen intent, accept / decline", () => {
  assert.match(plugin, /NotificationManager\.IMPORTANCE_HIGH/);
  assert.match(plugin, /CATEGORY_CALL/);
  assert.match(plugin, /setFullScreenIntent\(/);
  assert.match(plugin, /ACTION_ACCEPT/);
  assert.match(plugin, /ACTION_DECLINE/);
  assert.match(plugin, /FLAG_IMMUTABLE/);
  assert.match(plugin, /FLAG_KEEP_SCREEN_ON/);
  assert.match(plugin, /MODE_IN_COMMUNICATION/);
});

test("the manifest has what a call needs", () => {
  for (const p of ["RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS", "POST_NOTIFICATIONS", "USE_FULL_SCREEN_INTENT", "VIBRATE"]) {
    assert.match(manifest, new RegExp(`android\\.permission\\.${p}"`), p);
  }
  // (taps come back to the one activity: onNewIntent)
  assert.match(manifest, /android:launchMode="singleTask"/);
});
