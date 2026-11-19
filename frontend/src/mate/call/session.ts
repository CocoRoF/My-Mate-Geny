/**
 * One call's line, voice and ears in the page (docs/mate-calls.md):
 *
 *   mic → listen.ts (realtime / VAD + recording / Web Speech) → "say" ─┐
 *                                                                      ├ /ws/mate-calls/{id} (calls.CallService)
 *   her voice ← TTS sentence by sentence (her engine, /speech) ← "delta" ┘
 *
 * - Her reply streams in as text; every finished sentence goes to her voice at once (one ahead is synthesized while one
 *   plays: mate/audioQueue.ts, a queue of the call's own) and is her caption.
 * - They talk over her: words meant to stop her ("잠깐만", her name — mate/call/turns.ts) stop her at once; other words
 *   of theirs only turn her down, and go to her as an aside: she judges whether they were for her — an answer with words
 *   stops what she was saying and is said; [SILENT] and she goes on where she was, at her volume again. A VAD start may
 *   be her echo, so she is only turned down until the transcript says. The server is told what of a reply was actually
 *   said ("barge"), so she knows what they heard.
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
import { claimVoice } from "../voiceBridge";
import { setCallRoute } from "../stt/capture";
import { voiceEmotionAt } from "../emotion";
import { SentenceStream, type Sentence } from "../sentences";
import { bcp47 } from "../useMateConversation";
import { listen, type Listener } from "./listen";
import type { EndReason } from "./machine";
import { callNative, keepScreenOn, nativeCalls } from "./native";
import { appActive, onAppActive } from "../../lib/appState";
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
  /** sentences of it said aloud */
  lines: number;
  hushed: boolean;
  done: boolean;
  greeting: boolean;
  metric: { endAt: number; stt: string } | null;
  measured: boolean;
  /** when its first words played (ms; 0: not yet) */
  heardFrom: number;
  /** her answer to an aside (words said over her voice, maybe not to her): words of it stop what she was saying */
  aside: boolean;
  /** sentences of it with words, so far (waiting or not) */
  words: number;
  /** its sentences gone to her voice, not all begun (a hold takes back the ones not begun) */
  queued: Sentence[];
}

/** a turn of theirs sent before its end was sure: her answer waits for it at most this long (mate/call/turns.ts
 *  confirms long before — this is only so a lost confirm never leaves her mute) */
const TURN_OPEN_MAX_MS = 4000;
/** an aside's answer comes within this long, or she goes on (her volume back) as if it were nothing */
const ASIDE_MAX_MS = 8000;

/** (dialing) her voice waits for at least this much ring-back */
const RING_AT_LEAST_MS = 1700;
/** the route they chose, set again after the microphone opens: at once, then as the phone settles (ms) */
const REROUTE_AT = [0, 500, 1500];
/** the click of picking up, before her first words */
const CLICK_MS = 140;
/** her first words wait for the line: the phone in call mode, the microphone open, her voice's output warmed — then
 *  this much more for the phone's audio to settle (a mode switch or a mic opening under her voice garbled it) */
const LINE_SETTLE_MS = 300;
/** …but never longer than this (a microphone prompt still open, a slow phone): she speaks anyway */
const LINE_READY_MAX_MS = 3000;
const RETRY_MS = [500, 1500, 3000];
/** speaker off where the page can't route to the earpiece: she is only turned down */
const EARPIECE = 0.4;
const DUCK = 0.3;
const ECHO_MS = 20_000;
/** her choice to say nothing (calls.py spoken(): no words) */
const SILENT = /^\s*\[SILENT\]\s*$/i;
/** the mic's loudness looked at in windows this long: a window with nothing at all in it (not muted) is said once */
const LEVEL_WINDOW_MS = 10_000;
const SILENT_LEVEL = 0.004;

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
  private rerouteTimers: ReturnType<typeof setTimeout>[] = [];
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
  /** the line is ready for her voice (prepareLine) */
  private lineReady = false;
  /** when her voice last stopped (ms) */
  private voiceEndedAt = 0;
  /** the mic's loudest in the window so far, the window's start, whether the last window heard nothing */
  private levelMax = 0;
  private levelFrom = 0;
  private micSilent = false;
  private offApp: (() => void) | null = null;
  private diagLater: Record<string, unknown>[] = [];
  /** their turn went to her before its end was sure (realtime): her answer is made, its voice waits (`confirmTurn`) */
  private turnOpen = false;
  /** the reply on before their last turn went (one after it answers that turn) */
  private answeredBefore = "";
  private waiting: { r: Reply; s: Sentence }[] = [];
  private turnTimer: ReturnType<typeof setTimeout> | undefined;
  /** her answer they spoke over (an aside): it goes on, turned down, until her answer to the aside says */
  private asideFor: Reply | null = null;
  private asideTimer: ReturnType<typeof setTimeout> | undefined;
  /** each "say" numbered (the server's reply to it says which): asides whose answer hasn't come, and those whose
   *  answer is to go unheard (she was stopped meanwhile) */
  private seq = 0;
  private asideSeqs: number[] = [];
  private orphans = new Set<number>();
  /** her voice on the call is hers in every window of this computer (the overlay's mouth moves with it) */
  private releaseVoice: (() => void) | null = null;

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
    this.releaseVoice = claimVoice(mate.id);
    q.onIdle = () => {
      this.voiceEndedAt = Date.now();
      this.ev.speaking(false);
      this.unduck();
    };
    q.onError = () => {};
    const callMode = callNative.begin(this.speaker, { id: this.call.id, mate: this.mate.id, name: this.mate.name });
    // (the microphone opens on the call's route — or the WebView would take the loudspeaker, as for a video call)
    if (nativeCalls()) setCallRoute(this.speaker ? "speaker" : "ear");
    void keepScreenOn(true);
    if (this.call.direction === "outgoing" && this.call.status === "dialing") {
      // (in the app the ring-back waits for the route — the microphone open on it: prepareLine)
      if (!nativeCalls()) this.stopRing = this.tones.play("ringback", Math.min(1, this.volume));
      this.holdUntil = Date.now() + RING_AT_LEAST_MS;
    }
    // the microphone opens now — while it rings when they call her (nothing heard counts before she picks up) — never
    // under her first words: a phone opening its mic switches its audio and garbles what plays at that moment
    const mic = this.startListening();
    void this.prepareLine(callMode, mic);
    this.connect();
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), 15_000);
    // (the screen off, the app away: the call goes on — said to the server, for when it didn't hear them)
    let wasActive = appActive();
    this.offApp = onAppActive(() => {
      const on = appActive();
      if (on === wasActive) return;
      wasActive = on;
      this.diag(on ? "app.front" : "app.away");
    });
  }

  /** what happened to the listening and the line, kept with the call on the server (calls.CallService "diag") */
  private diag(ev: string, data: Record<string, unknown> = {}): void {
    const msg = { type: "diag", ev, t: Date.now(), ...data };
    // (before the line is up, or while it is down: sent once it is)
    if (!this.send(msg)) this.diagLater = [...this.diagLater, msg].slice(-30);
  }

  /** the mic's loudness: a window of nothing at all (the phone gave the app silence) is said once, and its end */
  private noteLevel(v: number): void {
    const now = Date.now();
    if (!this.levelFrom) this.levelFrom = now;
    if (!this.muted) this.levelMax = Math.max(this.levelMax, v);
    if (now - this.levelFrom < LEVEL_WINDOW_MS) return;
    const silent = !this.muted && this.levelMax < SILENT_LEVEL;
    if (silent !== this.micSilent) this.diag(silent ? "mic.silent" : "mic.back", { max: Math.round(this.levelMax * 1000) / 1000 });
    this.micSilent = silent;
    this.levelMax = 0;
    this.levelFrom = now;
  }

  // ── the line ──

  private connect(): void {
    if (this.over) return;
    const ws = new WebSocket(wsUrl(`/ws/mate-calls/${encodeURIComponent(this.call.id)}`));
    this.ws = ws;
    ws.onopen = () => {
      if (this.retries) this.ev.reconnecting(false);
      this.retries = 0;
      const later = this.diagLater;
      this.diagLater = [];
      for (const m of later) this.send(m);
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
        else {
          const seq = typeof msg.seq === "number" ? msg.seq : -1;
          this.asideSeqs = this.asideSeqs.filter((x) => x !== seq);
          const mine = this.reply(rid, !!msg.greeting);
          // (her answer to an aside, and she was stopped since: it goes unheard)
          if (this.orphans.delete(seq)) {
            mine.hushed = true;
            this.send({ type: "barge", rid, heard: "" });
          }
        }
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
        // (an aside that wasn't for her: she goes on where she was)
        if (r.aside && !r.words && !r.hushed) {
          this.endAside(false);
          return;
        }
        // (she says nothing — silence is hers to keep: the screen shows it, so it isn't taken for a line gone dead)
        if (!r.lines && !r.hushed && !r.greeting && !r.aside && !this.turnOpen && r === this.current) this.ev.caption("…");
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
    const r: Reply = { rid, text: "", stream: new SentenceStream({ maxChars: 90 }), started: [], lines: 0, hushed: false, done: false, greeting, metric: this.pending, measured: false, heardFrom: 0, aside: !greeting && !!this.asideFor, words: 0, queued: [] };
    this.pending = null;
    this.replies.set(rid, r);
    if (this.replies.size > 30) this.replies.delete(this.replies.keys().next().value!);
    this.current = r;
    return r;
  }

  // ── her voice ──

  /**
   * The line made ready for her voice before her first words play: the phone in call mode (its route set), the
   * microphone open, her voice's output path running and warmed with a moment of silence — then a short settle. Each of
   * these, done while her first sentence played, garbled it. At most LINE_READY_MAX_MS: she speaks anyway after that.
   */
  private async prepareLine(callMode: Promise<unknown>, mic: Promise<void>): Promise<void> {
    const deadline = Date.now() + LINE_READY_MAX_MS;
    const capped = (p: Promise<unknown>) =>
      Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
    await capped(Promise.all([callMode, mic]));
    // (the route asked for once more: the WebView sets one whenever it opens a microphone)
    this.reroute();
    if (nativeCalls() && this.call.direction === "outgoing" && !this.through && !this.clicked && !this.stopRing && !this.over)
      this.stopRing = this.tones.play("ringback", Math.min(1, this.volume));
    await capped(this.queue.warm());
    await new Promise((r) => setTimeout(r, LINE_SETTLE_MS));
    this.lineReady = true;
    if (!this.over && this.held.length && !this.holdTimer) this.release();
  }

  /** the route they chose, set again — at once and as the phone settles (the WebView sets its own when it opens a mic) */
  private reroute(): void {
    if (!nativeCalls()) return;
    for (const t of this.rerouteTimers) clearTimeout(t);
    this.rerouteTimers = REROUTE_AT.map((ms) => setTimeout(() => {
      if (!this.over) void callNative.setSpeaker(this.speaker);
    }, ms));
  }

  private say(r: Reply, s: Sentence, again = false): void {
    if (r.hushed || this.over) return;
    if (!again && s.speech && !SILENT.test(s.text)) r.words++;
    // (their turn's end isn't sure yet: her answer is ready, but waits — they may go on, and then it is never heard)
    if (this.turnOpen && !r.greeting) {
      this.waiting.push({ r, s });
      return;
    }
    // (her answer to what they said over her has words: what she was saying stops here)
    if (r.aside && this.asideFor && s.speech && !SILENT.test(s.text)) this.endAside(true);
    if (s.speech) r.lines++;
    // (the caption is what she says now — when her voice can't play here, what she says at all; never [SILENT] itself)
    const shown = SILENT.test(s.text) ? "" : s.text;
    if (shown && (this.voiceless || !s.speech)) this.ev.caption(shown);
    if (!s.speech || this.voiceless) {
      if (this.voiceless && s.text) this.connectNow(Date.now());
      return;
    }
    const level = this.mate.prefs?.emotion ?? 2;
    const item: AudioQueueItem = { text: s.speech, emotion: voiceEmotionAt(level, s.emotion), meta: { rid: r.rid, display: s.text } };
    r.queued.push(s);
    // (the line isn't ready for her voice yet: her words wait — prepareLine lets them go)
    if (!this.lineReady) {
      this.held.push(item);
      return;
    }
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
    if (!this.lineReady) return; // (prepareLine releases them once it is)
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
    if (r && !r.heardFrom) r.heardFrom = now;
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
    void this.startListening();
  }

  /** she is speaking (her voice playing now) */
  private speakingNow = () => !!this.queue.getState().current;

  /** her voice coming out now, or between two of its sentences — not a reply's first words still being made */
  private audibleNow = (): boolean => {
    const it = this.queue.getState().current;
    if (!it) return false;
    const rid = (it.meta as { rid?: string } | undefined)?.rid;
    const r = rid ? this.replies.get(rid) : undefined;
    return !r || r.started.length > 0;
  };

  private spokenLately = () => {
    const now = Date.now();
    return this.said.filter((x) => now - x.at < ECHO_MS).map((x) => x.text);
  };

  /** they talk over her: she stops; the server hears what of her reply was said (and of the one an aside was said
   *  over, still going on) */
  private interrupt(): void {
    const a = this.asideFor;
    this.asideFor = null;
    clearTimeout(this.asideTimer);
    // (her answers to asides not come yet: unheard when they come)
    for (const x of this.asideSeqs) this.orphans.add(x);
    this.asideSeqs = [];
    const r = this.current;
    const q = this.queue.getState();
    const voice = !!(q.current || q.pending || this.held.length);
    const stop = [r, a].filter((x, i, all): x is Reply => !!x && !x.hushed && all.indexOf(x) === i);
    if (!stop.length || (!voice && stop.every((x) => x.done))) return; // (she was done)
    for (const x of stop) {
      x.hushed = true;
      this.send({ type: "barge", rid: x.rid, heard: x.started.join(" ") });
    }
    this.held = [];
    this.voiceEndedAt = Date.now();
    this.queue.stop();
    this.unduck();
    this.ev.speaking(false);
  }

  /** her answer to an aside came: with words (`stop`) what she was saying stops there — the server keeps what was
   *  heard of it; none ([SILENT]: it wasn't for her) and she goes on, at her volume again */
  private endAside(stop: boolean): void {
    const a = this.asideFor;
    this.asideFor = null;
    clearTimeout(this.asideTimer);
    if (!a) return;
    if (!stop) {
      if (this.current?.aside) this.current = a;
      this.unduck();
      this.diag("aside.goon");
      return;
    }
    this.diag("aside.answer");
    if (a.hushed) return;
    a.hushed = true;
    this.held = this.held.filter((it) => (it.meta as { rid?: string } | undefined)?.rid !== a.rid);
    this.queue.stop();
    this.unduck();
    this.send({ type: "barge", rid: a.rid, heard: a.started.join(" "), aside: true });
  }

  /** (realtime) their voice again after the end seemed sure, before her voice began: her answer waits once more */
  private holdTurn(): void {
    const r = this.current;
    if (!r || r.hushed || r.greeting || r.started.length || this.asideFor) return;
    this.turnOpen = true;
    clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => this.confirmTurn(), TURN_OPEN_MAX_MS);
    // (her sentences gone to her voice, none begun: back to waiting)
    const back = r.queued;
    r.queued = [];
    r.lines = 0;
    if (back.length) {
      this.held = this.held.filter((it) => (it.meta as { rid?: string } | undefined)?.rid !== r.rid);
      this.queue.stop();
    }
    this.waiting = [...back.map((s) => ({ r, s })), ...this.waiting];
    this.diag("turn.hold", { back: back.length });
  }

  /** (realtime) the end of their turn is sure: her answer to it may be heard */
  private confirmTurn(): void {
    clearTimeout(this.turnTimer);
    if (!this.turnOpen) return;
    this.turnOpen = false;
    const w = this.waiting;
    this.waiting = [];
    // (only her answer to this turn: one to a turn they went on from was dropped)
    for (const x of w) if (x.r === this.current && !x.r.hushed) this.say(x.r, x.s, true);
    const r = this.current;
    if (r && r.done && !r.lines && !r.hushed && !r.greeting && !r.aside) this.ev.caption("…");
    if (r && r.aside && r.done && !r.words && !r.hushed) this.endAside(false);
  }

  /** (realtime) they went on after their turn went to her: her answer to it goes — unheard if it hadn't begun */
  private resumeTurn(): void {
    const r = this.current;
    this.waiting = [];
    this.turnOpen = true; // (the whole of it comes as an amend)
    clearTimeout(this.turnTimer);
    if (!r || r.hushed) return;
    // (her answer to an aside not come yet: it will wait; the answer they spoke over goes on)
    if (this.asideFor && r === this.asideFor) return;
    const q = this.queue.getState();
    const playing = (q.current?.meta as { rid?: string } | undefined)?.rid === r.rid;
    if (r.started.length || playing) {
      this.interrupt();
      return;
    }
    r.hushed = true;
    this.held = this.held.filter((it) => (it.meta as { rid?: string } | undefined)?.rid !== r.rid);
  }

  /** how long her current answer has played (ms) */
  private heardMs = (): number => {
    const r = this.current;
    return r && r.heardFrom && !r.hushed ? Date.now() - r.heardFrom : 0;
  };

  /** turned down until her answer to an aside says (no timer of its own: the aside's) */
  private keepDucked(): void {
    clearTimeout(this.duckTimer);
    if (!this.ducked) {
      this.ducked = true;
      this.applyVolume();
    }
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

  /** the microphone and the recognition (from the start of the call) → once the microphone is open */
  private startListening(): Promise<void> {
    if (this.listening || this.over) return Promise.resolve();
    this.listening = true;
    const mate = this.mate;
    // (they called her: what is heard while it rings — the ring-back itself — is no word of theirs)
    const early = () => this.call.direction === "outgoing" && !this.through;
    this.listener = listen(
      {
        mateId: mate.id,
        lang: bcp47(mate.voice.stt.language || mate.persona.language) || undefined,
        plan: this.plan.stt,
        speaking: this.speakingNow,
        audible: this.audibleNow,
        spoken: this.spokenLately,
        voicedAt: () => (this.speakingNow() ? Date.now() : this.voiceEndedAt),
        heardMs: this.heardMs,
        herNames: herNames(mate.name),
        muted: () => this.muted,
      },
      {
        onUtterance: (text, endAt, how, amend, aside) => {
          if (!this.muted && !early()) this.utter(text, endAt, how, !!amend, !!aside);
        },
        onConfirm: () => this.confirmTurn(),
        onHold: () => {
          if (!early()) this.holdTurn();
        },
        onResumed: () => {
          if (!early()) this.resumeTurn();
        },
        onSpeech: (sure) => {
          if (early()) return;
          this.ev.userTalking(true);
          if (sure) this.interrupt();
          else this.duck();
        },
        onSilence: () => {
          this.ev.userTalking(false);
          this.unduck();
        },
        onPartial: (text) => this.ev.partial(text),
        onLevel: (v) => {
          this.ev.level(v);
          this.noteLevel(v);
        },
        onNotice: (text) => {
          this.ev.notice(text);
          if (text) this.reroute(); // (another way of listening: the microphone opens again, and the WebView reroutes)
        },
        onFail: (text) => this.ev.deaf(text),
        onDiag: (ev, data) => {
          this.diag(ev, data);
          // (the microphone opened again for another way of listening: the WebView may have taken the loudspeaker)
          if (ev === "record" || ev === "stream.retry") this.reroute();
        },
      },
    );
    this.diag("listen", { mode: this.listener.mode, plan: this.plan.stt.mode, engine: this.plan.stt.engine || "" });
    return this.listener.start();
  }

  /**
   * One turn of theirs goes to her. `amend`: the whole of the last one again — they went on after a pause (her answer
   * to the half was dropped, or stopped as it began: the server answers the whole). A realtime turn goes before its end
   * is sure: her answer's voice waits for `confirmTurn` (mate/call/turns.ts).
   */
  private utter(text: string, endAt: number, how: string, amend = false, aside = false): void {
    if (this.over || !text.trim()) return;
    this.ev.partial("");
    this.ev.userTalking(false);
    const q = this.queue.getState();
    const voice = !!(q.current || q.pending || this.held.length);
    // (said over her voice, maybe not to her — or more of such an aside: she goes on, turned down, while she judges)
    const over = this.asideFor && !this.asideFor.hushed ? this.asideFor : aside && voice && this.current && !this.current.hushed ? this.current : null;
    if (over && (aside || amend)) {
      if (amend) this.resumeTurn();
      this.asideFor = over;
      this.keepDucked();
      clearTimeout(this.asideTimer);
      this.asideTimer = setTimeout(() => this.endAside(false), ASIDE_MAX_MS);
      this.waiting = [];
      this.turnOpen = how === "realtime";
      clearTimeout(this.turnTimer);
      if (this.turnOpen) this.turnTimer = setTimeout(() => this.confirmTurn(), TURN_OPEN_MAX_MS);
      this.pending = { endAt, stt: how };
      const prev = amend && this.current && this.current.aside ? this.current : null;
      const seq = ++this.seq;
      if (this.send({ type: "say", seq, text, aside: true, ...(amend ? { amend: true, heard: "", ...(prev ? { rid: prev.rid } : {}) } : {}), over: over.rid, over_heard: over.started.join(" ") }))
        this.asideSeqs.push(seq);
      else this.pending = null;
      return;
    }
    // (her answer to the half — what of it they heard, for the server to keep as said)
    const half = amend && this.current && !this.current.greeting && this.current.rid !== this.answeredBefore ? this.current : null;
    const heard = half ? half.started.join(" ") : "";
    if (amend) this.resumeTurn();
    else this.interrupt(); // (a whole sentence of theirs while she spoke: theirs wins)
    this.waiting = [];
    this.turnOpen = how === "realtime";
    clearTimeout(this.turnTimer);
    if (this.turnOpen) this.turnTimer = setTimeout(() => this.confirmTurn(), TURN_OPEN_MAX_MS);
    this.pending = { endAt, stt: how };
    if (!amend) this.answeredBefore = this.current?.rid ?? "";
    const more = amend ? { amend: true, heard, ...(half ? { rid: half.rid } : {}) } : {};
    if (!this.send({ type: "say", seq: ++this.seq, text, ...more })) this.pending = null;
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
    if (nativeCalls()) setCallRoute(on ? "speaker" : "ear"); // (a microphone opened again keeps to it)
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
    clearTimeout(this.turnTimer);
    clearTimeout(this.asideTimer);
    clearInterval(this.pingTimer);
    this.offApp?.();
    this.offApp = null;
    this.listener?.stop();
    this.listener = null;
    this.stopRing?.();
    this.stopRing = null;
    for (const t of this.rerouteTimers) clearTimeout(t);
    this.rerouteTimers = [];
    setCallRoute(null);
    this.queue.dispose();
    this.releaseVoice?.();
    this.releaseVoice = null;
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

/** her names as they'd be called: the whole, and a Korean given name ("한채린" → "채린") */
export function herNames(name: string): string[] {
  const n = (name || "").trim();
  if (!n) return [];
  const out = [n];
  if (/^[\uac00-\ud7a3]{3}$/.test(n)) out.push(n.slice(1));
  return out;
}
