/**
 * One call's line, voice and ears in the page (docs/mate-calls.md):
 *
 *   mic → listen.ts (realtime / VAD + recording / Web Speech) → "say" ─┐
 *                                                                      ├ /ws/mate-calls/{id} (calls.CallService)
 *   her voice ← TTS sentence by sentence (her engine, /speech) ← "delta" ┘
 *
 * - Her reply streams in as text; every finished sentence goes to her voice at once (one ahead is synthesized while one
 *   plays: mate/audioQueue.ts, a queue of the call's own) and is her caption.
 * - They talk over her: with their own words heard (realtime / Web Speech) she stops at once; a VAD start may be her
 *   echo, so she is only turned down until the transcript says (then she stops, or goes on). The server is told what of
 *   the reply was actually said ("barge"), so she knows what they heard.
 * - Calling her: the ring-back plays (at least one ring) until her first sound, then a click, then her voice — the clock
 *   starts there. Her calling: her hello was made while it rang, so it comes the moment they pick up.
 * - The line dropping reconnects (the server waits calls.RESUME_S); failing that, "the connection was lost" and the
 *   call ends (what was said is kept: the server's side).
 * - Latency: from the end of their speech to her first sound, sent with each reply ("metric"), kept with the call.
 */
import { speech as synthesizeSpeech, SpeechFallbackError, type Mate } from "../../api/mates";
import { hangupCall, type CallInfo, type CallPlan } from "../../api/calls";
import { wsUrl } from "../../api/client";
import { tr } from "../../i18n";
import { devicePreferences, devicePreferencesLoaded } from "../../stores/devicePreferences";
import { MateAudioQueue, type AudioQueueItem } from "../audioQueue";
import { voiceEmotionAt } from "../emotion";
import { SentenceStream, type Sentence } from "../sentences";
import { bcp47 } from "../useMateConversation";
import { listen, type Listener } from "./listen";
import type { EndReason } from "./machine";
import { callNative, keepScreenOn, nativeCalls } from "./native";
import { Tones } from "./tones";

export interface SessionEvents {
  /** her first sound: the call is through (the clock starts) */
  connected: (at: number) => void;
  speaking: (on: boolean) => void;
  caption: (text: string) => void;
  partial: (text: string) => void;
  userTalking: (on: boolean) => void;
  level: (v: number) => void;
  notice: (text: string | null) => void;
  /** listening can't work here (said plainly; the call goes on) */
  deaf: (text: string) => void;
  reconnecting: (on: boolean) => void;
  ended: (reason: EndReason) => void;
  server: (call: CallInfo) => void;
}

interface Reply {
  rid: string;
  text: string;
  stream: SentenceStream;
  /** what of it was said (started playing), in order */
  started: string[];
  hushed: boolean;
  done: boolean;
  greeting: boolean;
  metric: { endAt: number; stt: string } | null;
  measured: boolean;
}

/** (dialing) her voice waits for at least this much ring-back */
const RING_AT_LEAST_MS = 1700;
/** the click of picking up, before her first words */
const CLICK_MS = 140;
const RETRY_MS = [500, 1500, 3000];
/** speaker off where the page can't route to the earpiece: she is only turned down */
const EARPIECE = 0.4;
const DUCK = 0.3;
const ECHO_MS = 20_000;

export class CallSession {
  readonly call: CallInfo;
  private mate: Mate;
  private plan: CallPlan;
  private ev: SessionEvents;
  private ws: WebSocket | null = null;
  private queue = new MateAudioQueue();
  private replies = new Map<string, Reply>();
  private current: Reply | null = null;
  private listener: Listener | null = null;
  private tones = new Tones();
  private stopRing: (() => void) | null = null;
  private over = false;
  private muted: boolean;
  private speaker: boolean;
  private said: { text: string; at: number }[] = [];
  private pending: { endAt: number; stt: string } | null = null;
  private holdUntil = 0;
  private held: AudioQueueItem[] = [];
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private duckTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private retries = 0;
  private through = false;
  private clicked = false;
  /** her voice can't play on this device (no server voice, no speechSynthesis): her words are shown */
  private voiceless = false;
  private ducked = false;
  private volume = 1;
  private listening = false;

  constructor(call: CallInfo, mate: Mate, plan: CallPlan, ev: SessionEvents, opts: { muted: boolean; speaker: boolean }) {
    this.call = call;
    this.mate = mate;
    this.plan = plan;
    this.ev = ev;
    this.muted = opts.muted;
    this.speaker = opts.speaker;
  }

  start(): void {
    const mate = this.mate;
    const tts = mate.voice.tts;
    const engine = this.plan.tts.engine || tts.engine;
    const server = engine !== "browser" && engine !== "off";
    const q = this.queue;
    q.fallbackToBrowser = true; // (a call needs a voice: "off" speaks with the browser's)
    q.setBrowserVoice({ lang: bcp47(tts.language || mate.persona.language) || undefined, voice: engine === "browser" ? tts.voice || undefined : undefined, rate: tts.speed || 1 });
    q.setResolver(
      server
        ? async (item, signal) => {
            try {
              return await synthesizeSpeech(mate.id, item.text || "", item.emotion ?? null, signal);
            } catch (e) {
              if (e instanceof SpeechFallbackError) return null;
              throw e;
            }
          }
        : null,
    );
    this.voiceless = !server && typeof speechSynthesis === "undefined";
    if (this.voiceless) this.ev.notice(tr("mate.callNoVoice"));
    this.volume = devicePreferencesLoaded() ? devicePreferences().volume : 1;
    this.applyVolume();
    q.onItemStart = (item) => this.onSound(item);
    q.onIdle = () => {
      this.ev.speaking(false);
      this.unduck();
    };
    q.onError = () => {};
    void callNative.begin(this.speaker, { id: this.call.id, mate: this.mate.id, name: this.mate.name });
    void keepScreenOn(true);
    if (this.call.direction === "outgoing" && this.call.status === "dialing") {
      this.stopRing = this.tones.play("ringback", Math.min(1, this.volume));
      this.holdUntil = Date.now() + RING_AT_LEAST_MS;
    } else this.startListening(); // (they picked up her call: they may talk at once)
    this.connect();
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), 15_000);
  }

  // ── the line ──

  private connect(): void {
    if (this.over) return;
    const ws = new WebSocket(wsUrl(`/ws/mate-calls/${encodeURIComponent(this.call.id)}`));
    this.ws = ws;
    ws.onopen = () => {
      if (this.retries) this.ev.reconnecting(false);
      this.retries = 0;
    };
    ws.onmessage = (e) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws || this.over) return;
      this.ws = null;
      if (e.code === 4404) return this.finish("gone");
      if (this.retries >= RETRY_MS.length) return this.finish("network");
      this.ev.reconnecting(true);
      setTimeout(() => this.connect(), RETRY_MS[this.retries++]);
    };
  }

  private send(msg: Record<string, unknown>): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private onMessage(msg: Record<string, any>): void {
    switch (msg.type) {
      case "state":
        if (msg.call) this.ev.server(msg.call as CallInfo);
        return;
      case "reply": {
        const rid = String(msg.rid || "");
        const r = this.replies.get(rid);
        if (r) r.text = ""; // (sent again after a reconnect: the whole text comes once more)
        else this.reply(rid, !!msg.greeting);
        return;
      }
      case "delta": {
        // (a reply whose start this socket didn't see: it is one all the same)
        const r = this.replies.get(String(msg.rid || "")) ?? (msg.rid ? this.reply(String(msg.rid), false) : null);
        if (!r) return;
        r.text += String(msg.text || "");
        for (const s of r.stream.push(r.text)) this.say(r, s);
        return;
      }
      case "done": {
        const r = this.replies.get(String(msg.rid || ""));
        if (!r) return;
        if (typeof msg.text === "string" && msg.text.startsWith(r.text)) r.text = msg.text;
        for (const s of r.stream.flush(r.text)) this.say(r, s);
        r.done = true;
        // (a hello with nothing to say aloud: through all the same)
        if (r.greeting && !r.started.length && !this.held.length && !this.queue.getState().current && !this.queue.getState().pending) this.connectNow(Date.now());
        return;
      }
      case "ended":
        this.finish(((msg.reason as EndReason) || "gone"));
        return;
    }
  }

  private reply(rid: string, greeting: boolean): Reply {
    const r: Reply = { rid, text: "", stream: new SentenceStream({ maxChars: 90 }), started: [], hushed: false, done: false, greeting, metric: this.pending, measured: false };
    this.pending = null;
    this.replies.set(rid, r);
    if (this.replies.size > 30) this.replies.delete(this.replies.keys().next().value!);
    this.current = r;
    return r;
  }

  // ── her voice ──

  private say(r: Reply, s: Sentence): void {
    if (r.hushed || this.over) return;
    // (the caption is what she says now — when her voice can't play here, what she says at all)
    if (s.text && (this.voiceless || !s.speech)) this.ev.caption(s.text);
    if (!s.speech || this.voiceless) {
      if (this.voiceless && s.text) this.connectNow(Date.now());
      return;
    }
    const level = this.mate.prefs?.emotion ?? 2;
    const item: AudioQueueItem = { text: s.speech, emotion: voiceEmotionAt(level, s.emotion), meta: { rid: r.rid, display: s.text } };
    // (her first words wait for the click of picking up — and, when they called her, for one ring at least)
    if (!this.clicked && this.holdUntil <= Date.now()) this.holdUntil = Date.now() + CLICK_MS;
    const wait = this.holdUntil - Date.now();
    if (wait > 0 || this.held.length) {
      this.held.push(item);
      if (!this.holdTimer) this.holdTimer = setTimeout(() => this.release(), Math.max(0, wait));
      if (!this.clicked && wait <= CLICK_MS) this.pickUp();
      return;
    }
    this.queue.enqueue(item);
  }

  /** she picks up: the ring-back stops, a click (once) */
  private pickUp(): void {
    this.stopRing?.();
    this.stopRing = null;
    if (this.clicked || this.over) return;
    this.clicked = true;
    this.tones.play("connect", Math.min(1, this.volume));
  }

  private release(): void {
    this.holdTimer = undefined;
    const items = this.held;
    this.held = [];
    if (this.over) return;
    if (!this.clicked) {
      // (the ring is over: the click, then her voice)
      this.pickUp();
      this.holdUntil = Date.now() + CLICK_MS;
      this.held = items;
      this.holdTimer = setTimeout(() => this.release(), CLICK_MS);
      return;
    }
    this.holdUntil = 0;
    for (const it of items) this.queue.enqueue(it);
  }

  private onSound(item: AudioQueueItem): void {
    const now = Date.now();
    const meta = item.meta as { rid?: string; display?: string } | undefined;
    const r = meta?.rid ? this.replies.get(meta.rid) : undefined;
    if (r && r.hushed) return;
    if (r) r.started.push(meta?.display || item.text || "");
    this.said = [...this.said.filter((x) => now - x.at < ECHO_MS), { text: item.text || "", at: now }];
    this.ev.speaking(true);
    if (meta?.display) this.ev.caption(meta.display);
    this.connectNow(now);
    if (r && r.metric && !r.measured) {
      r.measured = true;
      this.send({ type: "metric", rid: r.rid, first_audio_ms: Math.max(0, now - r.metric.endAt), stt: r.metric.stt });
    }
  }

  private connectNow(at: number): void {
    if (this.through) return;
    this.through = true;
    this.stopRing?.();
    this.stopRing = null;
    this.ev.connected(at);
    this.startListening();
  }

  /** she is speaking (her voice playing now) */
  private speakingNow = () => !!this.queue.getState().current;

  private spokenLately = () => {
    const now = Date.now();
    return this.said.filter((x) => now - x.at < ECHO_MS).map((x) => x.text);
  };

  /** they talk over her: she stops; the server hears what of her reply was said */
  private interrupt(): void {
    const r = this.current;
    const q = this.queue.getState();
    if (!r || r.hushed) return;
    if (!q.current && !q.pending && !this.held.length && r.done) return; // (she was done)
    r.hushed = true;
    this.held = [];
    this.queue.stop();
    this.unduck();
    this.ev.speaking(false);
    this.send({ type: "barge", rid: r.rid, heard: r.started.join(" ") });
  }

  private duck(): void {
    if (!this.speakingNow() || this.ducked) return;
    this.ducked = true;
    this.applyVolume();
    clearTimeout(this.duckTimer);
    // (no transcript came: it was nothing)
    this.duckTimer = setTimeout(() => this.unduck(), 3000);
  }

  private unduck(): void {
    clearTimeout(this.duckTimer);
    if (!this.ducked) return;
    this.ducked = false;
    this.applyVolume();
  }

  private applyVolume(): void {
    const routed = nativeCalls();
    const v = this.volume * (this.speaker || routed ? 1 : EARPIECE) * (this.ducked ? DUCK : 1);
    this.queue.setVolume(v);
  }

  // ── their voice ──

  private startListening(): void {
    if (this.listening || this.over) return;
    this.listening = true;
    const mate = this.mate;
    this.listener = listen(
      {
        mateId: mate.id,
        lang: bcp47(mate.voice.stt.language || mate.persona.language) || undefined,
        plan: this.plan.stt,
        speaking: this.speakingNow,
        spoken: this.spokenLately,
        muted: () => this.muted,
      },
      {
        onUtterance: (text, endAt, how) => {
          if (!this.muted) this.utter(text, endAt, how);
        },
        onSpeech: (sure) => {
          this.ev.userTalking(true);
          if (sure) this.interrupt();
          else this.duck();
        },
        onSilence: () => {
          this.ev.userTalking(false);
          this.unduck();
        },
        onPartial: (text) => this.ev.partial(text),
        onLevel: (v) => this.ev.level(v),
        onNotice: (text) => this.ev.notice(text),
        onFail: (text) => this.ev.deaf(text),
      },
    );
    void this.listener.start();
  }

  /** one finished utterance of theirs goes to her */
  private utter(text: string, endAt: number, how: string): void {
    if (this.over || !text.trim()) return;
    this.ev.partial("");
    this.ev.userTalking(false);
    this.interrupt(); // (a whole sentence of theirs while she spoke: theirs wins)
    this.pending = { endAt, stt: how };
    if (!this.send({ type: "say", text })) this.pending = null;
  }

  /** words for her without the mic (checks from the console, browser tests: window.__hrhCall) */
  typed(text: string): void {
    this.utter(text, Date.now(), "typed");
  }

  // ── the buttons ──

  setMuted(on: boolean): void {
    this.muted = on;
    this.listener?.setMuted(on);
    if (on) this.ev.partial("");
  }

  setSpeaker(on: boolean): void {
    this.speaker = on;
    void callNative.setSpeaker(on);
    this.applyVolume();
  }

  hangup(): void {
    if (this.over) return;
    if (!this.send({ type: "hangup" })) void hangupCall(this.call.id).catch(() => {});
    this.finish("hangup");
  }

  /** the end, whoever ended it: everything let go */
  finish(reason: EndReason): void {
    if (this.over) return;
    this.over = true;
    clearTimeout(this.holdTimer);
    clearTimeout(this.duckTimer);
    clearInterval(this.pingTimer);
    this.listener?.stop();
    this.listener = null;
    this.stopRing?.();
    this.stopRing = null;
    this.queue.dispose();
    if (reason !== "elsewhere") this.tones.play("hangup", Math.min(1, this.volume));
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000);
    } catch {
      /* gone */
    }
    void callNative.end();
    void keepScreenOn(false);
    this.ev.speaking(false);
    this.ev.ended(reason);
  }
}

