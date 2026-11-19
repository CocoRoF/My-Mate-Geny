// A page's first words after it loads (src/mate/voiceBridge.ts prepareOutput, src/mate/audioQueue.ts): the voice's
// element is routed through Web Audio before a clip plays — never into a clip already playing (the context resumed as
// it began, the element rerouted mid-clip: that first clip came out garbled, every time).
import assert from "node:assert/strict";
import test from "node:test";

const routed: { src: string; paused: boolean; t: number }[] = [];
const param = () => ({ value: 0 });
const node = () => ({ connect() {}, disconnect() {} });
class FakeContext {
  state: "suspended" | "running" = "suspended";
  destination = {};
  resume() {
    // (a page the browser lets play: the context comes up a moment later)
    return new Promise<void>((done) =>
      setTimeout(() => {
        this.state = "running";
        done();
      }, 30),
    );
  }
  createMediaElementSource(el: AudioElement) {
    routed.push({ src: el.src, paused: el.paused, t: el.currentTime });
    return node();
  }
  createAnalyser() {
    return { ...node(), fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 128, getByteTimeDomainData() {} };
  }
  createGain() {
    return { ...node(), gain: param() };
  }
  createDynamicsCompressor() {
    return { ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() };
  }
}
let plays = 0;
class AudioElement extends EventTarget {
  dataset: Record<string, string> = {};
  src = "";
  paused = true;
  ended = false;
  volume = 1;
  preload = "";
  error = null;
  currentTime = 0;
  setAttribute() {}
  removeAttribute() {
    this.src = "";
  }
  load() {}
  pause() {
    this.paused = true;
  }
  play() {
    plays++;
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    // (the audio starts a moment later: "playing", then some of it out)
    setTimeout(() => {
      this.currentTime = 0.2;
      this.dispatchEvent(new Event("playing"));
    }, 5);
    setTimeout(() => {
      this.paused = true;
      this.ended = true;
      this.dispatchEvent(new Event("ended"));
    }, 60);
    return Promise.resolve();
  }
}
const win = Object.assign(new EventTarget(), { AudioContext: FakeContext });
Object.assign(globalThis, {
  document: new EventTarget(),
  window: win,
  Audio: AudioElement,
  HTMLMediaElement: AudioElement,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  localStorage: { getItem: () => null },
});
const { MateAudioQueue } = await import("../src/mate/audioQueue.ts");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the first clip after a page loads: routed before it plays, never as it plays", async () => {
  const q = new MateAudioQueue();
  try {
    q.enqueue({ source: "first.wav", text: "안녕, 나 왔어." });
    await wait(400);
    assert.equal(plays, 1);
    assert.equal(routed.length, 1, "routed once");
    assert.ok(routed[0].paused && routed[0].t === 0, "before any of it played");
    assert.notEqual(routed[0].src, "first.wav", "before the clip was even set");
    q.enqueue({ source: "second.wav", text: "두 번째." });
    await wait(200);
    assert.equal(plays, 2);
    assert.equal(routed.length, 1, "the same route for every clip after");
  } finally {
    q.dispose();
  }
});
