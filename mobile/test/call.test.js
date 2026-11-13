// node --test test/*.test.js   (from mobile/)
// The phone-call piece of the app (GenyCallPlugin.java, CallNotifier.java, GenyLinkService.java, docs/mate-calls.md):
// registered, the permissions it needs, the same method and event names the console calls (frontend/src/mate/call/
// native.ts), and the background link that rings with the app closed — the APK itself is built by CI.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const JAVA = path.join(ROOT, "android/app/src/main/java/me/hrletsgo/harnessor");
const read = (p) => fs.readFileSync(p, "utf8");
const plugin = read(path.join(JAVA, "GenyCallPlugin.java"));
const notifier = read(path.join(JAVA, "CallNotifier.java"));
const service = read(path.join(JAVA, "GenyLinkService.java"));
const link = read(path.join(JAVA, "GenyLink.java"));
const receiver = read(path.join(JAVA, "CallActionReceiver.java"));
const boot = read(path.join(JAVA, "BootReceiver.java"));
const server = read(path.join(JAVA, "GenyServerPlugin.java"));
const router = read(path.join(ROOT, "../backend/app/routers/mate_calls.py"));
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
  const called = [...page.matchAll(/(?:call|ask)(?:<[^(]*>)?\("(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(called)].sort(), ["begin", "cancelRing", "end", "link", "openSettings", "ring", "setBackground", "setSpeaker", "status"]);
  for (const m of called) assert.match(plugin, new RegExp(`@PluginMethod\\s+public void ${m}\\(PluginCall call\\)`), m);
  assert.match(page, /eventName: "callAction"/);
  assert.match(plugin, /notifyListeners\("callAction", \w+, true\)/);
  assert.match(page, /isPluginAvailable\?\.\("GenyCall"\)/);
});

test("her ringing is a call: a high-importance channel, category CALL, a full-screen intent, her face, accept / decline", () => {
  assert.match(notifier, /NotificationManager\.IMPORTANCE_HIGH/);
  assert.match(notifier, /CATEGORY_CALL/);
  assert.match(notifier, /setFullScreenIntent\(/);
  assert.match(notifier, /CallStyle\.forIncomingCall\(/);
  assert.match(notifier, /FLAG_INSISTENT/);
  assert.match(notifier, /ACTION_ACCEPT/);
  assert.match(notifier, /ACTION_DECLINE/);
  assert.match(notifier, /FLAG_IMMUTABLE/);
  // (the existing "Calls" channel keeps its id: a phone keeps the sound it was made with)
  assert.match(notifier, /CH_RING = "geny_calls"/);
  // (one ring per call, whoever asks first: the page or the background link)
  assert.match(notifier, /if \(id\.equals\(ringing\)\) return true;/);
  assert.match(plugin, /CallNotifier\.ring\(/);
  assert.match(plugin, /FLAG_KEEP_SCREEN_ON/);
  assert.match(plugin, /MODE_IN_COMMUNICATION/);
  // (거절 without opening the app; 받기 holds the call while the app comes up)
  assert.match(receiver, /\/api\/mate-calls\/" \+ id \+ "\/" \+ what/);
  assert.match(activity, /\/answering"/);
  for (const a of ["answering", "decline", "hangup"]) assert.match(router, new RegExp(`action == "${a}"`), a);
});

test("the background link: a foreground service on one line to the server, back after a reboot, gone on sign-out", () => {
  assert.match(manifest, /android:name="\.GenyLinkService"[\s\S]*?android:foregroundServiceType="specialUse\|microphone"/);
  assert.match(manifest, /PROPERTY_SPECIAL_USE_FGS_SUBTYPE/);
  assert.match(manifest, /android:name="\.CallActionReceiver" android:exported="false"/);
  assert.match(manifest, /android:name="\.BootReceiver"[\s\S]*?BOOT_COMPLETED[\s\S]*?MY_PACKAGE_REPLACED/);
  for (const p of ["FOREGROUND_SERVICE", "FOREGROUND_SERVICE_SPECIAL_USE", "FOREGROUND_SERVICE_MICROPHONE", "RECEIVE_BOOT_COMPLETED",
    "WAKE_LOCK", "ACCESS_NETWORK_STATE", "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"]) {
    assert.match(manifest, new RegExp(`android\\.permission\\.${p}"`), p);
  }
  // the server's end of it, and what it says
  assert.match(service, /"\/api\/mate-calls\/link\?device="/);
  assert.match(router, /@router\.get\("\/api\/mate-calls\/link"\)/);
  for (const t of ["hello", "policy", "call.ring", "call.update"]) assert.match(service, new RegExp(`case "${t.replace(".", "\\.")}"`), t);
  assert.match(service, /FOREGROUND_SERVICE_TYPE_SPECIAL_USE/);
  assert.match(service, /FOREGROUND_SERVICE_TYPE_MICROPHONE/);
  assert.match(service, /registerDefaultNetworkCallback/);
  // signed in as the page is (its login cookie), the token kept fresh; nothing of it kept on sign-out
  assert.match(link, /COOKIE = "hrh_session"/);
  assert.match(link, /"Authorization", "Bearer "/);
  assert.match(server, /GenyLink\.forget\(c\);\s+GenyLinkService\.stop\(\);/);
  assert.match(boot, /GenyLinkService\.sync\(context\)/);
});

test("the manifest has what a call needs", () => {
  for (const p of ["RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS", "POST_NOTIFICATIONS", "USE_FULL_SCREEN_INTENT", "VIBRATE", "INTERNET"]) {
    assert.match(manifest, new RegExp(`android\\.permission\\.${p}"`), p);
  }
  // (taps come back to the one activity: onNewIntent)
  assert.match(manifest, /android:launchMode="singleTask"/);
});
