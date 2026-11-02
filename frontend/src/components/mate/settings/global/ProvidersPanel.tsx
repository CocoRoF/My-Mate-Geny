/**
 * Voice services (Global settings): the keys / URLs every mate's voice uses, each with a verification state
 * (Connected / Error / Not configured), Save & verify, Test again and Remove. Keys are write-only.
 */
import { useEffect, useState } from "react";
import { getVoiceSettings, putVoiceSettings, type ProviderStatus, type VoiceSettings, type VoiceSettingsPatch } from "../../../../api/mates";
import { useMateStore } from "../../../../stores/mateStore";
import { relTime } from "../../../../i18n/format";
import { tr, useT, type MsgKey } from "../../../../i18n";
import Icon from "../../../ui/Icon";
import { ErrorLine, Field, Section, StatusBadge } from "../ui";

type KeyName = "openai_key" | "elevenlabs_key" | "http_tts_key";
type UrlName = "omnivoice_url" | "whisper_url" | "http_tts_url";

interface CardSpec {
  engine: string;
  title: MsgKey;
  kinds: ("Speaking" | "Listening")[];
  hint: MsgKey;
  link?: { href: string; label: MsgKey };
  url?: { name: UrlName; label: MsgKey; placeholder: string; hint?: MsgKey };
  key?: { name: KeyName; label: MsgKey; optional?: boolean; placeholder?: string; placeholderKey?: MsgKey };
}

const CARDS: CardSpec[] = [
  {
    engine: "openai",
    title: "mateSettings.engOpenai",
    kinds: ["Speaking", "Listening"],
    hint: "mateSettings.provOpenaiHint",
    link: { href: "https://platform.openai.com/api-keys", label: "mateSettings.provGetKey" },
    key: { name: "openai_key", label: "mateSettings.provApiKey", placeholder: "sk-…" },
  },
  {
    engine: "elevenlabs",
    title: "mateSettings.engElevenlabs",
    kinds: ["Speaking", "Listening"],
    hint: "mateSettings.provElevenHint",
    link: { href: "https://elevenlabs.io/app/settings/api-keys", label: "mateSettings.provGetKey" },
    key: { name: "elevenlabs_key", label: "mateSettings.provApiKey", placeholder: "xi-… / sk_…" }, // i18n-ignore
  },
  {
    engine: "omnivoice",
    title: "mateSettings.engOmnivoice",
    kinds: ["Speaking"],
    hint: "mateSettings.provOmniHint",
    url: { name: "omnivoice_url", label: "mateSettings.provServerUrl", placeholder: "http://host:9880" },
  },
  {
    engine: "whisper",
    title: "mateSettings.engWhisper",
    kinds: ["Listening"],
    hint: "mateSettings.provWhisperHint",
    url: { name: "whisper_url", label: "mateSettings.provServerUrl", placeholder: "http://host:8001" },
  },
  {
    engine: "http",
    title: "mateSettings.provHttpTitle",
    kinds: ["Speaking"],
    hint: "mateSettings.provHttpHint",
    url: { name: "http_tts_url", label: "mateSettings.provServerUrl", placeholder: "http://host:8000/v1", hint: "mateSettings.provHttpUrlHint" },
    key: { name: "http_tts_key", label: "mateSettings.provApiKey", optional: true, placeholderKey: "mateSettings.provKeyOptionalPh" },
  },
];

/** (the label is in the UI's language at call time — call while rendering) */
export function statusOf(p: ProviderStatus | undefined, busy = false): { status: "ok" | "error" | "off" | "checking"; label: string } {
  if (busy) return { status: "checking", label: tr("mateSettings.provChecking") };
  if (!p || !p.configured) return { status: "off", label: tr("mateSettings.provNotConfigured") };
  if (p.ok === null) return { status: "checking", label: tr("mateSettings.provNotChecked") };
  return p.ok ? { status: "ok", label: tr("common.connected") } : { status: "error", label: tr("common.error") };
}

export default function ProvidersPanel() {
  const t = useT();
  const [s, setS] = useState<VoiceSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const providers = useMateStore((x) => x.providers);
  const loading = useMateStore((x) => x.providersLoading);
  const provErr = useMateStore((x) => x.providersError);
  useEffect(() => {
    getVoiceSettings()
      .then(setS)
      .catch((e) => setErr((e as Error).message));
    void useMateStore.getState().loadProviders();
  }, []);
  const find = (engine: string) => providers?.tts.find((p) => p.engine === engine) ?? providers?.stt.find((p) => p.engine === engine);

  return (
    <>
      <Section
        title={t("mateSettings.provTitle")}
        hint={t("mateSettings.provHint")}
        right={
          <button className="btn-ghost !px-2.5 !py-1 text-[12px]" onClick={() => useMateStore.getState().loadProviders(true)} disabled={loading} title={t("mateSettings.provRecheckTitle")} data-testid="mate-providers-recheck">
            <Icon name="refresh" size={13} spin={loading} /> {t("mateSettings.provRecheck")}
          </button>
        }
      >
        <div className="flex flex-wrap gap-1.5 text-[11.5px]" data-testid="mate-providers-summary">
          {CARDS.map((c) => {
            const st = statusOf(find(c.engine), loading && !providers);
            return (
              <StatusBadge key={c.engine} status={st.status}>
                {t(c.title)}
              </StatusBadge>
            );
          })}
        </div>
        <ErrorLine text={err || provErr} />
      </Section>
      {s &&
        CARDS.map((c) => <ProviderCard key={c.engine} spec={c} settings={s} status={find(c.engine)} onSettings={setS} />)}
    </>
  );
}

function ProviderCard({ spec, settings, status, onSettings }: { spec: CardSpec; settings: VoiceSettings; status: ProviderStatus | undefined; onSettings: (s: VoiceSettings) => void }) {
  const t = useT();
  const savedUrl = spec.url ? settings[spec.url.name] || "" : "";
  const keySet = spec.key ? settings[`${spec.key.name}_set` as const] : false;
  const [url, setUrl] = useState(savedUrl);
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<"save" | "verify" | "remove" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setUrl(savedUrl), [savedUrl]);
  const dirty = (spec.url && url.trim().replace(/\/+$/, "") !== savedUrl) || (spec.key && key.trim() !== "");
  const configured = !!status?.configured;
  const st = statusOf(status, busy === "save" || busy === "verify");

  const put = async (patch: VoiceSettingsPatch, what: "save" | "remove") => {
    setBusy(what);
    setErr(null);
    try {
      const r = await putVoiceSettings(patch, true);
      const { providers, ...rest } = r;
      onSettings(rest);
      if (providers) useMateStore.getState().setProviders(providers);
      setKey("");
      setShow(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = () => {
    const patch: VoiceSettingsPatch = {};
    if (spec.url) patch[spec.url.name] = url.trim();
    if (spec.key && key.trim()) patch[spec.key.name] = key.trim();
    void put(patch, "save");
  };
  const remove = () => {
    const patch: VoiceSettingsPatch = {};
    if (spec.url) patch[spec.url.name] = "";
    if (spec.key) patch[spec.key.name] = null;
    void put(patch, "remove");
  };
  const verify = async () => {
    setBusy("verify");
    setErr(null);
    try {
      await useMateStore.getState().verifyProvider(spec.engine);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      testId={`mate-provider-${spec.engine}`}
      title={
        <span className="flex flex-wrap items-center gap-2">
          {t(spec.title)}
          {spec.kinds.map((k) => (
            <span key={k} className="rounded bg-surface-3 px-1.5 py-px text-[10.5px] font-medium text-content-dim">
              <Icon name={k === "Speaking" ? "volume" : "mic"} size={10} className="-mt-px mr-0.5 inline" />
              {k === "Speaking" ? t("mateSettings.voiceSpeaking") : t("mateSettings.provListening")}
            </span>
          ))}
        </span>
      }
      hint={
        <>
          {t(spec.hint)}
          {spec.link && (
            <>
              {" "}
              <a href={spec.link.href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                {t(spec.link.label)} <Icon name="external" size={10} className="inline" />
              </a>
            </>
          )}
        </>
      }
      right={
        <StatusBadge status={st.status} testId={`mate-provider-${spec.engine}-status`}>
          {st.label}
        </StatusBadge>
      }
    >
      {spec.url && (
        <Field label={t(spec.url.label)} hint={spec.url.hint ? t(spec.url.hint) : undefined}>
          <input
            className="field font-mono text-[12.5px]"
            value={url}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && dirty && save()}
            placeholder={spec.url.placeholder}
            data-testid={`mate-provider-${spec.engine}-url`}
          />
        </Field>
      )}
      {spec.key && (
        <Field label={spec.key.optional ? t("mateSettings.provOptional", { label: t(spec.key.label) }) : t(spec.key.label)}>
          <div className="relative">
            <input
              className="field pr-9 font-mono text-[12.5px]"
              type={show ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && dirty && save()}
              placeholder={keySet ? t("mateSettings.provKeySaved") : spec.key.placeholderKey ? t(spec.key.placeholderKey) : spec.key.placeholder || t("mateSettings.provNotSet")}
              data-testid={`mate-provider-${spec.engine}-key`}
            />
            {key && (
              <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-content-faint hover:text-content" onClick={() => setShow((x) => !x)} aria-label={show ? t("mateSettings.provHide") : t("mateSettings.provShow")}>
                <Icon name={show ? "eye-off" : "eye"} size={14} />
              </button>
            )}
          </div>
        </Field>
      )}
      {status?.configured && (status.error || status.detail) && busy === null && (
        <div
          className={`rounded-lg border px-3 py-2 text-[12px] leading-relaxed break-words ${
            status.ok ? "border-success/25 bg-success/[0.06] text-content-dim" : "border-danger/30 bg-danger/[0.07] text-danger"
          }`}
          data-testid={`mate-provider-${spec.engine}-message`}
        >
          {status.ok ? (
            <>
              <Icon name="check" size={12} className="-mt-0.5 mr-1 inline text-success" />
              {status.detail}
            </>
          ) : (
            status.error
          )}
          {status.checked_at && <span className="ml-1.5 text-content-faint">· {t("mateSettings.provChecked", { when: relTime(status.checked_at) })}</span>}
        </div>
      )}
      <ErrorLine text={err} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {configured && (
          <button className="btn-ghost mr-auto !px-2.5 text-[12.5px] text-danger hover:!text-danger" onClick={remove} disabled={!!busy} data-testid={`mate-provider-${spec.engine}-remove`}>
            {busy === "remove" ? <Icon name="spinner" size={13} spin /> : <Icon name="trash" size={13} />} {t("common.remove")}
          </button>
        )}
        {configured && !dirty && (
          <button className="btn-ghost border border-border !py-1.5 text-[12.5px]" onClick={verify} disabled={!!busy} data-testid={`mate-provider-${spec.engine}-verify`}>
            {busy === "verify" ? <Icon name="spinner" size={13} spin /> : <Icon name="refresh" size={13} />} {t("mateSettings.provTestAgain")}
          </button>
        )}
        <button className="btn-primary !py-1.5 text-[12.5px]" onClick={save} disabled={!dirty || !!busy} data-testid={`mate-provider-${spec.engine}-save`}>
          {busy === "save" ? <Icon name="spinner" size={13} spin /> : <Icon name="shield" size={13} />} {t("mateSettings.provSaveVerify")}
        </button>
      </div>
    </Section>
  );
}
