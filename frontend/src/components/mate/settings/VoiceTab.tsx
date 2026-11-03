import { useDevicePreferences, patchDevicePreferences } from "../../../stores/devicePreferences";
/**
 * Voice (this mate): how it speaks (TTS) and hears (STT). Only engines that work are offered — Off, the browser and
 * the providers Global settings has verified; the rest are listed disabled with a way to set them up. Voices and
 * models are fetched from the provider (ElevenLabs account voices + TTS models, OpenAI's catalogue, OmniVoice
 * profiles, a self-hosted server's /models), with previews of the unsaved choice.
 */
import { useEffect, useMemo, useState } from "react";
import {
  assetUrl,
  listModels,
  listVoices,
  speech,
  SpeechFallbackError,
  type Mate,
  type MateVoice,
  type ModelList,
  type SttEngine,
  type TtsEngine,
  type VoiceOption,
} from "../../../api/mates";
import { previewMateFlags } from "../../../mate/livePreview";
import { bcp47, type MateConversation } from "../../../mate/useMateConversation";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import { useT, type MsgKey } from "../../../i18n";
import { availability, playPreview, setPreviewVolume, speakPreview, stopPreview, STT_ENGINES, TTS_ENGINES, usable, usePreviewPlaying, type Availability, type EngineInfo } from "./engines";
import { Banner, ErrorLine, Field, LinkButton, SaveBar, SearchSelect, Section, Segmented, Toggle, useFollowSaved, useSaver, type PickOption } from "./ui";

type Tts = MateVoice["tts"];
type Stt = MateVoice["stt"];

const SAMPLE: Record<string, string> = {
  ko: "안녕하세요! 오늘도 같이 힘내 봐요.",
  en: "Hi there! Let's get things done today.",
  ja: "こんにちは!今日も一緒に頑張りましょう。",
  zh: "你好!今天也一起加油吧。",
  es: "¡Hola! Hagamos un gran trabajo hoy.",
  fr: "Bonjour ! On s'y met ensemble aujourd'hui ?",
  de: "Hallo! Lass uns heute gemeinsam loslegen.",
};

const LANGS: [string, string][] = [
  ["ko", "한국어"],
  ["en", "English"],
  ["ja", "日本語"],
  ["zh", "中文"],
  ["es", "Español"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["it", "Italiano"],
  ["pt", "Português"],
  ["ru", "Русский"],
  ["vi", "Tiếng Việt"],
  ["th", "ไทย"],
  ["id", "Bahasa Indonesia"],
  ["hi", "हिन्दी"],
  ["ar", "العربية"],
];
const langName = (code: string) => LANGS.find(([c]) => c === code.toLowerCase().split("-")[0])?.[1] ?? code;

/** sensible speed range per engine (what the provider accepts) */
const SPEED: Record<string, [number, number]> = {
  openai: [0.25, 4],
  elevenlabs: [0.7, 1.2],
  omnivoice: [0.5, 2],
  http: [0.5, 2],
  browser: [0.5, 2],
};

const ELEVEN_GROUP: Record<string, MsgKey> = {
  cloned: "mateSettings.voiceGrpYours",
  generated: "mateSettings.voiceGrpYours",
  professional: "mateSettings.voiceGrpLibrary",
  famous: "mateSettings.voiceGrpLibrary",
  high_quality: "mateSettings.voiceGrpLibrary",
  premade: "mateSettings.voiceGrpDefault",
};
const GROUP_ORDER: MsgKey[] = ["mateSettings.voiceGrpYours", "mateSettings.voiceGrpLibrary", "mateSettings.voiceGrpDefault", "mateSettings.voiceGrpOther"];

// fetched lists, kept while the app runs (switching mates / tabs doesn't refetch)
const cache = new Map<string, Promise<unknown>>();
function cached<T>(key: string, fetch: () => Promise<T>, fresh = false): Promise<T> {
  if (fresh || !cache.has(key)) {
    const p = fetch();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key) as Promise<T>;
}

function useFetched<T>(key: string | null, fetch: () => Promise<T>): { data: T | null; err: string | null; busy: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    setData(null);
    setErr(null);
    if (!key) return;
    let alive = true;
    setBusy(true);
    cached(key, fetch, n > 0)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr((e as Error).message))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [key, n]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, err, busy, reload: () => setN((x) => x + 1) };
}

function useBrowserVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const read = () => setVoices(speechSynthesis.getVoices());
    read();
    speechSynthesis.addEventListener?.("voiceschanged", read);
    return () => speechSynthesis.removeEventListener?.("voiceschanged", read);
  }, []);
  return voices;
}

export default function VoiceTab({ mate, conv, onTest }: { mate: Mate; conv: MateConversation; onTest?: () => void }) {
  const t = useT();
  const [v, setV] = useState<MateVoice>(mate.voice);
  const saver = useSaver();
  const providers = useMateStore((s) => s.providers);
  const providersError = useMateStore((s) => s.providersError);
  const dirty = JSON.stringify(v) !== JSON.stringify(mate.voice);
  const tts = (patch: Partial<Tts>) => setV((x) => ({ ...x, tts: { ...x.tts, ...patch } }));
  const stt = (patch: Partial<Stt>) => setV((x) => ({ ...x, stt: { ...x.stt, ...patch } }));
  const save = () => saver.run(() => { const {volume: _legacyVolume, ...voice} = v; return useMateStore.getState().patch(mate.id, { voice }); });
  useFollowSaved(mate.voice, dirty, () => setV(mate.voice));
  useEffect(() => () => stopPreview(), []);
  const volume = useDevicePreferences().volume;
  useEffect(() => { setPreviewVolume(volume); }, [volume]);
  // the realtime mic's unsaved toggles apply at once to a mic listening in any window (mate/livePreview)
  const sttAutoSend = !!v.stt.auto_send;
  const sttBargeIn = v.stt.barge_in !== false;
  const sttMergeFragments = v.stt.merge_fragments !== false;
  const sttContinuationGrace = v.stt.continuation_grace ?? 1.8;
  const sttIgnoreShort = !!v.stt.ignore_short_fragments;
  const sttFlagsDirty =
    sttAutoSend !== !!mate.voice.stt.auto_send ||
    sttBargeIn !== (mate.voice.stt.barge_in !== false) ||
    sttMergeFragments !== (mate.voice.stt.merge_fragments !== false) ||
    sttContinuationGrace !== (mate.voice.stt.continuation_grace ?? 1.8) ||
    sttIgnoreShort !== !!mate.voice.stt.ignore_short_fragments;
  useEffect(() => {
    previewMateFlags(
      mate.id,
      sttFlagsDirty
        ? {
            sttAutoSend,
            sttBargeIn,
            sttMergeFragments,
            sttContinuationGrace,
            sttIgnoreShort,
          }
        : null,
    );
  }, [
    mate.id,
    sttFlagsDirty,
    sttAutoSend,
    sttBargeIn,
    sttMergeFragments,
    sttContinuationGrace,
    sttIgnoreShort,
  ]);
  useEffect(() => () => previewMateFlags(mate.id, null), [mate.id]);

  const ttsAvail = (id: string) => availability(providers, "tts", id);
  const sttAvail = (id: string) => availability(providers, "stt", id);
  const savedTts = ttsAvail(mate.voice.tts.engine);
  const savedStt = sttAvail(mate.voice.stt.engine);

  const pickTts = (engine: TtsEngine) => {
    if (engine === v.tts.engine) return;
    const [lo, hi] = SPEED[engine] ?? [0.5, 2];
    // a voice / model of one engine means nothing to another
    tts({ engine, voice: "", model: "", profile: "", speed: Math.min(hi, Math.max(lo, v.tts.speed || 1)) });
  };

  const test = async () => {
    if (dirty && !(await saver.run(() => useMateStore.getState().patch(mate.id, { voice: v })))) return;
    onTest?.();
    conv.say(`[greet] ${SAMPLE[(mate.persona.language || "ko").slice(0, 2)] || SAMPLE.en}`);
  };

  return (
    <>
      {providersError && <Banner tone="error">{t("mateSettings.voiceProvidersErr", { error: providersError })}</Banner>}
      <Section title={t("mateSettings.voiceSpeaking")} hint={t("mateSettings.voiceSpeakingHint")}>
        {!usable(savedTts) && (
          <FallbackNote kind="tts" engine={mate.voice.tts.engine} avail={savedTts} />
        )}
        <EnginePicker
          kind="tts"
          engines={TTS_ENGINES}
          value={v.tts.engine}
          avail={ttsAvail}
          onChange={pickTts}
          testId="mate-tts-engine"
        />
        {v.tts.engine !== "off" && <TtsDetails key={v.tts.engine} mate={mate} tts={v.tts} set={tts} ready={ttsAvail(v.tts.engine).state === "ready"} />}
        <p className="text-xs text-content-faint">{t("screen.deviceVolume")}</p>
        <VolumeField value={volume} engine={v.tts.engine} onChange={(x) => { void patchDevicePreferences({ volume: x }); }} />
        <Toggle
          on={v.auto_read}
          onChange={(on) => setV((x) => ({ ...x, auto_read: on }))}
          label={t("mateSettings.voiceReadAloud")}
          hint={t("mateSettings.voiceReadAloudHint")}
          disabled={v.tts.engine === "off"}
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <button className="btn-soft" onClick={test} disabled={v.tts.engine === "off" || saver.busy} data-testid="mate-voice-test" title={t("mateSettings.voiceTestTitle")}>
            <Icon name="volume" size={14} /> {dirty ? t("mateSettings.voiceSaveHello") : t("mateSettings.voiceSayHello")}
          </button>
          <button className="btn-ghost" onClick={conv.stopVoice}>
            <Icon name="stop" size={12} /> {t("common.stop")}
          </button>
          {conv.voiceError && <span className="min-w-0 flex-1 text-[12px] text-danger break-words">{conv.voiceError}</span>}
        </div>
      </Section>

      <Section title={t("mateSettings.voiceListening")} hint={t("mateSettings.voiceListeningHint")}>
        {!usable(savedStt) && <FallbackNote kind="stt" engine={mate.voice.stt.engine} avail={savedStt} />}
        <EnginePicker kind="stt" engines={STT_ENGINES} value={v.stt.engine} avail={sttAvail} onChange={(engine: SttEngine) => stt({ engine, model: "" })} testId="mate-stt-engine" />
        {v.stt.engine !== "off" && <SttDetails key={v.stt.engine} mate={mate} stt={v.stt} set={stt} ready={sttAvail(v.stt.engine).state === "ready"} />}
      </Section>
      <SaveBar saver={saver} onSave={save} dirty={dirty} onReset={() => setV(mate.voice)} />
    </>
  );
}

/** 0–300 % in 5 % steps, 100 % marked; the browser voice stops at 100 % */
function VolumeField({ value, engine, onChange }: { value: number; engine: TtsEngine; onChange: (v: number) => void }) {
  const t = useT();
  const pct = Math.round(value * 100);
  const capped = engine === "browser" && pct > 100;
  return (
    <div className="space-y-1.5 rounded-lg border border-border/70 bg-surface/40 p-3" data-testid="mate-volume">
      <div className="flex items-center gap-2">
        <Icon name="volume" size={14} className="text-content-faint" />
        <span className="text-[12px] font-medium text-content-dim">{t("mateSettings.voiceVolume")}</span>
        <span className={`ml-auto font-mono text-[12.5px] tabular-nums ${pct > 100 ? "text-warning" : "text-content"}`} data-testid="mate-volume-value">
          {pct} %
        </span>
        {pct !== 100 && (
          <button type="button" className="btn-ghost !px-2 !py-0.5 text-[11.5px]" onClick={() => onChange(1)} data-testid="mate-volume-reset">
            100 %
          </button>
        )}
      </div>
      <div className="relative px-0.5">
        <input
          type="range"
          min={0}
          max={300}
          step={5}
          value={pct}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
          className="relative z-[1] w-full accent-accent"
          aria-label={t("mateSettings.voiceVolume")}
          aria-valuetext={t("mateSettings.voicePercent", { n: pct })}
          list="mate-volume-marks"
          data-testid="mate-volume-slider"
        />
        <datalist id="mate-volume-marks">
          <option value="0" />
          <option value="100" />
          <option value="200" />
          <option value="300" />
        </datalist>
        <div className="relative mt-0.5 h-3.5 text-[10px] text-content-faint" aria-hidden>
          <span className="absolute left-0">0</span>
          {/* 100 %: a third of the way (the thumb's half-width aside) */}
          <span className="absolute -translate-x-1/2 font-semibold text-content-dim" style={{ left: "33.33%" }}>
            ▲ 100 %
          </span>
          <span className="absolute -translate-x-1/2" style={{ left: "66.67%" }}>
            200 %
          </span>
          <span className="absolute right-0">300 %</span>
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-content-faint">
        {capped ? (
          <span className="text-warning" data-testid="mate-volume-browser-note">
            {t("mateSettings.voiceBrowserCap")}
          </span>
        ) : engine === "browser" ? (
          t("mateSettings.voiceBrowserRange")
        ) : (
          t("mateSettings.voiceAmplified")
        )}
      </p>
    </div>
  );
}

const ENGINE_LABEL = (kind: "tts" | "stt", id: string): MsgKey | null => (kind === "tts" ? TTS_ENGINES : STT_ENGINES).find((e) => e.id === id)?.label ?? null;

/** the saved engine doesn't work (any more): say what happens instead */
function FallbackNote({ kind, engine, avail }: { kind: "tts" | "stt"; engine: string; avail: Availability }) {
  const t = useT();
  const key = ENGINE_LABEL(kind, engine);
  const label = key ? t(key) : engine;
  const why =
    avail.state === "missing"
      ? t("mateSettings.fbMissing")
      : avail.state === "error"
        ? t("mateSettings.fbError", { error: avail.error })
        : avail.state === "unsupported"
          ? t("mateSettings.fbUnsupported", { why: avail.why })
          : "";
  const what =
    kind === "stt"
      ? t("mateSettings.fbSttWhat")
      : avail.state === "missing"
        ? t("mateSettings.fbTtsMissingWhat")
        : t("mateSettings.fbTtsFailWhat");
  return (
    <Banner
      tone="warn"
      testId={`mate-${kind}-fallback`}
      action={
        avail.state !== "unsupported" ? (
          <button className="btn-soft !px-2.5 !py-1 text-[12px]" onClick={() => useMateStore.getState().openGlobal("voice")}>
            {t("mateSettings.voiceSetUp")}
          </button>
        ) : undefined
      }
    >
      {t.rich("mateSettings.fbIntro", { b: (s) => <b>{s}</b>, engine: label, why, what })}
    </Banner>
  );
}

function EnginePicker<T extends string>({ kind, engines, value, avail, onChange, testId }: { kind: "tts" | "stt"; engines: EngineInfo<T>[]; value: T; avail: (id: string) => Availability; onChange: (id: T) => void; testId: string }) {
  const t = useT();
  return (
    <div className="grid gap-1.5 sm:grid-cols-2" role="radiogroup" data-testid={testId}>
      {engines.map((e) => {
        const a = avail(e.id);
        const ok = usable(a);
        const selected = value === e.id;
        return (
          <div
            key={e.id}
            role="radio"
            aria-checked={selected}
            aria-disabled={!ok}
            tabIndex={ok ? 0 : -1}
            onClick={() => ok && onChange(e.id)}
            onKeyDown={(ev) => ok && (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), onChange(e.id))}
            data-engine={e.id}
            data-state={a.state}
            className={`rounded-lg border px-3 py-2 transition ${
              selected ? "border-accent/60 bg-accent-soft" : ok ? "cursor-pointer border-border hover:border-border-strong hover:bg-surface-3/40" : "border-border/60 bg-surface/30"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border ${selected ? "border-accent" : "border-border-strong"}`}>
                {selected && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
              </span>
              <span className={`min-w-0 flex-1 truncate text-[13px] font-medium ${ok ? "text-content" : "text-content-faint"}`}>{t(e.label)}</span>
              {e.provider && a.state === "ready" && <Icon name="check" size={12} className="shrink-0 text-success" />}
              {a.state === "checking" && <Icon name="spinner" size={12} spin className="shrink-0 text-content-faint" />}
            </div>
            <div className="mt-0.5 pl-[22px] text-[11px] leading-snug text-content-faint">
              {a.state === "missing" ? (
                <>
                  {t("mateSettings.voiceNotSetUp")} ·{" "}
                  <LinkButton onClick={() => useMateStore.getState().openGlobal("voice")} testId={`mate-${kind}-setup-${e.id}`}>
                    {t("mateSettings.voiceSetUpGlobal")}
                  </LinkButton>
                </>
              ) : a.state === "error" ? (
                <>
                  <span className="text-danger">{t("mateSettings.voiceNotWorking")}</span> ·{" "}
                  <LinkButton onClick={() => useMateStore.getState().openGlobal("voice")}>{t("mateSettings.voiceFixGlobal")}</LinkButton>
                </>
              ) : a.state === "unsupported" ? (
                a.why
              ) : (
                t(e.hint)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PreviewButton({ id, label, onPlay, disabled, testId }: { id: string; label?: string; onPlay: () => Promise<void> | void; disabled?: boolean; testId?: string }) {
  const t = useT();
  label ??= t("mateSettings.voicePreview");
  const playing = usePreviewPlaying();
  const [busy, setBusy] = useState(false);
  const on = playing === id;
  return (
    <button
      type="button"
      className={`btn-ghost shrink-0 border border-border !px-2.5 !py-1.5 text-[12px] ${on ? "!border-accent/60 !text-accent" : ""}`}
      disabled={disabled || busy}
      onClick={async () => {
        if (on) return stopPreview();
        setBusy(true);
        try {
          await onPlay();
        } finally {
          setBusy(false);
        }
      }}
      data-testid={testId}
      title={on ? t("common.stop") : label}
    >
      {busy ? <Icon name="spinner" size={12} spin /> : <Icon name={on ? "stop" : "play"} size={12} />}
      {label && <span>{on ? t("common.stop") : label}</span>}
    </button>
  );
}

/** a list row's play button (ElevenLabs preview URL) */
function RowPreview({ id, url }: { id: string; url: string }) {
  const t = useT();
  const playing = usePreviewPlaying();
  const on = playing === id;
  return (
    <button
      type="button"
      className={`grid h-7 w-7 place-items-center rounded-md border ${on ? "border-accent/60 text-accent" : "border-border text-content-dim hover:text-content"}`}
      onClick={() => (on ? stopPreview() : void playPreview(id, url).catch(() => {}))}
      aria-label={on ? t("mateSettings.voiceStopPreview") : t("mateSettings.voicePlayPreview")}
      title={t("mateSettings.voicePlayPreview")}
    >
      <Icon name={on ? "stop" : "play"} size={11} />
    </button>
  );
}

function LanguageField({ value, onChange, mate, extra, hint }: { value: string; onChange: (v: string) => void; mate: Mate; extra?: string[]; hint?: string }) {
  const t = useT();
  const opts: PickOption[] = [
    ...LANGS.map(([c, n]) => ({ value: c, label: n, sub: c, group: t("mateSettings.voiceLangCommon") })),
    ...(extra ?? []).filter((x) => !LANGS.some(([c, n]) => c === x || n.toLowerCase() === x.toLowerCase())).map((x) => ({ value: x, label: x, group: t("mateSettings.voiceLangServer") })),
  ];
  return (
    <Field label={t("mateSettings.voiceLanguage")} hint={hint ?? t("mateSettings.voiceLanguageHint")} as="div">
      <SearchSelect value={value} options={opts} onChange={onChange} noneLabel={t("mateSettings.voiceSameAsReplies", { lang: langName(mate.persona.language || "ko") })} allowCustom testId="mate-voice-language" />
    </Field>
  );
}

function TtsDetails({ mate, tts, set, ready }: { mate: Mate; tts: Tts; set: (p: Partial<Tts>) => void; ready: boolean }) {
  const t = useT();
  const engine = tts.engine;
  const lang = (tts.language || mate.persona.language || "ko").toLowerCase();
  const sample = SAMPLE[lang.slice(0, 2)] || SAMPLE.en;
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [lo, hi] = SPEED[engine] ?? [0.5, 2];

  const server = engine !== "browser";
  const voices = useFetched<VoiceOption[]>(ready && server && engine !== "http" ? `voices:${engine}` : null, () => listVoices(engine).then((r) => r.voices));
  const models = useFetched<ModelList>(ready && server ? `models:${engine}:tts` : null, () => listModels(engine, "tts"));

  const previewKey = `tts:${engine}:${tts.voice}:${tts.profile}:${tts.model}:${tts.speed}:${tts.instruct}:${tts.language}`;
  const synth = async () => {
    setPreviewErr(null);
    try {
      const { ref: _r, ref_text: _t, ...override } = tts;
      const blob = await speech(mate.id, sample, "joy", undefined, override);
      if (blob) await playPreview(previewKey, blob);
    } catch (e) {
      setPreviewErr(e instanceof SpeechFallbackError ? e.message : t("mateSettings.voicePreviewFailed", { error: (e as Error).message }));
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-surface/40 p-3" data-testid={`mate-tts-details-${engine}`}>
      {engine === "browser" && <BrowserVoice mate={mate} tts={tts} set={set} sample={sample} />}

      {engine === "openai" && (
        <>
          <Field label={t("mateSettings.voiceModel")} as="div">
            <SearchSelect
              value={tts.model}
              onChange={(model) => set({ model })}
              options={(models.data?.models ?? []).map((m) => ({ value: m.id, label: m.name, sub: m.description ?? m.id }))}
              noneLabel={t("mateSettings.voiceDefaultX", { x: models.data?.default || "gpt-4o-mini-tts" })}
              loading={models.busy}
              testId="mate-tts-model"
            />
          </Field>
          <VoicePicker
            label={t("mateSettings.voiceVoice")}
            value={tts.voice}
            onChange={(voice) => set({ voice })}
            noneLabel={t("mateSettings.voiceDefaultX", { x: "Alloy" })}
            voices={voices}
            toOption={(x) => {
              const model = tts.model || models.data?.default || "gpt-4o-mini-tts";
              const can = !x.models || x.models.includes(model);
              return { value: x.id, label: x.name, sub: can ? x.description : `${x.description ?? ""} · ${t("mateSettings.voiceOnlyMini")}`, disabled: !can };
            }}
          />
          {tts.voice && voices.data?.find((x) => x.id === tts.voice)?.models?.includes(tts.model || "gpt-4o-mini-tts") === false && (
            <p className="text-[12px] text-warning">{t("mateSettings.voiceNotOnModel", { model: tts.model })}</p>
          )}
        </>
      )}

      {engine === "elevenlabs" && (
        <>
          <VoicePicker
            label={t("mateSettings.voiceVoice")}
            value={tts.voice}
            onChange={(voice) => set({ voice })}
            voices={voices}
            noneLabel={t("mateSettings.voiceChoose")}
            sort
            toOption={(x) => {
              const l = x.labels ?? {};
              const bits = [l.gender, l.age, l.accent, l.use_case || l["use case"], l.descriptive || l.description].filter(Boolean);
              const langs = x.languages?.length ? x.languages.join(", ") : x.language;
              return {
                value: x.id,
                label: x.name,
                sub: [bits.join(" · "), langs].filter(Boolean).join(" — ") || x.description,
                group: t(ELEVEN_GROUP[x.category ?? ""] ?? "mateSettings.voiceGrpOther"),
                badges: x.category && x.category !== "premade" ? [x.category] : undefined,
                keywords: `${Object.values(l).join(" ")} ${x.description ?? ""} ${(x.languages ?? []).join(" ")}`,
              };
            }}
            right={(o) => {
              const x = voices.data?.find((y) => y.id === o.value);
              const url = x?.previews?.[lang.slice(0, 2)] || x?.preview_url;
              return url ? <RowPreview id={`el:${o.value}`} url={url} /> : null;
            }}
            required
          />
          <Field label={t("mateSettings.voiceModel")} as="div">
            <SearchSelect
              value={tts.model}
              onChange={(model) => set({ model })}
              options={(models.data?.models ?? []).map((m) => ({
                value: m.id,
                label: m.name,
                sub: [m.description?.split(/(?<=\.)\s/)[0], m.languages?.length ? t("mateSettings.voiceNLanguages", { count: m.languages.length }) : ""].filter(Boolean).join(" · "),
                keywords: (m.languages ?? []).join(" "),
              }))}
              noneLabel={t("mateSettings.voiceDefaultX", { x: models.data?.models.find((m) => m.id === models.data?.default)?.name || "Multilingual v2" })}
              loading={models.busy}
              testId="mate-tts-model"
            />
            <ErrorLine text={models.err} />
          </Field>
          {(() => {
            const m = models.data?.models.find((x) => x.id === (tts.model || models.data?.default));
            const code = lang.slice(0, 2);
            return m?.languages?.length && !m.languages.some((x) => x.toLowerCase().startsWith(code)) ? (
              <p className="text-[12px] text-warning">{t("mateSettings.voiceModelNoLang", { model: m.name, lang: langName(code) })}</p>
            ) : null;
          })()}
        </>
      )}

      {engine === "omnivoice" && <OmniVoice mate={mate} tts={tts} set={set} voices={voices} />}

      {engine === "http" && (
        <>
          <Field label={t("mateSettings.voiceModel")} as="div" hint={models.data && !models.data.models.length ? t("mateSettings.voiceNoModelsTts") : undefined}>
            <SearchSelect
              value={tts.model}
              onChange={(model) => set({ model })}
              options={(models.data?.models ?? []).map((m) => ({ value: m.id, label: m.name }))}
              noneLabel={t("mateSettings.voiceDefaultX", { x: models.data?.default || "tts-1" })}
              allowCustom
              loading={models.busy}
              testId="mate-tts-model"
            />
            <ErrorLine text={models.err} />
          </Field>
          <Field label={t("mateSettings.voiceVoice")} hint={t("mateSettings.voiceHttpVoiceHint")}>
            <input className="field" value={tts.voice} onChange={(e) => set({ voice: e.target.value })} placeholder={t("mateSettings.voiceDefaultPh")} data-testid="mate-tts-voice-text" />
          </Field>
        </>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("mateSettings.voiceSpeed", { x: tts.speed.toFixed(2) })} hint={engine === "elevenlabs" ? t("mateSettings.voiceElevenSpeed") : undefined}>
          <input
            type="range"
            min={lo}
            max={hi}
            step={0.05}
            value={Math.min(hi, Math.max(lo, tts.speed))}
            onChange={(e) => set({ speed: Number(e.target.value) })}
            className="w-full accent-accent"
            data-testid="mate-tts-speed"
          />
        </Field>
        <LanguageField
          value={tts.language}
          onChange={(language) => set({ language })}
          mate={mate}
          extra={engine === "omnivoice" ? models.data?.languages : undefined}
          hint={engine === "elevenlabs" ? t("mateSettings.voiceElevenLangHint") : undefined}
        />
      </div>

      {engine !== "browser" && (
        <div className="flex flex-wrap items-center gap-2">
          <PreviewButton id={previewKey} onPlay={synth} disabled={engine === "elevenlabs" && !tts.voice} testId="mate-tts-preview" />
          <span className="min-w-0 flex-1 text-[11.5px] text-content-faint">{t("mateSettings.voiceSampleNote", { sample })}</span>
          {previewErr && <p className="w-full text-[12px] text-danger break-words">{previewErr}</p>}
        </div>
      )}
    </div>
  );
}

function VoicePicker({
  label,
  value,
  onChange,
  voices,
  toOption,
  right,
  noneLabel,
  sort,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  voices: ReturnType<typeof useFetched<VoiceOption[]>>;
  toOption: (x: VoiceOption) => PickOption;
  right?: (o: PickOption) => React.ReactNode;
  noneLabel?: string;
  sort?: boolean;
  required?: boolean;
}) {
  const t = useT();
  const options = useMemo(() => {
    const xs = (voices.data ?? []).map(toOption);
    const order = GROUP_ORDER.map((k) => t(k));
    const rank = (g?: string) => order.indexOf(g ?? order[order.length - 1]);
    if (sort) xs.sort((a, b) => rank(a.group) - rank(b.group) || a.label.localeCompare(b.label));
    return xs;
  }, [voices.data, toOption, sort, t]);
  const missing = value && voices.data && !voices.data.some((x) => x.id === value);
  return (
    <Field
      label={
        <span className="flex items-center gap-2">
          {label}
          {voices.data && <span className="text-[10.5px] font-normal text-content-faint">{t("mateSettings.voiceNAvailable", { count: voices.data.length })}</span>}
          <button type="button" className="ml-auto text-content-faint hover:text-content" onClick={voices.reload} title={t("mateSettings.voiceReloadList")} aria-label={t("mateSettings.voiceReloadList")}>
            <Icon name="refresh" size={12} spin={voices.busy} />
          </button>
        </span>
      }
      as="div"
    >
      <SearchSelect
        value={value}
        options={options}
        onChange={onChange}
        right={right}
        loading={voices.busy}
        noneLabel={required ? undefined : noneLabel}
        placeholder={noneLabel}
        testId="mate-tts-voice"
      />
      <ErrorLine text={voices.err} />
      {missing && <p className="mt-1 text-[12px] text-warning">{t("mateSettings.voiceGone", { value })}</p>}
      {required && !value && voices.data && <p className="mt-1 text-[12px] text-warning">{t("mateSettings.voiceRequired")}</p>}
    </Field>
  );
}

function BrowserVoice({ mate, tts, set, sample }: { mate: Mate; tts: Tts; set: (p: Partial<Tts>) => void; sample: string }) {
  const t = useT();
  const all = useBrowserVoices();
  const lang = bcp47(tts.language || mate.persona.language).toLowerCase();
  const base = lang.split("-")[0];
  const options: PickOption[] = useMemo(() => {
    const mine = t("mateSettings.voiceForLang", { lang: langName(base) });
    return [...all]
      .map((x) => ({
        value: x.voiceURI,
        label: x.name,
        sub: `${x.lang}${x.localService ? "" : ` · ${t("mateSettings.voiceOnline")}`}`,
        group: x.lang.toLowerCase().startsWith(base) ? mine : t("mateSettings.voiceOtherLangs"),
        keywords: x.lang,
      }))
      .sort((a, b) => Number(b.group === mine) - Number(a.group === mine) || a.label.localeCompare(b.label));
  }, [all, base, t]);
  return (
    <>
      <Field label={t("mateSettings.voiceVoice")} as="div" hint={all.length ? t("mateSettings.voiceDeviceVoices", { count: all.length }) : t("mateSettings.voiceNoDeviceVoices")}>
        <SearchSelect value={tts.voice} options={options} onChange={(voice) => set({ voice })} noneLabel={t("mateSettings.voiceDefaultFor", { lang: langName(base) })} testId="mate-tts-voice" />
      </Field>
      <div className="flex items-center gap-2">
        <PreviewButton
          id={`browser:${tts.voice}:${tts.speed}:${lang}`}
          onPlay={() => speakPreview(`browser:${tts.voice}:${tts.speed}:${lang}`, sample, { voice: tts.voice || undefined, lang, rate: tts.speed })}
          disabled={typeof speechSynthesis === "undefined"}
          testId="mate-tts-preview"
        />
        <span className="text-[11.5px] text-content-faint">“{sample}”</span>
      </div>
    </>
  );
}

const INSTRUCT_EXAMPLES = ["female, young adult, high pitch", "male, middle-aged, low pitch, calm", "female, warm, soft, korean accent"];

function OmniVoice({ mate, tts, set, voices }: { mate: Mate; tts: Tts; set: (p: Partial<Tts>) => void; voices: ReturnType<typeof useFetched<VoiceOption[]>> }) {
  const t = useT();
  const current = tts.profile || tts.voice;
  const [mode, setMode] = useState<"profile" | "design">(current || !tts.instruct ? "profile" : "design");
  return (
    <>
      <Field label={t("mateSettings.voiceVoice")} as="div">
        <Segmented
          value={mode}
          onChange={(m) => {
            setMode(m);
            if (m === "design") set({ voice: "", profile: "" });
          }}
          options={[
            { id: "profile", label: t("mateSettings.omniProfile"), title: t("mateSettings.omniProfileTitle") },
            { id: "design", label: t("mateSettings.omniDesign"), title: t("mateSettings.omniDesignTitle") },
          ]}
          testId="mate-omni-mode"
        />
      </Field>
      {mode === "profile" ? (
        <VoicePicker
          label={t("mateSettings.omniProfileLabel")}
          value={current}
          onChange={(id) => set({ voice: id, profile: "" })}
          voices={voices}
          noneLabel={t("mateSettings.omniChooseProfile")}
          toOption={(x) => ({
            value: x.id,
            label: x.name,
            sub: [x.language, x.emotions?.length ? t("mateSettings.omniEmotions", { list: x.emotions.join(", ") }) : t("mateSettings.omniNoClips")].filter(Boolean).join(" · "),
            badges: x.category === "template" ? [t("mateSettings.omniTemplate")] : undefined,
            keywords: (x.emotions ?? []).join(" "),
          })}
          required
        />
      ) : (
        <Field label={t("mateSettings.omniDesign")} hint={t("mateSettings.omniDesignHint")} as="div">
          {/* OmniVoice reads English speaker attributes: the example stays English */}
          <input className="field" value={tts.instruct ?? ""} onChange={(e) => set({ instruct: e.target.value })} placeholder="female, young adult, low pitch" data-testid="mate-tts-instruct" />{/* i18n-ignore */}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {INSTRUCT_EXAMPLES.map((x) => (
              <button key={x} type="button" className="pill border border-border text-content-faint hover:text-content" onClick={() => set({ instruct: x })}>
                {x}
              </button>
            ))}
          </div>
        </Field>
      )}
      {!!tts.ref && (
        <Field label={t("mateSettings.omniRefClip")} hint={t("mateSettings.omniRefClipHint")} as="div">
          <div className="space-y-1.5 rounded-lg border border-border bg-surface/60 p-2" data-testid="mate-tts-ref">
            <audio controls preload="none" src={assetUrl(mate.id, tts.ref)} className="h-8 w-full" />
            <div className="font-mono text-[11px] text-content-faint">{tts.ref}</div>
            <textarea className="field resize-y text-[12.5px]" rows={2} value={tts.ref_text ?? ""} onChange={(e) => set({ ref_text: e.target.value })} placeholder={t("mateSettings.omniClipSays")} />
          </div>
        </Field>
      )}
    </>
  );
}

function SttDetails({ mate, stt, set, ready }: { mate: Mate; stt: Stt; set: (p: Partial<Stt>) => void; ready: boolean }) {
  const t = useT();
  const engine = stt.engine;
  const models = useFetched<ModelList>(ready && (engine === "openai" || engine === "whisper") ? `models:${engine}:stt` : null, () => listModels(engine, "stt"));
  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-surface/40 p-3" data-testid={`mate-stt-details-${engine}`}>
      {(engine === "openai" || engine === "whisper") && (
        <Field label={t("mateSettings.voiceModel")} as="div" hint={engine === "whisper" && models.data && !models.data.models.length ? t("mateSettings.voiceNoModelsStt") : undefined}>
          <SearchSelect
            value={stt.model}
            onChange={(model) => set({ model })}
            options={(models.data?.models ?? []).map((m) => ({ value: m.id, label: m.name, sub: m.description ?? (m.id !== m.name ? m.id : undefined) }))}
            noneLabel={t("mateSettings.voiceDefaultX", { x: models.data?.default || (engine === "openai" ? "gpt-4o-mini-transcribe" : t("mateSettings.voiceServerFirstModel")) })}
            allowCustom={engine === "whisper"}
            loading={models.busy}
            testId="mate-stt-model"
          />
          <ErrorLine text={models.err} />
        </Field>
      )}
      {engine === "browser" && <p className="text-[12px] text-content-faint">{t("mateSettings.voiceBrowserStt")}</p>}
      {engine === "elevenlabs" && (
        <p className="text-[12px] leading-relaxed text-content-faint" data-testid="mate-stt-eleven-about">
          {t("mateSettings.sttElevenAbout")}
        </p>
      )}
      <LanguageField value={stt.language} onChange={(language) => set({ language })} mate={mate} hint={t("mateSettings.voiceSttLangHint")} />
      {engine !== "off" && <TranscriptOptions stt={stt} set={set} />}
      {engine === "elevenlabs" && <RealtimeOptions stt={stt} set={set} name={mate.name} />}
    </div>
  );
}

/** the realtime mic: auto-send (+ the pause that ends an utterance), barge-in */
function RealtimeOptions({ stt, set, name }: { stt: Stt; set: (p: Partial<Stt>) => void; name: string }) {
  const t = useT();
  const silence = stt.silence ?? 1.2;
  return (
    <div className="space-y-3 border-t border-border/60 pt-3" data-testid="mate-stt-realtime">
      <Field label={t("mateSettings.sttPause", { x: silence.toFixed(1) })} hint={t("mateSettings.sttPauseHint")}>
        <input
          type="range"
          min={0.5}
          max={3}
          step={0.1}
          value={silence}
          onChange={(e) => set({ silence: Number(e.target.value) })}
          className="w-full accent-accent"
          data-testid="mate-stt-silence"
        />
      </Field>
      <Toggle
        on={stt.barge_in !== false}
        onChange={(on) => set({ barge_in: on })}
        label={t("mateSettings.sttBargeIn")}
        hint={stt.barge_in !== false ? t("mateSettings.sttBargeInOnHint", { name }) : t("mateSettings.sttBargeInOffHint", { name })}
        testId="mate-stt-bargein"
      />
      <p className="text-[11px] leading-relaxed text-content-faint">{t("mateSettings.sttElevenCost")}</p>
    </div>
  );
}

/** One message finalizer for every recognizer; VAD below remains a recognizer setting. */
function TranscriptOptions({
  stt,
  set,
}: {
  stt: Stt;
  set: (p: Partial<Stt>) => void;
}) {
  const t = useT(),
    grace = stt.continuation_grace ?? 1.8;
  return (
    <div
      className="space-y-3 border-t border-border/60 pt-3"
      data-testid="mate-stt-draft-options"
    >
      <Toggle
        on={!!stt.auto_send}
        onChange={(on) => set({ auto_send: on })}
        label={t("mateSettings.sttAutoSend")}
        hint={t("mateSettings.sttAutoSendHint")}
        testId="mate-stt-autosend"
      />
      <Toggle
        on={stt.merge_fragments !== false}
        onChange={(on) => set({ merge_fragments: on })}
        label={t("mateSettings.sttMerge")}
        hint={t("mateSettings.sttMergeHint")}
        testId="mate-stt-merge"
      />
      {stt.merge_fragments !== false && (
        <Field
          label={t("mateSettings.sttGrace", { x: grace.toFixed(1) })}
          hint={t("mateSettings.sttGraceHint")}
        >
          <input
            type="range"
            min={0.5}
            max={5}
            step={0.1}
            value={grace}
            onChange={(e) =>
              set({ continuation_grace: Number(e.target.value) })
            }
            className="w-full accent-accent"
            data-testid="mate-stt-grace"
            aria-label={t("mateSettings.sttGrace", { x: grace.toFixed(1) })}
          />
        </Field>
      )}
      <Toggle
        on={!!stt.ignore_short_fragments}
        onChange={(on) => set({ ignore_short_fragments: on })}
        label={t("mateSettings.sttIgnoreShort")}
        hint={t("mateSettings.sttIgnoreShortHint")}
        testId="mate-stt-ignore-short"
      />
    </div>
  );
}
