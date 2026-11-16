// A phone call's microphone opens on the call's route (src/mate/stt/capture.ts): the Android WebView picks the phone's
// audio route by the microphone input — "Speakerphone", "Headset earpiece", a headset — and takes the loudspeaker when
// none is asked for, as for a video call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callRouteInput, routeInput, setCallRoute } from "../src/mate/stt/capture.ts";

const WEBVIEW = [
  { deviceId: "default", label: "" },
  { deviceId: "sp", label: "Speakerphone" },
  { deviceId: "ear", label: "Headset earpiece" },
];

test("the earpiece unless they pressed the loudspeaker; a connected headset first", () => {
  assert.equal(routeInput(WEBVIEW, "ear"), "ear");
  assert.equal(routeInput(WEBVIEW, "speaker"), "sp");
  const headset = [...WEBVIEW, { deviceId: "wired", label: "Wired headset" }];
  assert.equal(routeInput(headset, "ear"), "wired"); // ("Headset earpiece" is not a wired headset)
  assert.equal(routeInput([...headset, { deviceId: "bt", label: "Bluetooth headset" }], "ear"), "bt");
  // a browser that names its microphones its own way: no route, its own choice
  assert.equal(routeInput([{ deviceId: "m1", label: "MacBook Pro Microphone" }], "ear"), null);
});

function fakeDevices(labelsAfterOpen: boolean) {
  let opened = 0;
  const md = {
    async enumerateDevices() {
      const named = labelsAfterOpen ? opened > 0 : true;
      return WEBVIEW.map((d) => ({ ...d, kind: "audioinput", label: named ? d.label : "", deviceId: named ? d.deviceId : "" }));
    },
    async getUserMedia() {
      opened++;
      return { getTracks: () => [{ stop() {} }] };
    },
  };
  Object.defineProperty(globalThis, "navigator", { value: { mediaDevices: md }, configurable: true });
  return () => opened;
}

test("in a call the input for its route; labels unknown → one short open first; no call → the browser's own", async () => {
  let opens = fakeDevices(false);
  setCallRoute(null);
  assert.equal(await callRouteInput(), null);
  setCallRoute("ear");
  assert.equal(await callRouteInput(), "ear");
  assert.equal(opens(), 0);
  opens = fakeDevices(true);
  assert.equal(await callRouteInput(), "ear");
  assert.equal(opens(), 1);
  setCallRoute("speaker");
  assert.equal(await callRouteInput(), "sp");
  setCallRoute(null);
});
