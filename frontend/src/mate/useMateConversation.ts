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
import { getHistory } from "../api/sessions";
import { openConversation, resetConversation, speech, SpeechFallbackError, type Mate } from "../api/mates";
import { onResync } from "../lib/sync";
import { createChatStore, type Turn } from "../stores/chatStore";
import { useMateStore } from "../stores/mateStore";
import type { ProviderEvent } from "../types";
import { getMateAudioQueue, useMateAudio } from "./audioQueue";
import { EmotionTracker } from "./emotion";
import { SentenceStream } from "./sentences";
import type { BodyMood, MateReact } from "./types";
import { currentSurface, useDesktopMate, type DesktopMateState } from "./desktop";
import { useVoiceSpeaking } from "./voiceBridge";

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
 * Who reads aloud: one voice. The desktop overlay speaks whenever it is out (for its mate); otherwise the mate chat
 * window if it is open; otherwise the console's Mate view. A browser (no desktop bridge) always speaks for itself.
 */
export function isVoiceOwner(surface: string, desk: DesktopMateState | null, mateId: string, defaultId: string | null): boolean {
  if (surface === "mate-quick") return false; // it closes after sending; the overlay answers
  if (!desk) return true;
  const overlayMate = desk.mateId || defaultId;
  const overlayOut = desk.visible && overlayMate === mateId;
  if (surface === "mate-overlay") return true;
  if (overlayOut) return false;
  if (surface === "mate-chat") return true;
  return !desk.chatOpen;
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
  react: MateReact;
  caption: Caption | null;
  voiceError: string | null;
  speaks: boolean; // this page is the one reading aloud
  send: (text: string) => boolean;
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

export function useMateConversation(mate: Mate | null, opts: { voice?: boolean } = {}): MateConversation {
  const store = useMateChat;
  const turns = store((s) => s.turns);
  const streaming = store((s) => s.isStreaming);
  const connection = store((s) => s.connection);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [react, setReact] = useState<MateReact>(null);
  const [caption, setCaption] = useState<Caption | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [listening, setListeningState] = useState(false);
  const [away, setAway] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const activity = useRef(Date.now());
  const mateId = mate?.id ?? null;

  const surface = useMemo(currentSurface, []);
  const desk = useDesktopMate();
  const muted = useMateStore((s) => s.muted);
  const defaultId = useMateStore((s) => s.mates.find((m) => m.is_default)?.id ?? s.mates[0]?.id ?? null);
  const engine = mate?.voice.tts.engine ?? "off";
  const owner = mateId ? isVoiceOwner(surface, desk, mateId, defaultId) : false;
  const speaks = opts.voice !== false && owner && !muted && !!mate?.voice.auto_read && engine !== "off";
  const speaksRef = useRef(speaks);
  speaksRef.current = speaks;

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
              const clip = await speech(mateId, item.text || "", item.emotion ?? null, signal);
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
    };
    queue.onError = (_item, err) => setVoiceError((err as Error)?.message || String(err));
    return () => {
      queue.onItemStart = null;
      queue.onError = null;
    };
  }, [queue, mateId, engine, lang, tts?.voice, tts?.speed]);

  // a different mate (or leaving the view): stop talking
  useEffect(() => () => queue.stop(), [queue, mateId]);
  // muted / no longer the owner: stop at once
  useEffect(() => {
    if (!speaks) queue.stop();
  }, [speaks, queue]);

  // ── open the conversation + stream it ──
  useEffect(() => {
    if (!mateId) return;
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
    let follow: { key: string; stream: SentenceStream; emo: EmotionTracker; quiet: boolean } | null = null;
    let baseline = 0; // turns that came with the history are not read aloud
    const followTurn = (fresh: boolean) => {
      const turns = store.getState().turns;
      const la = lastAssistant(turns);
      if (!la || la.index < baseline) return;
      const t = la.turn;
      if (!follow || follow.key !== t.key) {
        follow = { key: t.key, stream: new SentenceStream({ minChars: 8 }), emo: new EmotionTracker(), quiet: !fresh };
      }
      const f = follow;
      const e = f.emo.push(t.text);
      if (e && !f.quiet) setReact({ name: e, at: Date.now() });
      const done = t.complete;
      const sentences = done ? f.stream.flush(t.text) : f.stream.push(t.text);
      if (f.quiet) return;
      for (const s of sentences) {
        if (speaksRef.current && s.speech) {
          queue.enqueue({ text: s.speech, emotion: s.emotion, meta: { display: s.text } });
        } else {
          setCaption({ text: s.text, at: Date.now() });
        }
      }
    };

    const connect = async () => {
      const mine = ++gen;
      setConnection(retry ? "reconnecting" : "connecting");
      try {
        if (!sid) {
          const conv = await openConversation(mateId);
          if (!alive || mine !== gen) return;
          sid = conv.session_id;
          setSessionId(sid);
          useMateStore.getState().upsert(conv.mate);
        }
        const h = await getHistory(sid);
        if (!alive || mine !== gen) return;
        loadHistory(h);
        const turns = store.getState().turns;
        baseline = turns.length;
        follow = null;
        const la = lastAssistant(turns);
        if (h.running && la && !la.turn.complete) {
          // a reply already being written: follow it from here on (what was said before stays unsaid)
          baseline = la.index;
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
      };
      ws.onmessage = (e) => {
        clearTimeout(probe);
        let ev: ProviderEvent;
        try {
          ev = JSON.parse(e.data);
        } catch {
          return;
        }
        if (ev.type === "task.state" || ev.type === "usage.update") return;
        applyEvent(ev);
        if (ev.type === "text.delta" || ev.type === "turn.complete" || ev.type === "error" || ev.type === "session.start") {
          const at = Date.parse(ev.timestamp) || Date.now();
          followTurn(Date.now() - at < SPEAK_FRESH_MS);
          touch();
        } else if (ev.type === "user.message") {
          touch();
        }
        if (ev.type === "run.state" && !ev.data.running) {
          // steers the turn could no longer take: send them as the next message
          const bounced = store.getState().takeBounced();
          for (const b of bounced) sendChat(b.text);
        }
      };
      ws.onclose = (e) => {
        if (wsRef.current !== ws) return;
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
  }, [mateId, store]);

  const sendChat = (input: string): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const clientMsgId = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    store.getState().pushUser(input, [], clientMsgId);
    store.getState().setStreaming(true);
    ws.send(JSON.stringify({ type: "chat", input, attachments: [], client_msg_id: clientMsgId }));
    return true;
  };

  /** false when not connected (the caller keeps the draft) */
  const send = useCallback(
    (input: string): boolean => {
      const text = input.trim();
      if (!text) return false;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      touch();
      queue.stop(); // a new question: she stops talking
      if (store.getState().isStreaming) {
        // she is answering: add it to her running turn (like a chat's steer)
        const clientMsgId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        store.getState().pushSteer(text, [], clientMsgId);
        ws.send(JSON.stringify({ type: "steer", input: text, attachments: [], client_msg_id: clientMsgId }));
        return true;
      }
      return sendChat(text);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, queue, touch],
  );

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

  const poke = useCallback((name: string) => setReact({ name, at: Date.now() }), []);
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
  useEffect(() => {
    if (qstate.current) touch();
  }, [qstate.current, touch]);

  // ── mood ──
  const speaking = useVoiceSpeaking() !== null || !!qstate.current;
  const la = lastAssistant(turns);
  const live = la && !la.turn.complete ? la.turn : null;
  const toolRunning = !!live && live.tools.some((t) => t.durationMs === undefined && !t.parent);
  const writing = !!live && !!live.text.trim() && !toolRunning;
  const mood: BodyMood = speaking || (streaming && writing)
    ? "talking"
    : streaming
      ? "thinking"
      : listening
        ? "listening"
        : away
          ? "away"
          : "idle";

  return {
    sessionId,
    turns,
    streaming,
    connection,
    error,
    mood,
    react,
    caption,
    voiceError,
    speaks,
    send,
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
