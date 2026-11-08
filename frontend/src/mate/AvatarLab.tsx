/**
 * Avatar lab: `/?surface=avatar-lab` — a bare page to try the avatar renderers without the backend.
 *
 * URL params:
 *   avatar=<url>   JSON: an Avatar ({kind,…}), {avatar, name, portrait}, or an ailism rig.json (→ a video avatar).
 *                  `asset:<pack>/<file>` refs and relative paths resolve against the JSON's URL.
 *   core=<url>     Cubism Core script for Live2D (default /api/mates/live2d/core.js)
 *   kind=photo     force a rig to the photo body          size=lg|sm      mood=idle|listening|thinking|talking|away
 *   bg=dark|light|checker|transparent                      ui=0 (no panel: only the avatar, e.g. an overlay check)
 *
 * window.__mateLab = { setMood, react, speak(on), say(text), stream(text) } drives it from a test.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MateAvatar, setLive2DCoreUrl } from "./avatar/MateAvatar";
import { EMOTIONS, EmotionTracker } from "./emotion";
import { SentenceStream, splitBubbles } from "./sentences";
import { getMateAudioQueue, useMateAudio } from "./audioQueue";
import type { Avatar, BodyMood, MateReact, Rig } from "./types";
import {
  end as voiceEnd,
  fakeLevel,
  level as voiceLevel,
  start as voiceStart,
  useVoiceLevel,
  useVoiceSpeaking,
  voiceBridge,
} from "./voiceBridge";

const MOODS: BodyMood[] = ["idle", "listening", "thinking", "talking", "away"];
const BGS = ["dark", "light", "checker", "transparent"] as const;
type Bg = (typeof BGS)[number];

const SAMPLE =
  "[greet] 안녕하세요! 오늘도 같이 일해 볼까요? [thinking:0.6] 음… 어제 하던 리팩터링이 아직 남아 있네요. [joy] 그래도 테스트는 전부 통과했어요! [shy] 칭찬해 주시면 더 열심히 할게요.";

function resolveRef(ref: string | undefined, base: string): string {
  if (!ref) return "";
  let r = ref;
  if (r.startsWith("asset:")) {
    r = r.slice("asset:".length);
    const slash = r.indexOf("/");
    if (slash >= 0) r = r.slice(slash + 1);
  }
  try {
    return new URL(r, base).toString();
  } catch {
    return r;
  }
}

function resolveRig(rig: Rig, base: string): Rig {
  const stills: Record<string, string> = {};
  for (const [k, v] of Object.entries(rig.stills ?? {})) stills[k] = resolveRef(v, base);
  return {
    ...rig,
    home: resolveRef(rig.home, base),
    stills,
    clips: (rig.clips ?? []).map((c) => ({ ...c, src: resolveRef(c.src, base), small: c.small ? resolveRef(c.small, base) : undefined })),
  };
}

type Loaded = { avatar: Avatar; name: string; portrait: string | null };

function normalize(json: any, base: string, forceKind: string | null): Loaded {
  let name = "Mate";
  let portrait: string | null = null;
  let a: any = json;
  if (json && json.avatar) {
    a = json.avatar;
    name = json.name ?? name;
    portrait = json.portrait ? resolveRef(json.portrait, base) : null;
  }
  let avatar: Avatar;
  if (a && (a.kind === "video" || a.kind === "photo")) avatar = { kind: a.kind, rig: resolveRig(a.rig, base) };
  else if (a && a.kind === "live2d") avatar = { kind: "live2d", live2d: { ...a.live2d, model: resolveRef(a.live2d.model, base) } };
  else if (a && a.kind === "livliv") avatar = { kind: "livliv", livliv: { ...a.livliv, model: resolveRef(a.livliv.model, base) } };
  else if (a && Array.isArray(a.clips) && a.aspect) avatar = { kind: "video", rig: resolveRig(a as Rig, base) };
  else avatar = { kind: "none" };
  if (forceKind === "photo" && (avatar.kind === "video" || avatar.kind === "photo")) avatar = { kind: "photo", rig: { ...avatar.rig, clips: [] } };
  return { avatar, name, portrait };
}

export default function AvatarLab() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mood, setMood] = useState<BodyMood>((params.get("mood") as BodyMood) || "idle");
  const [react, setReact] = useState<MateReact>(null);
  const [size, setSize] = useState<"lg" | "sm">(params.get("size") === "sm" ? "sm" : "lg");
  const [bg, setBg] = useState<Bg>((BGS as readonly string[]).includes(params.get("bg") ?? "") ? (params.get("bg") as Bg) : "dark");
  const [sim, setSim] = useState(false);
  const [audioUrl, setAudioUrl] = useState(params.get("audio") ?? "");
  const [text, setText] = useState(SAMPLE);
  const [bubbles, setBubbles] = useState<string[]>([]);
  const [useTts, setUseTts] = useState(true);
  const [lastTap, setLastTap] = useState<string | null>(null);
  const ui = params.get("ui") !== "0";
  const level = useVoiceLevel();
  const speaking = useVoiceSpeaking();
  const { state: queue } = useMateAudio();
  const streamTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const core = params.get("core");
  if (core) setLive2DCoreUrl(core);

  useEffect(() => {
    const url = params.get("avatar");
    if (!url) {
      setLoaded({ avatar: { kind: "none" }, name: "Geny", portrait: null });
      return;
    }
    const abs = new URL(url, window.location.href).toString();
    fetch(abs)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((j) => setLoaded(normalize(j, abs, params.get("kind"))))
      .catch((e) => setError(`could not load ${url}: ${String(e)}`));
  }, [params]);

  // the page background: transparent shows the desktop (overlay check)
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prev = [html.style.background, body.style.background];
    const value =
      bg === "transparent"
        ? "transparent"
        : bg === "light"
          ? "#eef0f5"
          : bg === "checker"
            ? "repeating-conic-gradient(#3a3f4b 0% 25%, #22262f 0% 50%) 50% / 24px 24px"
            : "";
    html.style.background = bg === "transparent" ? "transparent" : "";
    body.style.background = value;
    return () => {
      html.style.background = prev[0];
      body.style.background = prev[1];
    };
  }, [bg]);

  // simulated speaking: a speech-like level through the bridge
  useEffect(() => {
    if (!sim) return;
    const id = "lab-sim";
    voiceStart(id);
    const t0 = performance.now();
    const t = setInterval(() => voiceLevel(fakeLevel(performance.now() - t0)), 33);
    return () => {
      clearInterval(t);
      voiceEnd(id);
    };
  }, [sim]);

  const fire = useCallback((name: string) => setReact({ name, at: Date.now() }), []);

  const say = useCallback((t: string) => {
    getMateAudioQueue().enqueue({ text: t, browser: { lang: "ko-KR" } });
  }, []);

  const stream = useCallback(
    (full: string, tts = useTts) => {
      if (streamTimer.current) clearInterval(streamTimer.current);
      const q = getMateAudioQueue();
      q.stop();
      const sentences = new SentenceStream({ minChars: 8 });
      const emotions = new EmotionTracker();
      let i = 0;
      setMood("thinking");
      streamTimer.current = setInterval(() => {
        i = Math.min(full.length, i + 2);
        const sofar = full.slice(0, i);
        const done = i >= full.length;
        setMood(done ? "idle" : "talking");
        setBubbles(splitBubbles(sofar, { streaming: !done }));
        const e = emotions.push(sofar);
        if (e) fire(e);
        const got = done ? sentences.flush(sofar) : sentences.push(sofar);
        if (tts) for (const s of got) if (s.speech) q.enqueue({ text: s.speech, emotion: s.emotion, browser: { lang: "ko-KR" } });
        if (done && streamTimer.current) {
          clearInterval(streamTimer.current);
          streamTimer.current = null;
        }
      }, 40);
    },
    [fire, useTts],
  );

  const playAudio = useCallback(() => {
    if (audioUrl) getMateAudioQueue().enqueue({ source: audioUrl });
  }, [audioUrl]);

  useEffect(() => {
    (window as any).__mateLab = {
      setMood,
      react: fire,
      speak: (on: boolean) => setSim(on),
      say,
      stream: (t: string, tts = false) => stream(t, tts),
      play: (url: string) => getMateAudioQueue().enqueue({ source: url }),
      stop: () => {
        setSim(false);
        getMateAudioQueue().stop();
      },
      setSize,
      setBg,
      voice: () => ({ speaking: voiceBridge.speaking, level: voiceBridge.currentLevel }),
    };
  }, [fire, say, stream]);

  const btn = (on: boolean) =>
    `rounded-md border px-2 py-1 text-xs transition ${on ? "border-accent bg-accent-soft text-content" : "border-border-strong text-content-dim hover:text-content"}`;

  const stage = (
    <div className="relative flex min-h-0 flex-1 items-end justify-center" data-testid="lab-stage">
      {error ? (
        <div className="m-auto max-w-md rounded-lg border border-danger/40 p-4 text-sm text-danger">{error}</div>
      ) : loaded ? (
        <div className={size === "sm" ? "h-[220px] w-[180px]" : "h-full w-full"}>
          <MateAvatar
            avatar={loaded.avatar}
            name={loaded.name}
            portrait={loaded.portrait}
            size={size}
            mood={mood}
            react={react}
            onTap={(a) => setLastTap(a ?? "(none)")}
          />
        </div>
      ) : null}
      {ui && bubbles.length ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-col items-center gap-1 px-3">
          {bubbles.slice(-3).map((b, i) => (
            <div key={i} className="max-w-[90%] rounded-lg border border-white/10 bg-black/75 px-3 py-1.5 text-sm text-white shadow-lg backdrop-blur">
              {b}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );

  if (!ui) return <div className="flex h-full w-full">{stage}</div>;

  return (
    <div className="flex h-full w-full flex-col text-content md:flex-row">
      <div className="flex min-h-[55vh] flex-1 p-2 md:min-h-0">{stage}</div>
      <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-t border-border bg-surface/90 p-3 text-xs md:w-[340px] md:border-l md:border-t-0">
        <div className="flex items-baseline justify-between">
          <b className="text-sm">Avatar lab</b>
          <span className="text-content-faint">{loaded ? `${loaded.name} · ${loaded.avatar.kind}` : "loading…"}</span>
        </div>
        <section className="flex flex-col gap-1">
          <span className="text-content-faint">Mood</span>
          <div className="flex flex-wrap gap-1">
            {MOODS.map((m) => (
              <button key={m} type="button" className={btn(mood === m)} onClick={() => setMood(m)} data-testid={`mood-${m}`}>
                {m}
              </button>
            ))}
          </div>
        </section>
        <section className="flex flex-col gap-1">
          <span className="text-content-faint">Emotion (react)</span>
          <div className="flex flex-wrap gap-1">
            {EMOTIONS.map((e) => (
              <button key={e} type="button" className={btn(react?.name === e)} onClick={() => fire(e)} data-testid={`react-${e}`}>
                {e}
              </button>
            ))}
          </div>
        </section>
        <section className="flex flex-col gap-1">
          <span className="text-content-faint">Voice</span>
          <div className="flex flex-wrap items-center gap-1">
            <button type="button" className={btn(sim)} onClick={() => setSim((s) => !s)} data-testid="sim">
              {sim ? "stop speaking" : "simulate speaking"}
            </button>
            <button type="button" className={btn(false)} onClick={() => say("안녕하세요, 저는 당신의 메이트예요.")}>
              browser TTS
            </button>
            <button
              type="button"
              className={btn(false)}
              onClick={() => {
                setSim(false);
                getMateAudioQueue().stop();
              }}
            >
              stop
            </button>
          </div>
          <div className="flex gap-1">
            <input
              className="min-w-0 flex-1 rounded-md border border-border-strong bg-surface-2 px-2 py-1"
              placeholder="audio URL (mp3/wav/ogg)"
              value={audioUrl}
              onChange={(e) => setAudioUrl(e.target.value)}
            />
            <button type="button" className={btn(false)} onClick={playAudio}>
              play
            </button>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded bg-surface-3">
              <div className="h-full bg-accent transition-[width] duration-75" style={{ width: `${Math.round(Math.min(1, level * 1.8) * 100)}%` }} />
            </div>
            <span className="w-28 truncate text-content-faint" data-testid="speaking">
              {speaking ? `● ${speaking}` : "silent"}
              {queue.pending ? ` +${queue.pending}` : ""}
              {queue.blocked ? " (tap to play)" : ""}
            </span>
          </div>
        </section>
        <section className="flex flex-col gap-1">
          <span className="text-content-faint">Streamed reply (tags → react, sentences → TTS)</span>
          <textarea
            className="h-24 rounded-md border border-border-strong bg-surface-2 p-2"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button type="button" className={btn(false)} onClick={() => stream(text)} data-testid="stream">
              stream it
            </button>
            <label className="flex items-center gap-1 text-content-dim">
              <input type="checkbox" checked={useTts} onChange={(e) => setUseTts(e.target.checked)} /> speak (browser TTS)
            </label>
          </div>
        </section>
        <section className="flex flex-col gap-1">
          <span className="text-content-faint">View</span>
          <div className="flex flex-wrap gap-1">
            {(["lg", "sm"] as const).map((s) => (
              <button key={s} type="button" className={btn(size === s)} onClick={() => setSize(s)}>
                size {s}
              </button>
            ))}
            {BGS.map((b) => (
              <button key={b} type="button" className={btn(bg === b)} onClick={() => setBg(b)}>
                {b}
              </button>
            ))}
          </div>
          {lastTap ? <span className="text-content-faint">last tap: {lastTap}</span> : null}
        </section>
      </aside>
    </div>
  );
}
