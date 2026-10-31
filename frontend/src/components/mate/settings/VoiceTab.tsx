/** Voice: how the mate speaks (TTS) and hears (STT), reading aloud, and the shared keys / service URLs. */
import { useEffect, useState } from "react";
import {
  assetUrl,
  getVoiceSettings,
  listVoices,
  putVoiceSettings,
  type Mate,
  type MateVoice,
  type SttEngine,
  type TtsEngine,
  type VoiceOption,
  type VoiceSettings,
  type VoiceSettingsPatch,
} from "../../../api/mates";
import { webSpeechRecognition } from "../../../mate/desktop";
import { bcp47, type MateConversation } from "../../../mate/useMateConversation";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import { ErrorLine, Field, SaveBar, Section, Toggle, useSaver } from "./ui";

const TTS: { id: TtsEngine; label: string; hint: string }[] = [
  { id: "browser", label: "Browser voice", hint: "Free, spoken by this device (speechSynthesis). Linux often has no voices." },
  { id: "openai", label: "OpenAI", hint: "gpt-4o-mini-tts; needs the OpenAI key below." },
  { id: "elevenlabs", label: "ElevenLabs", hint: "Needs the ElevenLabs key and a voice." },
  { id: "omnivoice", label: "OmniVoice", hint: "Your own OmniVoice server (emotion-aware reference clips)." },
  { id: "http", label: "OpenAI-compatible server", hint: "Any …/audio/speech endpoint (URL below)." },
  { id: "off", label: "Off", hint: "Never speaks." },
];
const STT: { id: SttEngine; label: string; hint: string }[] = [
  { id: "browser", label: "Browser", hint: "Web Speech in Chrome / Edge / Safari — not in the desktop or Android app." },
  { id: "openai", label: "OpenAI", hint: "gpt-4o-mini-transcribe; needs the OpenAI key below." },
  { id: "whisper", label: "Whisper server", hint: "An OpenAI-compatible /v1/audio/transcriptions server (URL below)." },
  { id: "off", label: "Off", hint: "No mic button." },
];

const SAMPLE: Record<string, string> = {
  ko: "[greet] 안녕하세요! 오늘도 같이 힘내 봐요.",
  en: "[greet] Hi there! Let's get things done today.",
  ja: "[greet] こんにちは!今日も一緒に頑張りましょう。",
};

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
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voicesErr, setVoicesErr] = useState<string | null>(null);
  const [voicesBusy, setVoicesBusy] = useState(false);
  const browserVoices = useBrowserVoices();
  const engine = v.tts.engine;
  const dirty = JSON.stringify(v) !== JSON.stringify(mate.voice);
  const tts = (patch: Partial<MateVoice["tts"]>) => setV((x) => ({ ...x, tts: { ...x.tts, ...patch } }));
  const stt = (patch: Partial<MateVoice["stt"]>) => setV((x) => ({ ...x, stt: { ...x.stt, ...patch } }));
  const save = () => saver.run(() => useMateStore.getState().patch(mate.id, { voice: v }));
  const lang = bcp47(v.tts.language || mate.persona.language).toLowerCase();

  const loadVoices = (eng: string) => {
    setVoices([]);
    setVoicesErr(null);
    if (!["openai", "elevenlabs", "omnivoice"].includes(eng)) return;
    setVoicesBusy(true);
    listVoices(eng)
      .then((r) => setVoices(r.voices))
      .catch((e) => setVoicesErr((e as Error).message))
      .finally(() => setVoicesBusy(false));
  };
  useEffect(() => loadVoices(engine), [engine]); // eslint-disable-line react-hooks/exhaustive-deps

  const test = async () => {
    if (dirty && !(await saver.run(() => useMateStore.getState().patch(mate.id, { voice: v })))) return;
    conv.say(SAMPLE[(mate.persona.language || "ko").slice(0, 2)] || SAMPLE.en);
  };

  const langVoices = browserVoices.filter((x) => !lang || x.lang.toLowerCase().startsWith(lang.split("-")[0]));
  const webSpeech = !!webSpeechRecognition();

  return (
    <>
      <Section title="Speaking" hint={TTS.find((t) => t.id === engine)?.hint}>
        <Field label="Voice engine">
          <select className="field" value={engine} onChange={(e) => tts({ engine: e.target.value as TtsEngine, voice: "" })} data-testid="mate-tts-engine">
            {TTS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        {engine === "browser" && (
          <Field label="Voice" hint={browserVoices.length ? undefined : "This device lists no voices — the system default is used, if any."}>
            <select className="field" value={v.tts.voice} onChange={(e) => tts({ voice: e.target.value })}>
              <option value="">Default for the language</option>
              {(langVoices.length ? langVoices : browserVoices).map((x) => (
                <option key={x.voiceURI} value={x.voiceURI}>
                  {x.name} ({x.lang})
                </option>
              ))}
            </select>
          </Field>
        )}
        {(engine === "openai" || engine === "elevenlabs" || engine === "omnivoice") && (
          <Field label={engine === "omnivoice" ? "Voice profile" : "Voice"}>
            <div className="flex gap-2">
              <select className="field" value={v.tts.voice} onChange={(e) => tts({ voice: e.target.value })} data-testid="mate-tts-voice">
                <option value="">{engine === "openai" ? "Default (alloy)" : "Choose…"}</option>
                {voices.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.language ? ` (${x.language})` : ""}
                  </option>
                ))}
                {v.tts.voice && !voices.some((x) => x.id === v.tts.voice) && <option value={v.tts.voice}>{v.tts.voice}</option>}
              </select>
              <button className="btn-ghost shrink-0 !px-2.5" onClick={() => loadVoices(engine)} title="Reload voices">
                <Icon name="refresh" size={14} spin={voicesBusy} />
              </button>
            </div>
            <ErrorLine text={voicesErr} />
          </Field>
        )}
        {engine === "omnivoice" && (
          <Field label="Voice design" hint="OmniVoice instruct text, e.g. “female, young adult, low pitch” — used when no profile is chosen.">
            <input className="field" value={v.tts.instruct ?? ""} onChange={(e) => tts({ instruct: e.target.value })} data-testid="mate-tts-instruct" />
          </Field>
        )}
        {!!v.tts.ref && (
          <Field
            label="Reference clip"
            hint="Imported with the mate. OmniVoice clones only from clips on its own server (profiles) — upload this one there as a profile to use it."
          >
            <div className="space-y-1.5 rounded-lg border border-border bg-surface/60 p-2" data-testid="mate-tts-ref">
              <audio controls preload="none" src={assetUrl(mate.id, v.tts.ref)} className="h-8 w-full" />
              <div className="font-mono text-[11px] text-content-faint">{v.tts.ref}</div>
              <textarea
                className="field resize-y text-[12.5px]"
                rows={2}
                value={v.tts.ref_text ?? ""}
                onChange={(e) => tts({ ref_text: e.target.value })}
                placeholder="What the clip says"
              />
            </div>
          </Field>
        )}
        {(engine === "openai" || engine === "elevenlabs" || engine === "http") && (
          <Field label="Model" hint={engine === "openai" ? "Empty = gpt-4o-mini-tts" : engine === "elevenlabs" ? "Empty = eleven_multilingual_v2" : undefined}>
            <input className="field" value={v.tts.model} onChange={(e) => tts({ model: e.target.value })} />
          </Field>
        )}
        {engine === "http" && (
          <Field label="Voice">
            <input className="field" value={v.tts.voice} onChange={(e) => tts({ voice: e.target.value })} />
          </Field>
        )}
        {engine !== "off" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`Speed ${v.tts.speed.toFixed(2)}×`}>
              <input type="range" min={0.5} max={2} step={0.05} value={v.tts.speed} onChange={(e) => tts({ speed: Number(e.target.value) })} className="w-full accent-[#6e8bff]" />
            </Field>
            <Field label="Voice language" hint="Empty = the reply language.">
              <input className="field" value={v.tts.language} onChange={(e) => tts({ language: e.target.value })} placeholder={mate.persona.language} />
            </Field>
          </div>
        )}
        <Toggle on={v.auto_read} onChange={(on) => setV((x) => ({ ...x, auto_read: on }))} label="Read replies aloud" hint="Sentence by sentence while the reply is written. The speaker button by the message box mutes this device." />
        <div className="flex items-center gap-2">
          <button className="btn-soft" onClick={test} disabled={engine === "off"} data-testid="mate-voice-test">
            <Icon name="play" size={14} /> {dirty ? "Save & test" : "Test voice"}
          </button>
          <button className="btn-ghost" onClick={conv.stopVoice}>
            <Icon name="stop" size={12} /> Stop
          </button>
          {conv.voiceError && <span className="min-w-0 text-[12px] text-danger break-words">{conv.voiceError}</span>}
        </div>
      </Section>

      <Section title="Listening (mic)" hint={STT.find((t) => t.id === v.stt.engine)?.hint}>
        <Field label="Speech-to-text engine">
          <select className="field" value={v.stt.engine} onChange={(e) => stt({ engine: e.target.value as SttEngine })}>
            {STT.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        {v.stt.engine === "browser" && !webSpeech && (
          <p className="text-[12px] text-warning">Speech recognition isn't available in this browser/app — the mic won't work here with this engine.</p>
        )}
        {(v.stt.engine === "openai" || v.stt.engine === "whisper") && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Model" hint={v.stt.engine === "openai" ? "Empty = gpt-4o-mini-transcribe" : "Empty = whisper-1"}>
              <input className="field" value={v.stt.model} onChange={(e) => stt({ model: e.target.value })} />
            </Field>
            <Field label="Language" hint="Empty = the reply language.">
              <input className="field" value={v.stt.language} onChange={(e) => stt({ language: e.target.value })} placeholder={mate.persona.language} />
            </Field>
          </div>
        )}
      </Section>
      <SaveBar saver={saver} onSave={save} dirty={dirty} />
      <GlobalVoiceCard />
    </>
  );
}

/** keys and service URLs shared by every mate (keys are write-only) */
function GlobalVoiceCard() {
  const [s, setS] = useState<VoiceSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [urls, setUrls] = useState({ omnivoice_url: "", whisper_url: "", http_tts_url: "" });
  const [keys, setKeys] = useState({ openai_key: "", elevenlabs_key: "", http_tts_key: "" });
  const saver = useSaver();
  useEffect(() => {
    getVoiceSettings()
      .then((x) => {
        setS(x);
        setUrls({ omnivoice_url: x.omnivoice_url || "", whisper_url: x.whisper_url || "", http_tts_url: x.http_tts_url || "" });
      })
      .catch((e) => setErr((e as Error).message));
  }, []);
  if (!s) return <ErrorLine text={err} />;

  const put = (patch: VoiceSettingsPatch) =>
    saver.run(async () => {
      const x = await putVoiceSettings(patch);
      setS(x);
      setKeys({ openai_key: "", elevenlabs_key: "", http_tts_key: "" });
    });
  const urlsDirty = urls.omnivoice_url !== (s.omnivoice_url || "") || urls.whisper_url !== (s.whisper_url || "") || urls.http_tts_url !== (s.http_tts_url || "");
  const keyRow = (k: "openai_key" | "elevenlabs_key" | "http_tts_key", label: string) => {
    const set = s[`${k}_set` as const];
    return (
      <Field label={label}>
        <div className="flex gap-2">
          <input
            className="field font-mono"
            type="password"
            autoComplete="off"
            value={keys[k]}
            onChange={(e) => setKeys((x) => ({ ...x, [k]: e.target.value }))}
            placeholder={set ? "•••••••• saved — type to replace" : "not set"}
          />
          <button className="btn-soft shrink-0" disabled={!keys[k].trim() || saver.busy} onClick={() => put({ [k]: keys[k].trim() })}>
            Save
          </button>
          {set && (
            <button className="btn-ghost shrink-0 text-danger" disabled={saver.busy} onClick={() => put({ [k]: null })} title="Remove the key">
              <Icon name="trash" size={13} />
            </button>
          )}
        </div>
      </Field>
    );
  };

  return (
    <Section title="Voice services (all mates)" hint="Keys are stored encrypted on the server and never shown again.">
      {keyRow("openai_key", "OpenAI API key")}
      {keyRow("elevenlabs_key", "ElevenLabs API key")}
      <Field label="OmniVoice URL">
        <input className="field" value={urls.omnivoice_url} onChange={(e) => setUrls((x) => ({ ...x, omnivoice_url: e.target.value }))} placeholder="http://host:port" />
      </Field>
      <Field label="Whisper server URL" hint="OpenAI-compatible: …/v1/audio/transcriptions is added.">
        <input className="field" value={urls.whisper_url} onChange={(e) => setUrls((x) => ({ ...x, whisper_url: e.target.value }))} placeholder="http://host:port" />
      </Field>
      <Field label="HTTP TTS URL" hint="OpenAI-shaped: …/audio/speech is added.">
        <input className="field" value={urls.http_tts_url} onChange={(e) => setUrls((x) => ({ ...x, http_tts_url: e.target.value }))} placeholder="http://host:port/v1" />
      </Field>
      {keyRow("http_tts_key", "HTTP TTS key (optional)")}
      <div className="flex items-center justify-end gap-3">
        <ErrorLine text={saver.err} />
        {saver.ok && <span className="text-[12px] text-success">Saved</span>}
        <button className="btn-primary" disabled={!urlsDirty || saver.busy} onClick={() => put(urls)}>
          Save URLs
        </button>
      </div>
    </Section>
  );
}
