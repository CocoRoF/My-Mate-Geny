import { saveSpeech, pendingSpeech, ackSpeech } from "./stt/outbox";
import type {SpeechPacket} from "./stt/draft";
import {useDraftStore} from "../stores/draftStore";
import {tr} from "../i18n";
import { rememberConversation } from "../lib/lastConversation";
import { activityMood } from "./activityMood";
import { useDevicePreferences, devicePreferencesLoaded } from "../stores/devicePreferences";
/**
 * A mate's conversation, live (docs/mate.md §3): POST /api/mates/{id}/conversation → its session, then the same
 * /api/history + /ws/chat protocol as a chat — but in its own store (createChatStore), so the Chat view and the Mate
 * can both be live at once. On top of the stream: the avatar's mood and reactions, captions, and the voice (each
 * completed sentence goes to the shared audio queue while the reply still streams).
 *
 * Every page that shows a mate (the console's Mate view, the desktop overlay / quick / chat windows) uses this hook;
 * they all attach to the same session, so they stay in sync.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toLogin, wsUrl } from "../api/client";
import { getHistoryPage } from "../api/sessions";
import { openConversation, prefsOf, resetConversation, speech as synthesizeSpeech, SpeechFallbackError, type Mate } from "../api/mates";
import { onResync } from "../lib/sync";
import { createChatStore, FIRST_TURNS, type Turn } from "../stores/chatStore";
import { useMateStore } from "../stores/mateStore";
import type { Attachment, ProviderEvent } from "../types";
import { getMateAudioQueue, useMateAudio } from "./audioQueue";
import { usePreviewFlags } from "./livePreview";
import { EmotionTracker, reactsAt, voiceEmotionAt } from "./emotion";
import { pokeMate } from "../api/mates";
import { STATE_STRONG, stateLook } from "./stateLook";
import { SentenceStream } from "./sentences";
import { withoutCode } from "./markdown";
import type { BodyMood, MateReact } from "./types";
import { currentSurface, useDesktopMate, type DesktopMateState } from "./desktop";
import { useVoiceSpeaking } from "./voiceBridge";
import { announceStarted, clientMsgId, deviceId, deviceOf, noteSaid, onHush, RANK_OVERLAY, RANK_SURFACE, RANK_SURFACE_HIDDEN, setLocalVoicing, startedUpTo, useVoiceElection } from "./voiceOwner";

/** the page's mate conversation (one mate at a time per page) */
export const useMateChat = createChatStore();

const AWAY_AFTER_MS = 20 * 60_000;
/** a replayed event older than this is not read aloud (a reconnect catching up) */
const SPEAK_FRESH_MS = 60_000;

export interface Caption {
  text: string;
  at: number;
}

const LANGS: Record<string, string> = {
  ko: "ko-KR", en: "en-US", ja: "ja-JP", zh: "zh-CN", es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-BR", it: "it-IT",
  ru: "ru-RU", vi: "vi-VN", th: "th-TH", id: "id-ID",
};
export const bcp47 = (lang: string | undefined) => {
  const l = (lang || "").trim();
  if (!l) return "";
  return l.includes("-") ? l : LANGS[l.toLowerCase()] || l;
};

/**
 * Who reads aloud — one voice (mate/voiceOwner.ts): on the device that sent the message (a turn the mate starts: where
 * the user last talked from), and there in ONE window: the one already reading a reply keeps it, else the avatar
 * overlay while it is on screen, else the most recently focused Mate surface (mate chat window / console Mate view).
 * The quick card is never a candidate. This is a page's rank in that election (0: not a candidate).
 */
export function voiceRank(surface: string, desk: DesktopMateState | null, pageVisible: boolean): number {
  if (surface === "device-runtime") return 0.5;
  if (surface === "mate-quick") return 0; // it closes after sending; whoever is elected answers
  if (surface === "mate-overlay") return pageVisible && (desk ? desk.visible : true) ? RANK_OVERLAY : 0;
  // a page on screen before one in the background (a hidden tab's throttled beats must not make two speakers)
  return pageVisible ? RANK_SURFACE : RANK_SURFACE_HIDDEN;
}

function usePageVisible(): boolean {
  const [v, setV] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const on = () => setV(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return v;
}

/** a turn being followed: its sentences (all windows keep them, so a window taking over goes on from the next one) */
/** how often the idle avatar shows how she feels (mate/stateLook.ts): more often the stronger it is */
const STATE_LOOK_EVERY_MS = 75_000;
const STATE_LOOK_STRONG_EVERY_MS = 30_000;

interface Follow {
  key: string;
  /** the turn as every window knows it (its start on the server), for "this sentence is said" between windows */
  vid: string;
  stream: SentenceStream;
  emo: EmotionTracker;
  /** avatar reactions this reply had (the "subtle" emotion level reacts once) */
  reacted: number;
  quiet: boolean;
  /** a completed, freshly observed reply may wait for the startup election or autoplay handoff */
  seenAt: number;
  finished: boolean;
  queued: Set<number>;
  /** a barge-in stopped her voice: the rest of this reply is shown, not read */
  hushed?: boolean;
  /** the device the turn answers (null: unknown — read here) */
  origin: string | null;
  sentences: { idx: number; speech: string; emotion: string | null | undefined; text: string }[];
  /** sentences seen so far (the next one's index) */
  n: number;
}

function lastAssistant(turns: Turn[]): { turn: Turn; index: number } | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") return { turn: turns[i], index: i };
    if (turns[i].role === "user") return null;
  }
  return null;
}

export interface MateConversation {
  sessionId: string | null;
  turns: Turn[];
  streaming: boolean;
  connection: "connecting" | "open" | "reconnecting";
  error: string | null;
  mood: BodyMood;
  /** conversation activity only; audio start/end/mute/cancel never drives a video */
  videoMood: BodyMood;
  react: MateReact;
  caption: Caption | null;
  voiceError: string | null;
  speaks: boolean; // this page is the one reading aloud
  /** the volume the voice plays at now (0..3): the saved one, or a settings slider's live preview */
  volume: number;
  /** a new turn (text and/or files) */
  send: (text: string, attachments?: Attachment[]) => boolean;
  /** add to her running turn */
  steer: (text: string, attachments?: Attachment[]) => boolean;
  speech: (packet: Record<string,unknown>, attachments?: Attachment[]) => boolean;
  speechReady: boolean;
  speechClosed: {id:string;revision:number;at:number}|null;
  stop: () => void;
  reset: () => Promise<void>;
  /** the user is typing / talking: the mate listens */
  setListening: (on: boolean) => void;
  /** a one-shot reaction (settings preview, tap) */
  poke: (name: string) => void;
  /** say something through this mate's voice (settings: test) */
  say: (text: string) => void;
  stopVoice: () => void;
}

/** ``connect: false`` — no conversation (the Mate Create studio: a draft has none yet; only the voice test) */
export function useMateConversation(mate: Mate | null, opts: { voice?: boolean; connect?: boolean } = {}): MateConversation {
  const store = useMateChat;
  const turns = store((s) => s.turns);
  const streaming = store((s) => s.isStreaming);
  const connection = store((s) => s.connection);
  const [speechReady,setSpeechReady] = useState(false);
  const [speechClosed,setSpeechClosed] = useState<MateConversation["speechClosed"]>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // her conversation was replaced (her memory was reset, here or in another window): open the new one
  const [conversationRev, setConversationRev] = useState(0);
  const conversationNow = mate?.session_id ?? null;
  useEffect(() => {
    if (sessionId && conversationNow && conversationNow !== sessionId) {
      getMateAudioQueue().stop();
      setCaption(null);
      setConversationRev((n) => n + 1);
    }
  }, [sessionId, conversationNow]);
  const [error, setError] = useState<string | null>(null);
  const [react, setReact] = useState<MateReact>(null);
  const [caption, setCaption] = useState<Caption | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [listening, setListeningState] = useState(false);
  const [away, setAway] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const activity = useRef(Date.now());
  const mateId = mate?.id ?? null;
  useEffect(()=>{setSpeechReady(false);},[mateId]);

  const surface = useMemo(currentSurface, []);
  const desk = useDesktopMate();
  const muted = useMateStore((s) => s.muted);
  const engine = mate?.voice.tts.engine ?? "off";
  const pageVisible = usePageVisible();
  // the turn this window is reading now (it keeps the voice until that reply is done)
  const [speakingTurn, setSpeakingTurn] = useState<string | null>(null);
  const [blockedTurn, setBlockedTurn] = useState<string | null>(null);
  const rank = opts.voice === false || blockedTurn ? 0 : voiceRank(surface, desk, pageVisible);
  const owner = useVoiceElection(mateId, rank, speakingTurn);
  const voiceEnabled = opts.voice !== false && !muted && !!mate?.voice.auto_read && engine !== "off";
  const voiceEnabledRef = useRef(voiceEnabled);
  voiceEnabledRef.current = voiceEnabled;
  const speaks = owner && voiceEnabled;
  const speaksRef = useRef(speaks);
  speaksRef.current = speaks;
  /** the device the latest user message came from (mate/voiceOwner: a reply is read on the device that asked) */
  const lastSender = useRef<string | null>(null);
  const turnOrigin = useRef<string | null>(null);
  const followRef = useRef<Follow | null>(null);

  const touch = useCallback(() => {
    activity.current = Date.now();
    setAway(false);
  }, []);

  // ── the voice: resolver for this mate's engine ──
  const { queue, state: qstate } = useMateAudio();
  const tts = mate?.voice.tts;
  const lang = bcp47(tts?.language || mate?.persona.language);
  useEffect(() => {
    if (!mateId) return;
    const server = engine !== "browser" && engine !== "off";
    // a server engine that is no longer set up answers "use the browser voice" (SpeechFallbackError): the page speaks
    queue.fallbackToBrowser = engine !== "off";
    queue.setBrowserVoice({ lang: lang || undefined, voice: engine === "browser" ? tts?.voice || undefined : undefined, rate: tts?.speed || 1 });
    /** why the browser voice speaks instead of the mate's engine (shown, not an error that stops anything) */
    let fallbackWhy: string | null = null;
    queue.setResolver(
      server
        ? async (item, signal) => {
            try {
              const clip = await synthesizeSpeech(mateId, item.text || "", item.emotion ?? null, signal);
              fallbackWhy = null;
              return clip;
            } catch (err) {
              if (!(err instanceof SpeechFallbackError)) throw err;
              fallbackWhy = err.message;
              return null;
            }
          }
        : null,
    );
    queue.onItemStart = (item) => {
      if (item.text) setCaption({ text: String((item.meta as any)?.display ?? item.text), at: Date.now() });
      setVoiceError(fallbackWhy);
      // the other windows of this device: this sentence (and all before it) is said — never again, never twice
      const m = item.meta as { turn?: string; idx?: number } | undefined;
      const f = followRef.current;
      if (f && m?.turn === f.vid) setSpeakingTurn(f.key);
      if (m?.turn && typeof m.idx === "number") announceStarted(mateId, m.turn, m.idx, item.text);
      else if (item.text) noteSaid(mateId, item.text);
      // (the mic in any window of this device: she is speaking — mate/stt/echo.ts)
      setLocalVoicing(mateId, true);
    };
    queue.onItemEnd = () => setLocalVoicing(mateId, false);
    queue.onError = (_item, err) => setVoiceError((err as Error)?.message || String(err));
    return () => {
      queue.onItemStart = null;
      queue.onItemEnd = null;
      queue.onError = null;
      setLocalVoicing(mateId, false);
    };
  }, [queue, mateId, engine, lang, tts?.voice, tts?.speed]);

  // the mate's volume (0–300 %): clips through a GainNode + limiter, the browser voice up to 100 %. The settings'
  // unsaved slider (this window or another one of this browser: mate/livePreview) wins while it moves; the saved
  // value comes from the store, which follows the server's pushes (no stale copy in an overlay opened hours ago)
  // the emotion level (prefs.emotion): how readily tags in her replies move the avatar and colour the voice. The
  // Conversation style tab's unsaved level previews in every window; the saved one follows the server's pushes.
  const flags = usePreviewFlags(mateId);
  const lookNow = stateLook(mate, flags?.avatarMood);
  const lookRef = useRef(lookNow);
  lookRef.current = lookNow;
  const emotionLevel = useRef(2);
  emotionLevel.current = flags?.emotion ?? prefsOf(mate).emotion;

  const device = useDevicePreferences();
  const volume = devicePreferencesLoaded() && (device.migration.imported || device.migration.volumeEdited) ? device.volume : 0;
  useEffect(() => {
    queue.setVolume(volume);
  }, [queue, volume]);

  // a different mate (or leaving the view): stop talking
  useEffect(() => () => queue.stop(), [queue, mateId]);
  useEffect(()=>window.hrhNative?.onQuitting?.(()=>{
    speaksRef.current=false;queue.stop();setListeningState(false);wsRef.current?.close();
  }),[queue]);
  // muted / no longer the owner: stop at once
  useEffect(() => {
    if (!voiceEnabled && followRef.current) followRef.current.hushed = true;
    if (!speaks) {
      queue.stop();
      followRef.current?.queued.clear();
      setSpeakingTurn(null);
    }
  }, [speaks, voiceEnabled, queue]);
  // A blocked queue has not spoken. Let an eligible visible window take over it.
  useEffect(() => {
    if (qstate.blocked) {
      setBlockedTurn(followRef.current?.key || "blocked");
      setSpeakingTurn(null);
    }
  }, [qstate.blocked]);

  // nothing playing (stopped, done): not voicing
  useEffect(() => {
    if (mateId && !qstate.current) setLocalVoicing(mateId, false);
  }, [mateId, qstate.current]);

  // A barge-in (the user started talking over her, in any window of this device — mate/stt/realtime.ts): she stops
  // here, and the rest of that reply is not read either (it stays written).
  useEffect(() => {
    if (!mateId) return;
    return onHush((id) => {
      if (id !== mateId) return;
      const f = followRef.current;
      if (f) f.hushed = true;
      queue.stop();
      setSpeakingTurn(null);
    });
  }, [mateId, queue]);

  // The reply this window reads stays here until it is written AND said; then the voice is free for the next reply.
  const busy = !!qstate.current || qstate.pending > 0;
  useEffect(() => {
    if (!speakingTurn || busy) return;
    const t = store.getState().turns.find((x) => x.key === speakingTurn);
    if (!t || t.complete) setSpeakingTurn(null);
  }, [speakingTurn, busy, turns, store]);

  /** read one sentence of a followed turn here, unless a window of this device already started it (or a later one) */
  const readHere = useCallback(
    (f: Follow, s: Follow["sentences"][number]) => {
      if (s.idx <= startedUpTo(f.vid) || f.queued.has(s.idx)) return false;
      f.queued.add(s.idx);
      queue.enqueue({ text: s.speech, emotion: voiceEmotionAt(emotionLevel.current, s.emotion), meta: { display: s.text, turn: f.vid, idx: s.idx } });
      setSpeakingTurn(f.key);
      return true;
    },
    [queue],
  );
  const readHereRef = useRef(readHere);
  readHereRef.current = readHere;

  // Taking over in the middle of a reply (the window reading it closed / crashed): go on from the next sentence.
  useEffect(() => {
    if (!speaks) return;
    const f = followRef.current;
    if (!f || f.quiet || f.hushed || (f.origin !== null && f.origin !== deviceId)) return;
    const t = store.getState().turns.find((x) => x.key === f.key);
    const said = startedUpTo(f.vid);
    if (!t || (t.complete && said < 0 && Date.now() - f.seenAt >= SPEAK_FRESH_MS)) return;
    for (const s of f.sentences) if (s.idx > said) readHere(f, s);
  }, [speaks, readHere, store]);

  // ── open the conversation + stream it ──
  const connectOn = opts.connect !== false;
  useEffect(() => {
    if (!mateId || !connectOn) return;
    let alive = true;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let probe: ReturnType<typeof setTimeout> | undefined;
    let gen = 0;
    let sid: string | null = null;
    const { reset, loadHistory, applyEvent, setConnection } = store.getState();
    reset();
    setSessionId(null);
    setError(null);

    // follow the reply being written: sentences → voice/caption, tags → react
    let follow: Follow | null = null;
    followRef.current = null;
    lastSender.current = null;
    turnOrigin.current = null;
    // Turns that came with the history are not read aloud (by key: older
    // pages prepended later shift the indexes).
    let quiet = new Set<string>();
    const followTurn = (fresh: boolean) => {
      const turns = store.getState().turns;
      const la = lastAssistant(turns);
      if (!la || quiet.has(la.turn.key)) return;
      const t = la.turn;
      if (!follow || follow.key !== t.key) {
        setBlockedTurn(null);
        // (the device a reply is read on is fixed when it starts: a message added meanwhile does not move it)
        follow = {
          key: t.key,
          vid: t.startedAt ? `t${t.startedAt}` : t.key,
          stream: new SentenceStream({ minChars: 8 }),
          emo: new EmotionTracker(),
          reacted: 0,
          quiet: !fresh,
          hushed: !voiceEnabledRef.current,
          origin: t.voiceDevice ?? turnOrigin.current ?? lastSender.current,
          seenAt: Date.now(),
          finished: false,
          queued: new Set(),
          sentences: [],
          n: 0,
        };
        followRef.current = follow;
      }
      const f = follow;
      const e = f.emo.pushTag(withoutCode(t.text)); // ([ok] in a code block is no feeling)
      if (e && !f.quiet && reactsAt(emotionLevel.current, e.intensity, f.reacted)) {
        f.reacted++;
        // (a blank face is how she feels; a tag that says something stands for itself)
        setReact({ name: (e.emotion === "neutral" && lookRef.current) || e.emotion, at: Date.now() });
      }
      const done = t.complete;
      if (f.finished) return;
      const sentences = done ? f.stream.flush(t.text) : f.stream.push(t.text);
      if (done) f.finished = true;
      // a sentence's index is its place in the whole reply (the same in every window, also one that joined late)
      const first = f.n;
      f.n += sentences.length;
      if (f.quiet) return;
      const mine = f.origin === null || f.origin === deviceId;
      sentences.forEach((s, i) => {
        const item = { idx: first + i, speech: s.speech, emotion: s.emotion, text: s.text };
        if (s.speech) f.sentences.push(item);
        if (!(speaksRef.current && mine && !f.hushed && s.speech && readHereRef.current(f, item))) setCaption({ text: s.text, at: Date.now() });
      });
    };

    const connect = async () => {
      const mine = ++gen;
      setConnection(retry ? "reconnecting" : "connecting");
      try {
        if (!sid) {
          const conv = await openConversation(mateId);
          if (!alive || mine !== gen) return;
          sid = conv.session_id;
          store.setState({ sid }); // (older pages are fetched for it)
          setSessionId(sid);
          useMateStore.getState().upsert(conv.mate);
        }
        // the newest turns first; a reconnect reloads what is shown (older pages stay)
        const s = store.getState();
        const h = await getHistoryPage(
          sid,
          s.opened && s.sid === sid && s.paging.paged ? { since: s.paging.cursor ?? "" } : { turns: FIRST_TURNS },
        );
        if (!alive || mine !== gen) return;
        loadHistory(h);
        const turns = store.getState().turns;
        quiet = new Set(turns.map((t) => t.key));
        follow = null;
        followRef.current = null;
        const la = lastAssistant(turns);
        if (h.running && la && !la.turn.complete) {
          // a reply already being written: follow it from here on (what was said before stays unsaid)
          quiet.delete(la.turn.key);
          followTurn(false);
          if (follow) (follow as { quiet: boolean }).quiet = false;
        }
        setError(null);
      } catch (e) {
        if (!alive || mine !== gen) return;
        setError((e as Error).message);
        schedule();
        return;
      }
      const ws = new WebSocket(wsUrl(`/ws/chat/${sid}`));
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setConnection("open");
        ws.send(JSON.stringify({ type: "attach", after: store.getState().lastEid }));
        for(const held of pendingSpeech(sid!)) {
          ws.send(JSON.stringify({type:'speech',...held.packet,attachments:held.attachments,idle_ms:Math.max(0,Date.now()-held.packet.activity_at)}));
        }
      };
      ws.onmessage = (e) => {
        clearTimeout(probe);
        let ev: ProviderEvent;
        try {
          ev = JSON.parse(e.data);
        } catch {
          return;
        }
        // A replay overlap must not stop current audio or flush an already-finished sentence stream again.
        if (ev.eid && ev.eid <= store.getState().lastEid) return;
        if (ev.type === "run.state" && ev.data?.speech_protocol!==undefined) setSpeechReady(ev.data.speech_protocol===2);
        if(ev.type === "speech.pending") ackSpeech(sid!,String(ev.data?.group_id),Number(ev.data?.revision));
        if(ev.type === "speech.closed") {
          setSpeechClosed({id:String(ev.data?.group_id),revision:Number(ev.data?.revision),at:Date.now()});
          const kept=ackSpeech(sid!,String(ev.data?.group_id),Number(ev.data?.revision),String(ev.data?.accepted_text||""));
          if(kept){const drafts=useDraftStore.getState(),text=drafts.drafts[sid!]?.text||"";if(!text.endsWith(kept))drafts.setText(sid!,[text,kept].filter(Boolean).join(" "));setError(tr("mate.speechLate"));}
        }
        if(ev.type === "speech.failed") {setError(String(ev.data?.message||tr("mate.speechFailed")));return;}
        if (ev.type === "task.state" || ev.type === "usage.update") return;
        if (ev.type === "user.message" || ev.type === "user.steer") {
          // where the user is talking from: replies are read on that device (internal messages — a delegated task
          // reporting back — do not move it; a message without a device came from another / older client)
          const d = (ev.data ?? {}) as { client_msg_id?: unknown; internal?: unknown; device?: unknown };
          if (!d.internal) {
            lastSender.current = deviceOf(d.client_msg_id) ?? (d.client_msg_id ? "?" : lastSender.current);
            turnOrigin.current = lastSender.current;
            // a new question / an addition: she stops talking — in whichever window was reading (not only the
            // one it was typed in: the quick card's question stops the overlay)
            queue.stop();
            if (followRef.current) followRef.current.hushed = true;
            followRef.current?.queued.clear();
          } else if (ev.type === "user.message") {
            turnOrigin.current = deviceOf(d.client_msg_id) ?? deviceOf(`~${d.device ?? ""}`) ?? lastSender.current;
          }
        }
        applyEvent(ev);
        if (ev.type === "text.delta" || ev.type === "turn.complete" || ev.type === "error" || ev.type === "session.start") {
          const at = Date.parse(ev.timestamp) || Date.now();
          followTurn(Date.now() - at < SPEAK_FRESH_MS);
          touch();
        } else if (ev.type === "user.message") {
          touch();
        }
        // (steers the turn could no longer take: the composer queues them for the next turn)
      };
      ws.onclose = (e) => {
        if (wsRef.current !== ws) return;
        setSpeechReady(false);
        wsRef.current = null;
        clearTimeout(probe);
        if (e.code === 4401) return toLogin();
        if (!alive) return;
        schedule();
      };
    };

    const schedule = () => {
      setConnection("reconnecting");
      const delay = Math.min(15000, 800 * 2 ** retry++);
      timer = setTimeout(() => alive && connect(), delay);
    };

    const reconnectNow = () => {
      if (!alive) return;
      clearTimeout(timer);
      clearTimeout(probe);
      const old = wsRef.current;
      wsRef.current = null;
      old?.close();
      retry = 0;
      connect();
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible" || !alive) return;
      const ws = wsRef.current;
      if (!ws) return reconnectNow();
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: "attach", after: store.getState().lastEid }));
      } catch {
        return reconnectNow();
      }
      clearTimeout(probe);
      probe = setTimeout(reconnectNow, 5000);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    const offResync = onResync(reconnectNow);

    connect();
    return () => {
      alive = false;
      clearTimeout(timer);
      clearTimeout(probe);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      offResync();
      const old = wsRef.current;
      wsRef.current = null;
      old?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mateId, store, connectOn, conversationRev]);

  /** a new turn with these files; false when not connected (the caller keeps the draft) */
  const send = useCallback(
    (input: string, attachments: Attachment[] = []): boolean => {
      const text = input.trim();
      if (!text && !attachments.length) return false;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      touch();
      queue.stop(); // a new question: she stops talking
      const cid = clientMsgId("m"); // (names this device: the reply is read here — mate/voiceOwner)
      lastSender.current = deviceId;
      store.getState().pushUser(text, attachments, cid);
      store.getState().setStreaming(true);
      ws.send(JSON.stringify({ type: "chat", input: text, attachments: attachments.map((a) => a.id), client_msg_id: cid }));
      if (mateId) rememberConversation({ kind: "mate", id: mateId });
      return true;
    },
    [store, queue, touch, mateId],
  );

  /** add to her running turn (like a chat's steer); false when not connected */
  const steer = useCallback(
    (input: string, attachments: Attachment[] = []): boolean => {
      const text = input.trim();
      if (!text && !attachments.length) return false;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      touch();
      queue.stop();
      const cid = clientMsgId("s"); // (names this device: the reply is read here — mate/voiceOwner)
      lastSender.current = deviceId;
      store.getState().pushSteer(text, attachments, cid);
      ws.send(JSON.stringify({ type: "steer", input: text, attachments: attachments.map((a) => a.id), client_msg_id: cid }));
      if (mateId) rememberConversation({ kind: "mate", id: mateId });
      return true;
    },
    [store, queue, touch, mateId],
  );

  const speech = useCallback((packet:Record<string,unknown>,attachments:Attachment[]=[]) => {
    const ws=wsRef.current;
    if(!speechReady||!ws||ws.readyState!==WebSocket.OPEN)return false;
    touch();queue.stop();lastSender.current=deviceId;
    const ids=attachments.map(a=>a.id);
    if(!saveSpeech(store.getState().sid!,packet as unknown as SpeechPacket,ids)){setError(tr("mate.speechSaveFailed"));return false;}
    const kept=pendingSpeech(store.getState().sid!).find(p=>p.packet.group_id===packet.group_id);
    ws.send(JSON.stringify({type:'speech',...packet,attachments:kept?.attachments??ids}));
    if (mateId && packet.op !== "touch") rememberConversation({ kind: "mate", id: mateId });
    return true;
  },[speechReady,touch,queue,mateId]);

  const stop = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: "stop" }));
    queue.stop();
  }, [queue]);

  const reset = useCallback(async () => {
    if (!mateId) return;
    queue.stop();
    await resetConversation(mateId);
  }, [mateId, queue]);

  const setListening = useCallback(
    (on: boolean) => {
      setListeningState(on);
      if (on) touch();
    },
    [touch],
  );

  // a tap: she answers it the way she feels, and it counts as something the user did
  const poke = useCallback(
    (name: string) => {
      setReact({ name: lookRef.current ?? name, at: Date.now() });
      if (mateId) void pokeMate(mateId).catch(() => {});
    },
    [mateId],
  );
  const say = useCallback(
    (text: string) => {
      setVoiceError(null);
      for (const s of new SentenceStream().flush(text)) {
        if (s.speech) queue.enqueue({ text: s.speech, emotion: s.emotion, meta: { display: s.text } });
        if (s.emotion) setReact({ name: s.emotion, at: Date.now() });
      }
    },
    [queue],
  );
  const stopVoice = useCallback(() => queue.stop(), [queue]);

  // ── away after a long quiet ──
  useEffect(() => {
    const t = setInterval(() => {
      if (Date.now() - activity.current > AWAY_AFTER_MS) setAway(true);
    }, 30_000);
    return () => clearInterval(t);
  }, []);
  // ── mood ──
  const speaking = useVoiceSpeaking() !== null || !!qstate.current;
  const la = lastAssistant(turns);
  const live = la && !la.turn.complete ? la.turn : null;
  const toolRunning = !!live && live.tools.some((t) => t.durationMs === undefined && !t.parent);
  const writing = !!live && !!live.text.trim() && !toolRunning;
  const videoMood = activityMood(streaming, writing, listening, away);
  const mood: BodyMood = speaking ? "talking" : videoMood;

  // What her face does comes from how she feels: while she is idle, the look for it now and then (shy in her underwear,
  // sleepy late at night), and often when she feels it strongly; what she shows in a reply goes first.
  const look = lookNow;
  const lookEvery = (mate?.state?.level ?? 0) >= STATE_STRONG ? STATE_LOOK_STRONG_EVERY_MS : STATE_LOOK_EVERY_MS;
  useEffect(() => {
    if (!look || videoMood !== "idle") return;
    const first = setTimeout(() => setReact({ name: look, at: Date.now() }), 4000);
    const every = setInterval(() => setReact({ name: look, at: Date.now() }), lookEvery);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [look, lookEvery, videoMood]);

  return {
    sessionId,
    turns,
    streaming,
    connection,
    error,
    mood,
    videoMood,
    react,
    caption,
    voiceError,
    speaks,
    volume,
    send,
    steer,
    speech,
    speechReady,
    speechClosed,
    stop,
    reset,
    setListening,
    poke,
    say,
    stopVoice,
  };
}

/** for tests / the lab: the queue this hook speaks through */
export const mateVoiceQueue = getMateAudioQueue;
