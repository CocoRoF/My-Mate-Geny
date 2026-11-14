/**
 * Voice Studio → 프로필: the voices lines are made in. A profile is a clip per feeling (기본, 기쁨, 슬픔, 화남, 놀람, 두려움,
 * 혐오, 미소 — upload, record, trim, the exact words, its language), a description, tags, and what lines made in it
 * start from (a model, its parameters, a design prompt). Built-in ones (한채린, 메스가키) can be heard and duplicated.
 * A feeling without a clip speaks like the nearest one that has (미소 → 기쁨, 두려움 → 슬픔, 혐오 → 화남), else like 기본.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createLocalVoice,
  deleteLocalVoice,
  deleteVoiceReference,
  duplicateLocalVoice,
  FEELINGS,
  updateLocalVoice,
  updateVoiceReference,
  type Feeling,
  type LocalVoice,
  type VoicePatch,
  type VoiceRef,
} from "../../api/voice";
import { useT, type MsgKey } from "../../i18n";
import { confirmDialog } from "../ui/ConfirmDialog";
import Icon from "../ui/Icon";
import { ErrorLine, Field, Segmented } from "../mate/settings/ui";
import { ClipModal, RecorderModal, type ClipSource } from "./clips";
import { Card, FeelingDot, Modal, ParamControls, PlayButton, refUrl, secs, useLanguages, useStudio, Waveform } from "./shared";

/** what a feeling without a clip speaks like (backend voicehost/voices.py _CHAIN) */
const FALLBACK: Partial<Record<Feeling, Feeling>> = { smile: "joy", fear: "sadness", disgust: "anger" };

type Filter = "all" | "mine" | "builtin";

export default function ProfilesPage() {
  const t = useT();
  const { voices, reloadVoices } = useStudio();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return voices
      .filter((v) => filter === "all" || (filter === "mine" ? !v.builtin : v.builtin))
      .filter((v) => !n || [v.name, v.description ?? "", ...(v.tags ?? [])].some((s) => s.toLowerCase().includes(n)))
      .sort((a, b) => Number(!!b.starred) - Number(!!a.starred) || Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
  }, [voices, q, filter]);
  const current = voices.find((v) => v.id === sel) ?? shown[0] ?? null;
  return (
    <div className="grid gap-3 lg:grid-cols-[260px_1fr]" data-testid="vs-profiles">
      <div className="space-y-2">
        <div className="flex gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-faint" />
            <input className="field !pl-8 !py-1.5 text-[12.5px]" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("voiceStudio.pfSearch")} data-testid="vs-profile-search" />
          </div>
          <button className="btn-primary !px-2.5 !py-1.5 text-[12.5px]" onClick={() => setCreating(true)} data-testid="vs-profile-new">
            <Icon name="plus" size={13} />
          </button>
        </div>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { id: "all", label: t("voiceStudio.pfAll") },
            { id: "mine", label: t("voiceStudio.pfMine") },
            { id: "builtin", label: t("localVoice.builtin") },
          ]}
        />
        <ul className="max-h-[60vh] space-y-1 overflow-y-auto pr-0.5" data-testid="vs-profile-list">
          {shown.map((v) => {
            const on = current?.id === v.id;
            const have = new Set(v.references.map((r) => r.label));
            return (
              <li key={v.id}>
                <button
                  className={`w-full rounded-lg border px-2.5 py-2 text-left transition ${on ? "border-accent/60 bg-accent-soft/40" : "border-border/60 bg-surface/40 hover:bg-surface-3/40"}`}
                  onClick={() => setSel(v.id)}
                  data-testid={`vs-profile-item-${v.id}`}
                  data-active={on}
                >
                  <span className="flex items-center gap-1.5">
                    {v.starred && <Icon name="star" size={12} className="text-warning" />}
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-content">{v.name}</span>
                    {v.builtin && <span className="pill border border-accent/30 bg-accent-soft text-[10px] text-accent">{t("localVoice.builtin")}</span>}
                  </span>
                  <span className="mt-1 flex items-center gap-1">
                    {FEELINGS.map((f) => (
                      <span key={f} className={have.has(f) ? "" : "opacity-20"} title={t(`localVoice.feeling_${f}` as MsgKey)}>
                        <FeelingDot feeling={f} size={7} />
                      </span>
                    ))}
                    <span className="ml-1 text-[11px] text-content-faint">{t("voiceStudio.pfClips", { n: v.references.length })}</span>
                  </span>
                </button>
              </li>
            );
          })}
          {shown.length === 0 && <li className="px-1 text-[12px] text-content-faint">{t("voiceStudio.pfNone")}</li>}
        </ul>
      </div>
      <div className="min-w-0">{current ? <Profile key={current.id} v={current} onGone={() => setSel(null)} onPick={setSel} /> : null}</div>
      {creating && (
        <CreateModal
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await reloadVoices();
            setSel(id);
          }}
        />
      )}
    </div>
  );
}

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const t = useT();
  const languages = useLanguages();
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("auto");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const v = await createLocalVoice(name.trim(), language);
      if (description.trim()) await updateLocalVoice(v.id, { description: description.trim() });
      await onCreated(v.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("voiceStudio.pfNew")} onClose={onClose}>
      <div className="space-y-2">
        <Field label={t("localVoice.voiceName")}>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="vs-profile-new-name" />
        </Field>
        <Field label={t("voiceStudio.language")} hint={t("voiceStudio.pfLanguageHint")}>
          <select className="field" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {languages.map((l) => <option key={l} value={l}>{l === "auto" ? t("voiceStudio.langAuto") : l}</option>)}
          </select>
        </Field>
        <Field label={t("voiceStudio.pfDescription")}>
          <textarea className="field min-h-[60px]" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("voiceStudio.pfDescriptionPh")} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost !py-1.5 text-[12.5px]" onClick={onClose}>{t("voiceStudio.cancel")}</button>
          <button className="btn-primary !py-1.5 text-[12.5px]" disabled={busy || !name.trim()} onClick={() => void create()} data-testid="vs-profile-create">
            {t("localVoice.create")}
          </button>
        </div>
        <ErrorLine text={err} />
      </div>
    </Modal>
  );
}

function Profile({ v, onGone, onPick }: { v: LocalVoice; onGone: () => void; onPick: (id: string) => void }) {
  const t = useT();
  const { reloadVoices, openInGenerate, status } = useStudio();
  const languages = useLanguages();
  const [clip, setClip] = useState<ClipSource | null>(null);
  const [recordFor, setRecordFor] = useState<Feeling | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const fileFor = useRef<Feeling>("neutral");
  const byFeeling = useMemo(() => new Map(v.references.map((r) => [r.label, r])), [v.references]);
  const own = !v.builtin;
  const pickFile = (f: Feeling) => {
    fileFor.current = f;
    file.current?.click();
  };
  const duplicate = async () => {
    setErr(null);
    try {
      const d = await duplicateLocalVoice(v.id, t("voiceStudio.pfCopyName", { name: v.name }));
      await reloadVoices();
      onPick(d.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ body: t("localVoice.deleteVoiceConfirm", { name: v.name }), confirmLabel: t("localVoice.deleteVoice"), danger: true }))) return;
    try {
      await deleteLocalVoice(v.id);
      await reloadVoices();
      onGone();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const star = async () => {
    if (!own) return;
    await updateLocalVoice(v.id, { starred: !v.starred }).catch((e) => setErr((e as Error).message));
    await reloadVoices();
  };
  const sttReady = !!status?.gate.ok && !!status?.models.some((m) => m.kind === "stt" && m.installed);
  return (
    <div className="space-y-3" data-testid={`vs-profile-${v.id}`}>
      <Card
        title={
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[15px]">{v.name}</span>
            {v.builtin && <span className="pill border border-accent/30 bg-accent-soft text-accent">{t("localVoice.builtin")}</span>}
            {(v.tags ?? []).map((tag) => (
              <span key={tag} className="pill border border-border bg-surface-3/50 text-content-dim">#{tag}</span>
            ))}
          </span>
        }
        right={
          <div className="flex flex-wrap items-center gap-1">
            {own && (
              <button className="btn-ghost !p-1.5" onClick={() => void star()} title={v.starred ? t("voiceStudio.unstar") : t("voiceStudio.star")} data-testid="vs-profile-star">
                <Icon name="star" size={14} className={v.starred ? "fill-current text-warning" : ""} />
              </button>
            )}
            <button className="btn-primary !py-1 text-[12px]" disabled={!v.references.length && !status?.models.some((m) => m.features.includes("design"))} onClick={() => openInGenerate({ voice_id: v.id })} data-testid="vs-profile-generate">
              <Icon name="sparkles" size={12} /> {t("voiceStudio.pfGenerate")}
            </button>
            <button className="btn-soft !py-1 text-[12px]" onClick={() => void duplicate()} data-testid="vs-profile-duplicate">
              <Icon name="duplicate" size={12} /> {t("voiceStudio.pfDuplicate")}
            </button>
            {own && (
              <button className="btn-ghost !py-1 text-[12px] text-danger" onClick={() => void remove()} data-testid="vs-profile-delete">
                <Icon name="trash" size={12} />
              </button>
            )}
          </div>
        }
      >
        {v.description && <p className="mb-1 text-[12.5px] leading-relaxed text-content-dim">{v.description}</p>}
        {v.rights && <p className="text-[11.5px] text-content-faint">{t("localVoice.rights", { x: v.rights })}</p>}
        {v.builtin && <p className="mt-1 text-[11.5px] text-content-faint">{t("voiceStudio.pfBuiltinHint")}</p>}
        <ErrorLine text={err} />
      </Card>

      <Card title={t("voiceStudio.pfClipsTitle")} testId="vs-profile-clips">
        <p className="mb-2 text-[11.5px] leading-snug text-content-faint">{t("voiceStudio.pfClipsHint")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {FEELINGS.map((f) => (
            <ClipCell
              key={f}
              v={v}
              feeling={f}
              clip={byFeeling.get(f) ?? null}
              fallback={byFeeling.get(f) ? null : (FALLBACK[f] && byFeeling.get(FALLBACK[f]!) ? FALLBACK[f]! : byFeeling.get("neutral") ? "neutral" : null)}
              own={own}
              languages={languages}
              onUpload={() => pickFile(f)}
              onRecord={() => setRecordFor(f)}
              onTrim={(r) => setClip({ kind: "trim", url: refUrl(v, r), voice: v, ref: r })}
              onChange={reloadVoices}
            />
          ))}
        </div>
        <input
          ref={file}
          type="file"
          accept="audio/*,video/*"
          className="hidden"
          data-testid="vs-profile-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setClip({ kind: "new", blob: f, name: f.name, voice: v, feeling: fileFor.current });
            e.target.value = "";
          }}
        />
        {!sttReady && own && <p className="mt-2 text-[11.5px] text-content-faint">{t("voiceStudio.pfNoStt")}</p>}
      </Card>

      {own ? <Details v={v} /> : <BuiltinDetails v={v} />}

      {recordFor && (
        <RecorderModal
          onClose={() => setRecordFor(null)}
          onDone={(blob, name) => {
            const f = recordFor;
            setRecordFor(null);
            setClip({ kind: "new", blob, name, voice: v, feeling: f });
          }}
        />
      )}
      {clip && <ClipModal src={clip} languages={languages} onClose={() => setClip(null)} onSaved={() => void reloadVoices()} />}
    </div>
  );
}

function ClipCell({
  v,
  feeling,
  clip,
  fallback,
  own,
  languages,
  onUpload,
  onRecord,
  onTrim,
  onChange,
}: {
  v: LocalVoice;
  feeling: Feeling;
  clip: VoiceRef | null;
  fallback: Feeling | null;
  own: boolean;
  languages: string[];
  onUpload: () => void;
  onRecord: () => void;
  onTrim: (r: VoiceRef) => void;
  onChange: () => Promise<void>;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(clip?.transcript ?? "");
  const [lang, setLang] = useState(clip?.language ?? "auto");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setText(clip?.transcript ?? "");
    setLang(clip?.language ?? "auto");
  }, [clip?.transcript, clip?.language]);
  const saveText = async () => {
    if (!clip) return;
    setErr(null);
    try {
      await updateVoiceReference(clip.id, { transcript: text.trim(), language: lang });
      setEditing(false);
      await onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = async () => {
    if (!clip) return;
    if (!(await confirmDialog({ body: t("voiceStudio.pfDeleteClipConfirm", { feeling: t(`localVoice.feeling_${feeling}` as MsgKey) }), confirmLabel: t("localVoice.deleteClip"), danger: true }))) return;
    await deleteVoiceReference(clip.id).catch((e) => setErr((e as Error).message));
    await onChange();
  };
  const name = t(`localVoice.feeling_${feeling}` as MsgKey);
  return (
    <div className={`rounded-lg border p-2.5 ${clip ? "border-border/70 bg-surface/50" : "border-dashed border-border/70 bg-surface/20"}`} data-testid={`vs-clip-${feeling}`} data-has={!!clip}>
      <div className="flex items-center gap-1.5">
        <FeelingDot feeling={feeling} size={9} />
        <span className="text-[12.5px] font-medium text-content">{name}</span>
        {clip && <span className="text-[11px] tabular-nums text-content-faint">{secs(clip.duration)}</span>}
        <span className="flex-1" />
        {own && (
          <>
            <button className="btn-ghost !p-1" onClick={onUpload} title={clip ? t("voiceStudio.pfReplaceFile") : t("voiceStudio.pfUpload")} data-testid={`vs-clip-upload-${feeling}`}>
              <Icon name="upload" size={12} />
            </button>
            <button className="btn-ghost !p-1" onClick={onRecord} title={t("voiceStudio.pfRecord")} data-testid={`vs-clip-record-${feeling}`}>
              <Icon name="mic" size={12} />
            </button>
          </>
        )}
        {own && clip && (
          <>
            <button className="btn-ghost !p-1" onClick={() => onTrim(clip)} title={t("voiceStudio.clipTrim")} data-testid={`vs-clip-trim-${feeling}`}>
              <Icon name="scissors" size={12} />
            </button>
            <button className="btn-ghost !p-1 hover:text-danger" onClick={() => void remove()} title={t("localVoice.deleteClip")} data-testid={`vs-clip-delete-${feeling}`}>
              <Icon name="x" size={12} />
            </button>
          </>
        )}
      </div>
      {clip ? (
        <>
          <div className="mt-1.5 flex items-center gap-2">
            <PlayButton url={refUrl(v, clip)} small testId={`vs-clip-play-${feeling}`} />
            <div className="min-w-0 flex-1">
              <Waveform url={refUrl(v, clip)} height={30} bars={80} />
            </div>
          </div>
          {editing ? (
            <div className="mt-1.5 space-y-1.5">
              <textarea className="field min-h-[48px] text-[12px]" value={text} onChange={(e) => setText(e.target.value)} data-testid={`vs-clip-text-${feeling}`} />
              <div className="flex items-center gap-1.5">
                <select className="field !w-auto !py-1 text-[12px]" value={lang} onChange={(e) => setLang(e.target.value)}>
                  {languages.map((l) => <option key={l} value={l}>{l === "auto" ? t("voiceStudio.langAuto") : l}</option>)}
                </select>
                <span className="flex-1" />
                <button className="btn-ghost !py-0.5 text-[11.5px]" onClick={() => setEditing(false)}>{t("voiceStudio.cancel")}</button>
                <button className="btn-soft !py-0.5 text-[11.5px]" onClick={() => void saveText()} data-testid={`vs-clip-text-save-${feeling}`}>{t("voiceStudio.save")}</button>
              </div>
            </div>
          ) : (
            <p
              className={`mt-1.5 text-[12px] leading-snug ${clip.transcript ? "text-content" : "text-warning"} ${own ? "cursor-text hover:bg-surface-3/40" : ""} rounded px-0.5`}
              onClick={() => own && setEditing(true)}
              title={own ? t("voiceStudio.pfEditText") : undefined}
            >
              {clip.transcript || t("voiceStudio.pfNoText")}
              <span className="ml-1 text-[11px] text-content-faint">· {clip.language === "auto" ? t("voiceStudio.langAuto") : clip.language}</span>
            </p>
          )}
          {(clip.stats?.warnings ?? []).length > 0 && (
            <p className="mt-1 text-[11px] text-warning">{(clip.stats?.warnings ?? []).map((w) => t(`localVoice.warn_${w}` as MsgKey)).join(" · ")}</p>
          )}
        </>
      ) : (
        <p className="mt-1.5 text-[11.5px] text-content-faint">
          {fallback ? t("voiceStudio.pfFallback", { feeling: t(`localVoice.feeling_${fallback}` as MsgKey) }) : t("voiceStudio.pfEmpty")}
        </p>
      )}
      <ErrorLine text={err} />
    </div>
  );
}

/** a user's profile: what it says about itself and what its lines start from */
function Details({ v }: { v: LocalVoice }) {
  const t = useT();
  const { status, reloadVoices } = useStudio();
  const languages = useLanguages();
  const tts = (status?.models ?? []).filter((m) => m.kind === "tts" && m.installed);
  const initial = (): VoicePatch => ({
    name: v.name,
    description: v.description ?? "",
    language: v.language,
    instruct: v.instruct,
    tags: v.tags ?? [],
    default_model: v.default_model ?? "",
    default_params: v.default_params ?? {},
  });
  const [form, setForm] = useState<VoicePatch>(initial);
  const [tags, setTags] = useState((v.tags ?? []).join(", "));
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const model = tts.find((m) => m.id === form.default_model);
  const patch = (p: VoicePatch) => {
    setOk(false);
    setForm((f) => ({ ...f, ...p }));
  };
  const dirty = JSON.stringify({ ...form, tags: splitTags(tags) }) !== JSON.stringify(initial());
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await updateLocalVoice(v.id, { ...form, tags: splitTags(tags) });
      await reloadVoices();
      setOk(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t("voiceStudio.pfDetails")} testId="vs-profile-details">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={t("localVoice.voiceName")}>
          <input className="field" value={form.name} onChange={(e) => patch({ name: e.target.value })} data-testid="vs-profile-name" />
        </Field>
        <Field label={t("voiceStudio.language")} hint={t("voiceStudio.pfLanguageHint")}>
          <select className="field" value={form.language} onChange={(e) => patch({ language: e.target.value })}>
            {languages.map((l) => <option key={l} value={l}>{l === "auto" ? t("voiceStudio.langAuto") : l}</option>)}
          </select>
        </Field>
      </div>
      <div className="mt-2 space-y-2">
        <Field label={t("voiceStudio.pfDescription")}>
          <textarea className="field min-h-[56px]" value={form.description} onChange={(e) => patch({ description: e.target.value })} placeholder={t("voiceStudio.pfDescriptionPh")} data-testid="vs-profile-description" />
        </Field>
        <Field label={t("voiceStudio.pfTags")} hint={t("voiceStudio.pfTagsHint")}>
          <input className="field" value={tags} onChange={(e) => (setOk(false), setTags(e.target.value))} data-testid="vs-profile-tags" />
        </Field>
        <Field label={t("voiceStudio.pfInstruct")} hint={t("voiceStudio.pfInstructHint")}>
          <input className="field" value={form.instruct} onChange={(e) => patch({ instruct: e.target.value })} placeholder={t("localVoice.tryInstructPh")} data-testid="vs-profile-instruct" />
        </Field>
        <Field label={t("voiceStudio.pfModel")} hint={t("voiceStudio.pfModelHint")}>
          <select className="field" value={form.default_model} onChange={(e) => patch({ default_model: e.target.value, default_params: {} })} data-testid="vs-profile-model">
            <option value="">{t("voiceStudio.pfModelAny")}</option>
            {tts.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            {form.default_model && !model && <option value={form.default_model}>{form.default_model}</option>}
          </select>
        </Field>
        {model && model.params.length > 0 && (
          <div className="rounded-lg border border-border/60 bg-surface/40 p-2.5">
            <div className="mb-2 flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[12px] text-content-dim">{t("voiceStudio.pfParams", { model: model.name })}</span>
              {model.params.some((p) => p.advanced) && (
                <label className="flex items-center gap-1.5 text-[11.5px] text-content-dim">
                  <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
                  {t("voiceStudio.advanced")}
                </label>
              )}
            </div>
            <ParamControls params={model.params} values={form.default_params ?? {}} onChange={(p) => patch({ default_params: p })} showAdvanced={advanced} testId="vs-profile-param" />
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button className="btn-primary !py-1.5 text-[12.5px]" disabled={busy || !dirty || !form.name?.trim()} onClick={() => void save()} data-testid="vs-profile-save">
          {busy ? <Icon name="spinner" size={12} spin /> : null} {t("voiceStudio.save")}
        </button>
        {ok && !dirty && <span className="text-[11.5px] text-success">{t("voiceStudio.saved")}</span>}
      </div>
      <ErrorLine text={err} />
    </Card>
  );
}

function BuiltinDetails({ v }: { v: LocalVoice }) {
  const t = useT();
  return (
    <Card title={t("voiceStudio.pfDetails")}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-content-faint">{t("voiceStudio.language")}</dt>
        <dd className="text-content">{v.language === "auto" ? t("voiceStudio.langAuto") : v.language}</dd>
        {v.default_model && (
          <>
            <dt className="text-content-faint">{t("voiceStudio.pfModel")}</dt>
            <dd className="text-content">{v.default_model}</dd>
          </>
        )}
        {v.instruct && (
          <>
            <dt className="text-content-faint">{t("voiceStudio.pfInstruct")}</dt>
            <dd className="text-content">{v.instruct}</dd>
          </>
        )}
        {v.source && (
          <>
            <dt className="text-content-faint">{t("voiceStudio.pfSource")}</dt>
            <dd className="break-all text-content">{v.source}</dd>
          </>
        )}
      </dl>
    </Card>
  );
}

const splitTags = (s: string) =>
  s
    .split(/[,#\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 20);
