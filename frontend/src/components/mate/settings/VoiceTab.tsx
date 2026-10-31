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
import { bcp47, type MateConversation } from "../../../mate/useMateConversation";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import { availability, playPreview, speakPreview, stopPreview, STT_ENGINES, TTS_ENGINES, usable, usePreviewPlaying, type Availability, type EngineInfo } from "./engines";
import { Banner, ErrorLine, Field, LinkButton, SaveBar, SearchSelect, Section, Segmented, Toggle, useSaver, type PickOption } from "./ui";

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

const ELEVEN_GROUP: Record<string, string> = {
  cloned: "Your voices",
  generated: "Your voices",
  professional: "Voice Library & professional",
  famous: "Voice Library & professional",
  high_quality: "Voice Library & professional",
  premade: "ElevenLabs default voices",
};
const GROUP_ORDER = ["Your voices", "Voice Library & professional", "ElevenLabs default voices", "Other"];

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

export default function VoiceTab({ mate, conv }: { mate: Mate; conv: MateConversation }) {
  const [v, setV] = useState<MateVoice>(mate.voice);
  const saver = useSaver();
  const providers = useMateStore((s) => s.providers);
  const providersError = useMateStore((s) => s.providersError);
  const dirty = JSON.stringify(v) !== JSON.stringify(mate.voice);
  const tts = (patch: Partial<Tts>) => setV((x) => ({ ...x, tts: { ...x.tts, ...patch } }));
  const stt = (patch: Partial<Stt>) => setV((x) => ({ ...x, stt: { ...x.stt, ...patch } }));
  const save = () => saver.run(() => useMateStore.getState().patch(mate.id, { voice: v }));
  useEffect(() => () => stopPreview(), []);

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
    conv.say(`[greet] ${SAMPLE[(mate.persona.language || "ko").slice(0, 2)] || SAMPLE.en}`);
  };

  return (
    <>
      {providersError && <Banner tone="error">Couldn't read Global settings' voice services: {providersError}</Banner>}
      <Section title="Speaking" hint="How this mate's replies sound.">
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
        <Toggle
          on={v.auto_read}
          onChange={(on) => setV((x) => ({ ...x, auto_read: on }))}
          label="Read replies aloud"
          hint="Sentence by sentence while the reply is written. The speaker button by the message box mutes this device."
          disabled={v.tts.engine === "off"}
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <button className="btn-soft" onClick={test} disabled={v.tts.engine === "off" || saver.busy} data-testid="mate-voice-test" title="Saves, then the mate says hello with its avatar">
            <Icon name="volume" size={14} /> {dirty ? "Save & say hello" : "Say hello"}
          </button>
          <button className="btn-ghost" onClick={conv.stopVoice}>
            <Icon name="stop" size={12} /> Stop
          </button>
          {conv.voiceError && <span className="min-w-0 flex-1 text-[12px] text-danger break-words">{conv.voiceError}</span>}
        </div>
      </Section>

      <Section title="Listening (mic)" hint="How the mic button turns your speech into text.">
        {!usable(savedStt) && <FallbackNote kind="stt" engine={mate.voice.stt.engine} avail={savedStt} />}
        <EnginePicker kind="stt" engines={STT_ENGINES} value={v.stt.engine} avail={sttAvail} onChange={(engine: SttEngine) => stt({ engine, model: "" })} testId="mate-stt-engine" />
        {v.stt.engine !== "off" && <SttDetails key={v.stt.engine} mate={mate} stt={v.stt} set={stt} ready={sttAvail(v.stt.engine).state === "ready"} />}
      </Section>
      <SaveBar saver={saver} onSave={save} dirty={dirty} onReset={() => setV(mate.voice)} />
    </>
  );
}

const ENGINE_LABEL = (kind: "tts" | "stt", id: string) => (kind === "tts" ? TTS_ENGINES : STT_ENGINES).find((e) => e.id === id)?.label ?? id;

/** the saved engine doesn't work (any more): say what happens instead */
function FallbackNote({ kind, engine, avail }: { kind: "tts" | "stt"; engine: string; avail: Availability }) {
  const label = ENGINE_LABEL(kind, engine);
  const why =
    avail.state === "missing"
      ? "it isn't set up in Global settings"
      : avail.state === "error"
        ? `it fails its check in Global settings (${avail.error})`
        : avail.state === "unsupported"
          ? `it's ${avail.why.toLowerCase()}`
          : "";
  const what =
    kind === "stt"
      ? " — the mic can't transcribe with it. Pick another engine or fix it."
      : avail.state === "missing"
        ? " — until it is, this mate speaks with the browser voice."
        : " — speaking fails until it works again (pick another engine, or fix it).";
  return (
    <Banner
      tone="warn"
      testId={`mate-${kind}-fallback`}
      action={
        avail.state !== "unsupported" ? (
          <button className="btn-soft !px-2.5 !py-1 text-[12px]" onClick={() => useMateStore.getState().openGlobal("voice")}>
            Set up
          </button>
        ) : undefined
      }
    >
      This mate is set to <b>{label}</b>, but {why}
      {what}
    </Banner>
  );
}

function EnginePicker<T extends string>({ kind, engines, value, avail, onChange, testId }: { kind: "tts" | "stt"; engines: EngineInfo<T>[]; value: T; avail: (id: string) => Availability; onChange: (id: T) => void; testId: string }) {
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
              <span className={`min-w-0 flex-1 truncate text-[13px] font-medium ${ok ? "text-content" : "text-content-faint"}`}>{e.label}</span>
              {e.provider && a.state === "ready" && <Icon name="check" size={12} className="shrink-0 text-success" />}
              {a.state === "checking" && <Icon name="spinner" size={12} spin className="shrink-0 text-content-faint" />}
            </div>
            <div className="mt-0.5 pl-[22px] text-[11px] leading-snug text-content-faint">
              {a.state === "missing" ? (
                <>
                  Not set up ·{" "}
                  <LinkButton onClick={() => useMateStore.getState().openGlobal("voice")} testId={`mate-${kind}-setup-${e.id}`}>
                    Set up in Global settings
                  </LinkButton>
                </>
              ) : a.state === "error" ? (
                <>
                  <span className="text-danger">Not working</span> ·{" "}
                  <LinkButton onClick={() => useMateStore.getState().openGlobal("voice")}>Fix in Global settings</LinkButton>
                </>
              ) : a.state === "unsupported" ? (
                a.why
              ) : (
                e.hint
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PreviewButton({ id, label = "Preview", onPlay, disabled, testId }: { id: string; label?: string; onPlay: () => Promise<void> | void; disabled?: boolean; testId?: string }) {
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
      title={on ? "Stop" : label}
    >
      {busy ? <Icon name="spinner" size={12} spin /> : <Icon name={on ? "stop" : "play"} size={12} />}
      {label && <span>{on ? "Stop" : label}</span>}
    </button>
  );
}

/** a list row's play button (ElevenLabs preview URL) */
function RowPreview({ id, url }: { id: string; url: string }) {
  const playing = usePreviewPlaying();
  const on = playing === id;
  return (
    <button
      type="button"
      className={`grid h-7 w-7 place-items-center rounded-md border ${on ? "border-accent/60 text-accent" : "border-border text-content-dim hover:text-content"}`}
      onClick={() => (on ? stopPreview() : void playPreview(id, url).catch(() => {}))}
      aria-label={on ? "Stop the preview" : "Play the preview"}
      title="Play the preview"
    >
      <Icon name={on ? "stop" : "play"} size={11} />
    </button>
  );
}

function LanguageField({ value, onChange, mate, extra, hint }: { value: string; onChange: (v: string) => void; mate: Mate; extra?: string[]; hint?: string }) {
  const opts: PickOption[] = [
    ...LANGS.map(([c, n]) => ({ value: c, label: n, sub: c, group: "Common" })),
    ...(extra ?? []).filter((x) => !LANGS.some(([c, n]) => c === x || n.toLowerCase() === x.toLowerCase())).map((x) => ({ value: x, label: x, group: "This server" })),
  ];
  return (
    <Field label="Language" hint={hint ?? "Empty = the reply language."} as="div">
      <SearchSelect value={value} options={opts} onChange={onChange} noneLabel={`Same as replies (${langName(mate.persona.language || "ko")})`} allowCustom testId="mate-voice-language" />
    </Field>
  );
}

function TtsDetails({ mate, tts, set, ready }: { mate: Mate; tts: Tts; set: (p: Partial<Tts>) => void; ready: boolean }) {
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
      setPreviewErr(e instanceof SpeechFallbackError ? e.message : `Preview failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-surface/40 p-3" data-testid={`mate-tts-details-${engine}`}>
      {engine === "browser" && <BrowserVoice mate={mate} tts={tts} set={set} sample={sample} />}

      {engine === "openai" && (
        <>
          <Field label="Model" as="div">
            <SearchSelect
              value={tts.model}
              onChange={(model) => set({ model })}
              options={(models.data?.models ?? []).map((m) => ({ value: m.id, label: m.name, sub: m.description ?? m.id }))}
              noneLabel={`Default (${models.data?.default || "gpt-4o-mini-tts"})`}
              loading={models.busy}
              testId="mate-tts-model"
            />
          </Field>
          <VoicePicker
            label="Voice"
            value={tts.voice}
            onChange={(voice) => set({ voice })}
            noneLabel="Default (Alloy)"
            voices={voices}
            toOption={(x) => {
              const model = tts.model || models.data?.default || "gpt-4o-mini-tts";
              const can = !x.models || x.models.includes(model);
              return { value: x.id, label: x.name, sub: can ? x.description : `${x.description ?? ""} · only on GPT-4o mini TTS`, disabled: !can };
            }}
          />
          {tts.voice && voices.data?.find((x) => x.id === tts.voice)?.models?.includes(tts.model || "gpt-4o-mini-tts") === false && (
            <p className="text-[12px] text-warning">This voice doesn't speak on {tts.model} — pick another voice or GPT-4o mini TTS.</p>
          )}
        </>
      )}

      {engine === "elevenlabs" && (
        <>
          <VoicePicker
            label="Voice"
            value={tts.voice}
            onChange={(voice) => set({ voice })}
            voices={voices}
            noneLabel="Choose a voice…"
            sort
            toOption={(x) => {
              const l = x.labels ?? {};
              const bits = [l.gender, l.age, l.accent, l.use_case || l["use case"], l.descriptive || l.description].filter(Boolean);
              const langs = x.languages?.length ? x.languages.join(", ") : x.language;
              return {
                value: x.id,
                label: x.name,
                sub: [bits.join(" · "), langs].filter(Boolean).join(" — ") || x.description,
                group: ELEVEN_GROUP[x.category ?? ""] ?? "Other",
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
          <Field label="Model" as="div">
            <SearchSelect
              value={tts.model}
              onChange={(model) => set({ model })}
              options={(models.data?.models ?? []).map((m) => ({
                value: m.id,
                label: m.name,
                sub: [m.description?.split(/(?<=\.)\s/)[0], m.languages?.length ? `${m.languages.length} languages` : ""].filter(Boolean).join(" · "),
                keywords: (m.languages ?? []).join(" "),
              }))}
              noneLabel={`Default (${models.data?.models.find((m) => m.id === models.data?.default)?.name || "Multilingual v2"})`}
              loading={models.busy}
              testId="mate-tts-model"
            />
            <ErrorLine text={models.err} />
          </Field>
          {(() => {
            const m = models.data?.models.find((x) => x.id === (tts.model || models.data?.default));
            const code = lang.slice(0, 2);
            return m?.languages?.length && !m.languages.some((x) => x.toLowerCase().startsWith(code)) ? (
              <p className="text-[12px] text-warning">{m.name} doesn't list {langName(code)} — pick a multilingual model.</p>
            ) : null;
          })()}
        </>
      )}

      {engine === "omnivoice" && <OmniVoice mate={mate} tts={tts} set={set} voices={voices} />}

      {engine === "http" && (
        <>
          <Field label="Model" as="div" hint={models.data && !models.data.models.length ? "The server lists no models — type the one it expects, or leave the default." : undefined}>
            <SearchSelect
              value={tts.model}
              onChange={(model) => set({ model })}
              options={(models.data?.models ?? []).map((m) => ({ value: m.id, label: m.name }))}
              noneLabel={`Default (${models.data?.default || "tts-1"})`}
              allowCustom
              loading={models.busy}
              testId="mate-tts-model"
            />
            <ErrorLine text={models.err} />
          </Field>
          <Field label="Voice" hint="The voice name the server knows (empty = its default).">
            <input className="field" value={tts.voice} onChange={(e) => set({ voice: e.target.value })} placeholder="default" data-testid="mate-tts-voice-text" />
          </Field>
        </>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Speed ${tts.speed.toFixed(2)}×`} hint={engine === "elevenlabs" ? "ElevenLabs allows 0.7–1.2×." : undefined}>
          <input
            type="range"
            min={lo}
            max={hi}
            step={0.05}
            value={Math.min(hi, Math.max(lo, tts.speed))}
            onChange={(e) => set({ speed: Number(e.target.value) })}
            className="w-full accent-[#6e8bff]"
            data-testid="mate-tts-speed"
          />
        </Field>
        <LanguageField
          value={tts.language}
          onChange={(language) => set({ language })}
          mate={mate}
          extra={engine === "omnivoice" ? models.data?.languages : undefined}
          hint={engine === "elevenlabs" ? "Picks the matching voice preview; the model detects the language itself." : undefined}
        />
      </div>

      {engine !== "browser" && (
        <div className="flex flex-wrap items-center gap-2">
          <PreviewButton id={previewKey} label="Preview" onPlay={synth} disabled={engine === "elevenlabs" && !tts.voice} testId="mate-tts-preview" />
          <span className="min-w-0 flex-1 text-[11.5px] text-content-faint">“{sample}” — with the settings above, before saving.</span>
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
  const options = useMemo(() => {
    const xs = (voices.data ?? []).map(toOption);
    if (sort) xs.sort((a, b) => GROUP_ORDER.indexOf(a.group ?? "Other") - GROUP_ORDER.indexOf(b.group ?? "Other") || a.label.localeCompare(b.label));
    return xs;
  }, [voices.data, toOption, sort]);
  const missing = value && voices.data && !voices.data.some((x) => x.id === value);
  return (
    <Field
      label={
        <span className="flex items-center gap-2">
          {label}
          {voices.data && <span className="text-[10.5px] font-normal text-content-faint">{voices.data.length} available</span>}
          <button type="button" className="ml-auto text-content-faint hover:text-content" onClick={voices.reload} title="Reload the list" aria-label="Reload the list">
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
      {missing && <p className="mt-1 text-[12px] text-warning">“{value}” isn't in the list any more — pick another voice.</p>}
      {required && !value && voices.data && <p className="mt-1 text-[12px] text-warning">Pick a voice — this engine needs one.</p>}
    </Field>
  );
}

function BrowserVoice({ mate, tts, set, sample }: { mate: Mate; tts: Tts; set: (p: Partial<Tts>) => void; sample: string }) {
  const all = useBrowserVoices();
  const lang = bcp47(tts.language || mate.persona.language).toLowerCase();
  const base = lang.split("-")[0];
  const options: PickOption[] = useMemo(
    () =>
      [...all]
        .map((x) => ({
          value: x.voiceURI,
          label: x.name,
          sub: `${x.lang}${x.localService ? "" : " · online"}`,
          group: x.lang.toLowerCase().startsWith(base) ? `For ${langName(base)}` : "Other languages",
          keywords: x.lang,
        }))
        .sort((a, b) => Number(b.group.startsWith("For")) - Number(a.group.startsWith("For")) || a.label.localeCompare(b.label)),
    [all, base],
  );
  return (
    <>
      <Field label="Voice" as="div" hint={all.length ? `${all.length} voices on this device — each device has its own.` : "This device lists no voices: the system default is used, if any."}>
        <SearchSelect value={tts.voice} options={options} onChange={(voice) => set({ voice })} noneLabel={`Default for ${langName(base)}`} testId="mate-tts-voice" />
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
  const current = tts.profile || tts.voice;
  const [mode, setMode] = useState<"profile" | "design">(current || !tts.instruct ? "profile" : "design");
  return (
    <>
      <Field label="Voice" as="div">
        <Segmented
          value={mode}
          onChange={(m) => {
            setMode(m);
            if (m === "design") set({ voice: "", profile: "" });
          }}
          options={[
            { id: "profile", label: "Voice profile", title: "A cloned voice on the OmniVoice server (reference clips per emotion)" },
            { id: "design", label: "Voice design", title: "Describe the voice; no reference clip" },
          ]}
          testId="mate-omni-mode"
        />
      </Field>
      {mode === "profile" ? (
        <VoicePicker
          label="Profile"
          value={current}
          onChange={(id) => set({ voice: id, profile: "" })}
          voices={voices}
          noneLabel="Choose a profile…"
          toOption={(x) => ({
            value: x.id,
            label: x.name,
            sub: [x.language, x.emotions?.length ? `emotions: ${x.emotions.join(", ")}` : "no reference clips"].filter(Boolean).join(" · "),
            badges: x.category === "template" ? ["template"] : undefined,
            keywords: (x.emotions ?? []).join(" "),
          })}
          required
        />
      ) : (
        <Field label="Voice design" hint="Speaker attributes OmniVoice designs the voice from (no reference clip needed)." as="div">
          <input className="field" value={tts.instruct ?? ""} onChange={(e) => set({ instruct: e.target.value })} placeholder="female, young adult, low pitch" data-testid="mate-tts-instruct" />
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
        <Field label="Reference clip (imported with the mate)" hint="OmniVoice clones only from clips on its own server — add this one there as a voice profile to use it." as="div">
          <div className="space-y-1.5 rounded-lg border border-border bg-surface/60 p-2" data-testid="mate-tts-ref">
            <audio controls preload="none" src={assetUrl(mate.id, tts.ref)} className="h-8 w-full" />
            <div className="font-mono text-[11px] text-content-faint">{tts.ref}</div>
            <textarea className="field resize-y text-[12.5px]" rows={2} value={tts.ref_text ?? ""} onChange={(e) => set({ ref_text: e.target.value })} placeholder="What the clip says" />
          </div>
        </Field>
      )}
    </>
  );
}

function SttDetails({ mate, stt, set, ready }: { mate: Mate; stt: Stt; set: (p: Partial<Stt>) => void; ready: boolean }) {
  const engine = stt.engine;
  const models = useFetched<ModelList>(ready && (engine === "openai" || engine === "whisper") ? `models:${engine}:stt` : null, () => listModels(engine, "stt"));
  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-surface/40 p-3" data-testid={`mate-stt-details-${engine}`}>
      {(engine === "openai" || engine === "whisper") && (
        <Field label="Model" as="div" hint={engine === "whisper" && models.data && !models.data.models.length ? "The server lists no models — type the one it serves, or leave the default." : undefined}>
          <SearchSelect
            value={stt.model}
            onChange={(model) => set({ model })}
            options={(models.data?.models ?? []).map((m) => ({ value: m.id, label: m.name, sub: m.description ?? (m.id !== m.name ? m.id : undefined) }))}
            noneLabel={`Default (${models.data?.default || (engine === "openai" ? "gpt-4o-mini-transcribe" : "server's first model")})`}
            allowCustom={engine === "whisper"}
            loading={models.busy}
            testId="mate-stt-model"
          />
          <ErrorLine text={models.err} />
        </Field>
      )}
      {engine === "browser" && <p className="text-[12px] text-content-faint">Recognized by this browser (Google / Apple servers in Chrome / Safari). Not in the desktop or Android app.</p>}
      <LanguageField value={stt.language} onChange={(language) => set({ language })} mate={mate} hint="The language you speak. Empty = the reply language." />
    </div>
  );
}
