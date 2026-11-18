/**
 * Voice Studio → 프로필 → 웃음·하품: the laughs put into a line of this voice where it laughs (헤헤, ㅋㅋ, 하하) — no
 * model laughs inside a line, trained or not — its own clips (recorded or uploaded: label laugh / yawn), a built-in
 * voice's, and the ones each model made in its voice (the best of 16 takes, as an AudioSet classifier hears them; a line
 * takes its own model's first: backend app/voicehost/sounds.py, docs/local-voice.md "Laughs, sighs and yawns").
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  addVoiceReference,
  deleteVoiceReference,
  forgetVoiceSounds,
  getVoiceSounds,
  makeVoiceSounds,
  voiceSoundUrl,
  type LocalVoice,
  type SoundLabel,
  type VoiceSounds,
} from "../../api/voice";
import { useT, type MsgKey } from "../../i18n";
import { confirmDialog } from "../ui/ConfirmDialog";
import Icon from "../ui/Icon";
import { ErrorLine } from "../mate/settings/ui";
import { RecorderModal } from "./clips";
import { Card, PlayButton, readableAudio, refUrl, secs, useModelName, Waveform } from "./shared";

export function SoundsCard({ v, own, onChange }: { v: LocalVoice; own: boolean; onChange: () => Promise<void> }) {
  const t = useT();
  const modelName = useModelName();
  const [doc, setDoc] = useState<VoiceSounds | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // (the model a laugh is being made with)
  const [err, setErr] = useState<string | null>(null);
  const [recordFor, setRecordFor] = useState<SoundLabel | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const fileFor = useRef<SoundLabel>("laugh");
  const load = useCallback(() => {
    getVoiceSounds(v.id).then(setDoc, () => setDoc(null));
  }, [v.id]);
  useEffect(load, [load, v.sounds.length]);
  // (being made in the background: looked at again until it is done)
  useEffect(() => {
    if (!doc?.making) return;
    const id = setTimeout(load, 3000);
    return () => clearTimeout(id);
  }, [doc, load]);

  const make = async (model: string) => {
    setBusy(model);
    setErr(null);
    try {
      setDoc(await makeVoiceSounds(v.id, model));
    } catch (e) {
      const code = (e as { code?: string }).code;
      setErr(code === "no_laugh" ? t("voiceStudio.sdNoLaugh") : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const forget = async () => {
    setErr(null);
    setDoc(await forgetVoiceSounds(v.id).catch((e) => (setErr((e as Error).message), doc)));
  };
  const upload = async (label: SoundLabel, blob: Blob, name: string) => {
    setErr(null);
    try {
      const a = await readableAudio(blob, name);
      await addVoiceReference(v.id, a.blob, label, "", a.name);
      await onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = async (rid: string) => {
    if (!(await confirmDialog({ body: t("voiceStudio.sdDeleteConfirm"), confirmLabel: t("voiceStudio.sdForget"), danger: true }))) return;
    await deleteVoiceReference(rid).catch((e) => setErr((e as Error).message));
    await onChange();
  };

  const made = (doc?.made ?? []).filter((m) => (m.kinds.laugh ?? []).length);
  const none = !v.sounds.length && !made.length;
  const makers = doc?.makers ?? [];
  return (
    <Card title={t("voiceStudio.sdTitle")} testId="vs-profile-sounds">
      <p className="mb-2 text-[11.5px] leading-snug text-content-faint">{t("voiceStudio.sdHint")}</p>

      {v.sounds.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 text-[11.5px] font-medium text-content-dim">{own ? t("voiceStudio.sdOwn") : t("voiceStudio.sdBuiltin", { model: modelName("omnivoice") })}</div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {v.sounds.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded-lg border border-border/70 bg-surface/50 px-2 py-1.5" data-testid={`vs-sound-own-${r.label}`}>
                <PlayButton url={refUrl(v, r)} small />
                <div className="min-w-0 flex-1">
                  <Waveform url={refUrl(v, r)} height={24} bars={50} />
                </div>
                <span className="text-[11px] text-content-faint">
                  {t(`voiceStudio.nvKind_${r.label}` as MsgKey)} {r.duration ? secs(r.duration) : ""}
                </span>
                {own && (
                  <button className="btn-ghost !p-1 hover:text-danger" onClick={() => void remove(r.id)} title={t("voiceStudio.sdForget")}>
                    <Icon name="x" size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {made.map((m) => (
        <div key={m.id} className="mb-2" data-testid="vs-sound-made" data-model={m.model_id}>
          <div className="mb-1 text-[11.5px] font-medium text-content-dim">
            {t(m.adapter ? "voiceStudio.sdMadeTrained" : "voiceStudio.sdMade", { model: modelName(m.model_id) })}
          </div>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {(m.kinds.laugh ?? []).map((name) => {
              const score = m.scores[name];
              return (
                <div key={name} className="flex items-center gap-2 rounded-lg border border-border/70 bg-surface/50 px-2 py-1.5">
                  <PlayButton url={`${voiceSoundUrl(v.id, name, m.id)}&t=${m.made_at ?? 0}`} small testId={`vs-sound-play-${m.model_id}-${name}`} />
                  <span className="text-[11px] tabular-nums text-content-faint">
                    {score != null ? t("voiceStudio.sdScore", { n: Math.round(score * 100) }) : t("voiceStudio.sdUnchecked")}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {none && !doc?.making && (
        <p className="mb-2 text-[12px] text-content-dim" data-testid="vs-sound-none">
          {doc?.auto && doc.maker ? t("voiceStudio.sdNoneAuto") : t("voiceStudio.sdNone")}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {/* (with each model that laughs on its own: its laugh goes into its own lines) */}
        {makers.map((model) => {
          const has = made.some((m) => m.model_id === model);
          return (
            <button key={model} className="btn-soft !py-1 text-[12px]" disabled={!!busy || !!doc?.making} onClick={() => void make(model)} data-testid={`vs-sound-make-${model}`}>
              {busy === model || (doc?.making && !busy) ? <Icon name="spinner" size={12} spin /> : <Icon name="sparkles" size={12} />}
              {busy === model ? t("voiceStudio.sdMaking") : t(has ? "voiceStudio.sdRemakeWith" : "voiceStudio.sdMakeWith", { model: modelName(model) })}
            </button>
          );
        })}
        {doc && !makers.length && <span className="text-[11.5px] text-content-faint">{t("voiceStudio.sdNoMaker")}</span>}
        {made.length > 0 && !busy && (
          <button className="btn-ghost !py-1 text-[12px] text-danger" onClick={() => void forget()} data-testid="vs-sound-forget">
            <Icon name="trash" size={12} /> {t("voiceStudio.sdForget")}
          </button>
        )}
        {own && (
          <>
            <span className="flex-1" />
            {(["laugh", "yawn"] as SoundLabel[]).map((label) => (
              <span key={label} className="flex items-center gap-0.5 rounded-lg border border-border/70 px-1.5 py-0.5 text-[11.5px] text-content-dim">
                {t(label === "laugh" ? "voiceStudio.sdAddLaugh" : "voiceStudio.sdAddYawn")}
                <button className="btn-ghost !p-1" onClick={() => setRecordFor(label)} title={t("voiceStudio.pfRecord")} data-testid={`vs-sound-record-${label}`}>
                  <Icon name="mic" size={12} />
                </button>
                <button
                  className="btn-ghost !p-1"
                  onClick={() => {
                    fileFor.current = label;
                    file.current?.click();
                  }}
                  title={t("voiceStudio.pfUpload")}
                  data-testid={`vs-sound-upload-${label}`}
                >
                  <Icon name="upload" size={12} />
                </button>
              </span>
            ))}
          </>
        )}
      </div>
      {own && <p className="mt-1.5 text-[11px] leading-snug text-content-faint">{t("voiceStudio.sdAddHint")}</p>}
      <p className="mt-1 text-[11px] leading-snug text-content-faint">{t("voiceStudio.sdYawnNote")}</p>
      <ErrorLine text={err} />
      <input
        ref={file}
        type="file"
        accept="audio/*,video/*"
        className="hidden"
        data-testid="vs-sound-file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(fileFor.current, f, f.name);
          e.target.value = "";
        }}
      />
      {recordFor && (
        <RecorderModal
          onClose={() => setRecordFor(null)}
          onDone={(blob, name) => {
            const label = recordFor;
            setRecordFor(null);
            void upload(label, blob, name);
          }}
        />
      )}
    </Card>
  );
}
