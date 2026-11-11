/**
 * The Mate Create studio's right side (docs/avatar-create.md §11): the settings of the mate being made, live —
 * Concept · Profile · Conversation style · Avatar · Voice · Language model — the same settings as Mate settings, each
 * field saving itself. Fields the agent filled glow and carry a badge with Undo; the user can edit any of them (the
 * agent hears what changed before its next turn). The Voice and Language model sections are the Mate settings tabs
 * themselves; the Avatar section is the avatar project (estimate, checkpoints, progress, what was made, the player).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { broughtAvatar, CONCEPT_KEYS, type AvatarEnv, type AvatarProject, type ConceptKey, type StudioInfo } from "../../../api/avatar";
import { fillAddress, importAvatarZip, prefsOf, type Mate } from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";
import { addressForms, isBareKoreanName } from "../../../lib/josa";
import { MateAvatar } from "../../../mate/avatar/MateAvatar";
import type { MateConversation } from "../../../mate/useMateConversation";
import { useT, type MsgKey } from "../../../i18n";
import Icon, { type IconName } from "../../ui/Icon";
import AvatarPanel, { type Act } from "../avatar/AvatarPanel";
import ModelTab from "../settings/ModelTab";
import VoiceTab from "../settings/VoiceTab";
import { AutoText, Choice, FieldFrame, FieldsCtx, swatchesOf, type FieldsApi } from "./fields";

export type SectionId = "concept" | "profile" | "style" | "avatar" | "voice" | "model";

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
  ["vi", "Tiếng Việt"],
];

// (who she is → Profile; how she talks — the conversation style, the reply language with it → Conversation style)
const SECTION_OF_PATH = (path: string): SectionId =>
  path.startsWith("concept.") ? "concept" : path.startsWith("prefs.") || path === "persona.language" ? "style" : "profile";

function Section({ id, title, icon, open, onToggle, summary, filled, children, right }: {
  id: SectionId;
  title: string;
  icon: IconName;
  open: boolean;
  onToggle: () => void;
  summary?: ReactNode;
  filled: number;
  children: ReactNode;
  right?: ReactNode;
}) {
  const t = useT();
  return (
    <section className={`scroll-mt-3 rounded-2xl border bg-surface-2/50 transition-colors ${open ? "border-border" : "border-border/70"}`} data-testid={`studio-section-${id}`} data-open={open ? "1" : "0"} id={`studio-${id}`}>
      <div className="flex items-center gap-2 px-4 py-3">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={onToggle} aria-expanded={open} data-testid={`studio-section-toggle-${id}`}>
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-3 text-content-dim">
            <Icon name={icon} size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-semibold text-content">{title}</span>
            {!open && summary && <span className="block truncate text-[11.5px] text-content-faint">{summary}</span>}
          </span>
          {filled > 0 && (
            <span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-[10.5px] font-medium text-success" data-testid={`studio-section-filled-${id}`}>
              {t("studio.sectionFilled", { count: filled })}
            </span>
          )}
          <Icon name="chevron-down" size={14} className={`shrink-0 text-content-faint transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {right}
      </div>
      {open && <div className="space-y-4 border-t border-border/60 px-4 pb-4 pt-3.5 animate-fade-in">{children}</div>}
    </section>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-content-faint">{title}</h4>
      {children}
    </div>
  );
}

/** Concept: the pitch, who she is to the user, the voice character and the visual concept */
function ConceptSection({ studio }: { studio: StudioInfo }) {
  const t = useT();
  const c = studio.concept;
  const v = (k: ConceptKey) => c[k] ?? "";
  const [palette, setPalette] = useState(v("palette"));
  useEffect(() => setPalette(v("palette")), [c.palette]); // eslint-disable-line react-hooks/exhaustive-deps
  const sw = swatchesOf(palette);
  const text = (k: ConceptKey, rows = 0, ph?: string) => (
    <FieldFrame path={`concept.${k}`} label={t(`studio.f_concept_${k}` as MsgKey)}>
      <AutoText path={`concept.${k}`} value={v(k)} multiline={rows > 0} rows={rows} maxLength={600} placeholder={ph} testId={`studio-concept-${k}`} onLocal={k === "palette" ? setPalette : undefined} />
    </FieldFrame>
  );
  return (
    <>
      {text("pitch", 2, t("studio.conceptPitchPh"))}
      <div className="grid gap-3 sm:grid-cols-2">
        {text("role", 0, t("studio.conceptRolePh"))}
        {text("interests", 0, t("studio.conceptInterestsPh"))}
      </div>
      {text("backstory", 3)}
      <Group title={t("studio.conceptVisual")}>
        <div className="grid gap-3 sm:grid-cols-2">
          {text("style", 0, t("studio.conceptStylePh"))}
          {text("mood", 0, t("studio.conceptMoodPh"))}
        </div>
        {text("look", 2)}
        {text("outfit", 0)}
        {text("palette", 0, t("studio.conceptPalettePh"))}
        {sw.length > 0 && (
          <div className="flex gap-1.5" aria-hidden data-testid="studio-palette">
            {sw.map((x) => (
              <span key={x} className="h-6 w-10 rounded-md ring-1 ring-border" style={{ background: x }} title={x} />
            ))}
          </div>
        )}
      </Group>
      {text("voice", 0, t("studio.conceptVoicePh"))}
    </>
  );
}

function ProfileSection({ mate }: { mate: Mate }) {
  const t = useT();
  const p = mate.persona;
  const [more, setMore] = useState(!!p.instructions);
  return (
    <>
      <FieldFrame path="name" label={t("mateSettings.profName")}>
        <AutoText path="name" value={mate.name} maxLength={40} placeholder={t("studio.namePh")} testId="studio-name" />
      </FieldFrame>
      <FieldFrame path="persona.description" label={t("mateSettings.profDescription")} hint={t("studio.descriptionHint")}>
        <AutoText path="persona.description" value={p.description} multiline rows={4} placeholder={t("mateSettings.profDescriptionPh")} testId="studio-persona-description" />
      </FieldFrame>
      <FieldFrame path="persona.personality" label={t("mateSettings.profPersonality")}>
        <AutoText path="persona.personality" value={p.personality} multiline rows={2} placeholder={t("mateSettings.profPersonalityPh")} testId="studio-persona-personality" />
      </FieldFrame>
      <FieldFrame path="persona.greeting" label={t("mateSettings.profGreeting")} hint={t("mateSettings.profGreetingHint")}>
        <AutoText path="persona.greeting" value={p.greeting} multiline rows={2} testId="studio-persona-greeting" />
      </FieldFrame>
      {more ? (
        <FieldFrame path="persona.instructions" label={t("mateSettings.profInstructions")} hint={t("mateSettings.profInstructionsHint")}>
          <AutoText path="persona.instructions" value={p.instructions} multiline rows={3} placeholder={t("mateSettings.profInstructionsPh")} testId="studio-persona-instructions" />
        </FieldFrame>
      ) : (
        <button type="button" className="btn-ghost !px-2 text-[12px]" onClick={() => setMore(true)}>
          <Icon name="plus" size={12} /> {t("mateSettings.profInstructions")}
        </button>
      )}
    </>
  );
}

/** the studio's save function for controls that aren't AutoText */
function FieldsSave({ children }: { children: (save: FieldsApi["save"]) => ReactNode }) {
  return <FieldsCtx.Consumer>{(api) => children(api ? api.save : async () => {})}</FieldsCtx.Consumer>;
}

function StyleSection({ mate }: { mate: Mate }) {
  const t = useT();
  const p = prefsOf(mate);
  const lang = mate.persona.language;
  const [address, setAddress] = useState(p.address);
  const [userName, setUserName] = useState(p.user_name);
  useEffect(() => setAddress(p.address), [p.address]);
  useEffect(() => setUserName(p.user_name), [p.user_name]);
  const korean = (lang || "ko").toLowerCase().startsWith("ko");
  const nm = userName.trim();
  const chips = nm ? (korean ? [`${nm}님`, `${nm} 씨`, nm, "주인님"] : [nm, "boss"]) : korean ? ["주인님", "사장님", "선배"] : ["boss"];
  const level = (p.formality !== "auto" ? p.formality : p.defaults.formality) || "";
  const forms = korean ? addressForms(address, level === "banmal" && isBareKoreanName(address, nm)) : null;
  const known = LANGS.some(([c]) => c === lang);
  const charAddress = p.defaults.address ? fillAddress(p.defaults.address, userName, t("mateSettings.styleNamePh")) : "";
  const charLevel = ({ haeyo: "mateSettings.styleHaeyo", hapsyo: "mateSettings.styleHapsyo", banmal: "mateSettings.styleBanmal" } as Record<string, MsgKey>)[p.defaults.formality];
  const tone = (k: "warmth" | "humor" | "initiative", low: MsgKey, high: MsgKey) => (
    <FieldFrame as="div" path={`prefs.tone.${k}`} label={t(`mateSettings.style${k[0].toUpperCase()}${k.slice(1)}` as MsgKey)}>
      <Choice
        path={`prefs.tone.${k}`}
        value={p.tone[k]}
        options={[
          { id: "low", label: t(low) },
          { id: "auto", label: t("mateSettings.styleAsWritten") },
          { id: "high", label: t(high) },
        ]}
        testId={`studio-tone-${k}`}
      />
    </FieldFrame>
  );
  return (
    <FieldsSave>
      {(save) => (
    <>
      <Group title={t("mateSettings.styleCallGroup")}>
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldFrame path="prefs.user_name" label={t("mateSettings.profUserName")}>
            <AutoText path="prefs.user_name" value={p.user_name} maxLength={40} placeholder={t("mateSettings.profUserNamePh")} testId="studio-user-name" onLocal={setUserName} />
          </FieldFrame>
          <FieldFrame path="prefs.self_ref" label={t("mateSettings.profSelfRef")}>
            <AutoText path="prefs.self_ref" value={p.self_ref} maxLength={40} placeholder={t("mateSettings.profSelfRefPh")} testId="studio-self-ref" />
          </FieldFrame>
        </div>
        <FieldFrame path="prefs.address" label={t("mateSettings.profCallsYou")} hint={charAddress ? t("mateSettings.styleCallsYouHint", { value: charAddress }) : t("mateSettings.profCallsYouHint")}>
          <AutoText path="prefs.address" value={p.address} maxLength={40} placeholder={charAddress || t("mateSettings.profCallsYouPh")} testId="studio-address" onLocal={setAddress} />
        </FieldFrame>
        <div className="flex flex-wrap gap-1.5" data-testid="studio-address-chips">
          {chips.map((c) => (
            <button
              key={c}
              type="button"
              className={`rounded-full border px-2.5 py-0.5 text-[12px] ${address === c ? "border-accent bg-accent-soft text-content" : "border-border text-content-dim hover:bg-surface-3"}`}
              onClick={() => {
                setAddress(c);
                void save("prefs.address", c);
              }}
            >
              {c}
            </button>
          ))}
        </div>
        {forms && (
          <p className="rounded-lg bg-surface/70 px-2.5 py-1.5 text-[11.5px] text-content-faint" data-testid="studio-address-forms">
            {t("mateSettings.profForms", { forms: [forms.subject, forms.topic, forms.object, forms.with, forms.to].filter(Boolean).join(" · "), call: forms.call })}
          </p>
        )}
      </Group>
      <FieldFrame path="persona.language" label={t("mateSettings.profReplyLang")}>
        <select className="field" value={known ? lang : "__other"} onChange={(e) => e.target.value !== "__other" && void save("persona.language", e.target.value)} data-testid="studio-language">
          {LANGS.map(([c, l]) => (
            <option key={c} value={c}>
              {l}
            </option>
          ))}
          {!known && <option value="__other">{lang || "—"}</option>}
        </select>
      </FieldFrame>
      <FieldFrame as="div" path="prefs.formality" label={t("mateSettings.styleFormality")} hint={t("mateSettings.styleFormalityHint")}>
        <Choice
          path="prefs.formality"
          value={p.formality}
          options={[
            { id: "auto", label: charLevel ? t("mateSettings.styleAsCharacter", { level: t(charLevel) }) : t("mateSettings.styleAsWritten") },
            { id: "haeyo", label: t("mateSettings.styleHaeyo") },
            { id: "hapsyo", label: t("mateSettings.styleHapsyo") },
            { id: "banmal", label: t("mateSettings.styleBanmal") },
          ]}
          testId="studio-formality"
        />
      </FieldFrame>
      <FieldFrame path="prefs.speech_style" label={t("mateSettings.styleHabits")} hint={t("mateSettings.styleHabitsHint")}>
        <AutoText path="prefs.speech_style" value={p.speech_style} multiline rows={3} maxLength={2000} placeholder={t("mateSettings.styleHabitsPh")} testId="studio-speech-style" />
      </FieldFrame>
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldFrame as="div" path="prefs.length" label={t("mateSettings.styleLength")}>
          <Choice
            path="prefs.length"
            value={p.length}
            options={[
              { id: "short", label: t("mateSettings.styleShort") },
              { id: "normal", label: t("mateSettings.styleNormal") },
              { id: "long", label: t("mateSettings.styleLong") },
            ]}
            testId="studio-length"
          />
        </FieldFrame>
        <FieldFrame as="div" path="prefs.emotion" label={t("mateSettings.styleEmotion")}>
          <Choice
            path="prefs.emotion"
            value={p.emotion}
            options={[
              { id: 0, label: t("mateSettings.styleEmoOff") },
              { id: 1, label: t("mateSettings.styleEmoSubtle") },
              { id: 2, label: t("mateSettings.styleNormal") },
              { id: 3, label: t("mateSettings.styleEmoExpressive") },
            ]}
            testId="studio-emotion"
          />
        </FieldFrame>
      </div>
      {tone("warmth", "mateSettings.styleWarmthLow", "mateSettings.styleWarmthHigh")}
      {tone("humor", "mateSettings.styleHumorLow", "mateSettings.styleHumorHigh")}
      {tone("initiative", "mateSettings.styleInitiativeLow", "mateSettings.styleInitiativeHigh")}
      <FieldFrame path="prefs.avoid" label={t("mateSettings.styleAvoid")} hint={t("mateSettings.styleAvoidHint")}>
        <AutoText path="prefs.avoid" value={p.avoid} multiline rows={2} maxLength={500} placeholder={t("mateSettings.styleAvoidPh")} testId="studio-avoid" />
      </FieldFrame>
    </>
      )}
    </FieldsSave>
  );
}

/** her avatar from a file the user has (a Live2D model, a LivLiv package or a video/photo pack in a zip, the same
 *  import as Mate settings → Avatar): it goes on her at once, and the agent sees what it has (studio.avatar) */
function BringAvatar({ mate, pid }: { mate: Mate; pid: string }) {
  const t = useT();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const take = async (f: File) => {
    setBusy(true);
    setErr(null);
    try {
      useMateStore.getState().upsert((await importAvatarZip(mate.id, f)).mate);
      void broughtAvatar(pid).catch(() => {}); // (the agent answers to it: maps a model's expressions to her emotions)
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  return (
    <div className="mt-1.5">
      <input ref={file} type="file" accept=".zip,.livliv,application/zip" hidden onChange={(e) => e.target.files?.[0] && void take(e.target.files[0])} data-testid="studio-avatar-file" />
      <button type="button" className="btn-ghost !px-2 !py-1 text-[12px]" disabled={busy} onClick={() => file.current?.click()} title={t("studio.avatarBringHint")} data-testid="studio-avatar-bring">
        <Icon name={busy ? "spinner" : "upload"} size={12} spin={busy} /> {t("studio.avatarBring")}
      </button>
      {err && <p className="mt-1 text-[11.5px] text-danger" data-testid="studio-avatar-bring-error">{err}</p>}
    </div>
  );
}

/** a Live2D model's / LivLiv package's expressions that answer to her emotions (the agent maps them; Mate settings →
 *  Avatar changes them) */
function EmotionMap({ mate }: { mate: Mate }) {
  const t = useT();
  const a = mate.avatar;
  const map = a.kind === "live2d" ? a.live2d.emotions : a.kind === "livliv" ? a.livliv.emotions : undefined;
  if (a.kind !== "live2d" && a.kind !== "livliv") return null;
  const pairs = Object.entries(map || {}).filter(([, v]) => v !== "" && v !== undefined && v !== null);
  return (
    <div className="mt-1.5" data-testid="studio-emotion-map">
      <p className="text-[11px] text-content-faint">{pairs.length ? t("studio.emotionMap") : t("studio.emotionMapNone")}</p>
      {pairs.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {pairs.map(([emotion, expression]) => (
            <span key={emotion} className="rounded-full border border-border/70 px-2 py-[1px] text-[11px] text-content-dim">
              {emotion} → {String(expression)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** before the avatar is ready: what she looks like now (or an empty stage of the same size — no jump later) */
function AvatarStage({ project, mate, kind, onSkip }: { project: AvatarProject; mate: Mate; kind: "new" | "existing"; onSkip?: (skip: boolean) => void }) {
  const t = useT();
  const ready = !!project.preview && (project.status === "ready" || project.status === "applied");
  if (ready) return null;
  const has = mate.avatar.kind !== "none";
  const skipped = !!project.studio?.avatar_skipped;
  const live = project.status === "running" || project.status === "waiting" || project.status === "paused";
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border/70 bg-[radial-gradient(ellipse_at_50%_100%,rgb(var(--c-surface-3)),transparent_75%)] p-3" data-testid="studio-avatar-stage">
      <div className="relative h-[132px] w-[104px] shrink-0 overflow-hidden rounded-lg bg-surface-3/60">
        {has ? (
          <MateAvatar avatar={mate.avatar} name={mate.name || "?"} size="sm" mood="idle" className="h-full w-full" />
        ) : project.files.home ? (
          <img src={project.files.home} alt="" className="h-full w-full object-cover object-top" />
        ) : (
          <div className="grid h-full w-full place-items-center text-content-faint">
            <Icon name="user" size={30} />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-content-dim">
        <p className="font-medium text-content">
          {skipped ? t("studio.avatarSkipped") : live ? t("studio.avatarMaking") : has ? t("studio.avatarCurrent") : t("studio.avatarNone")}
        </p>
        <p className="mt-0.5 text-[11.5px] text-content-faint">{skipped ? t("studio.avatarSkippedHint") : live ? t("studio.avatarMakingHint") : project.outfit ? t("studio.outfitStageHint") : kind === "existing" ? t("studio.avatarCurrentHint") : t("studio.avatarNoneHint")}</p>
        {kind === "new" && onSkip && !project.confirmation && (
          <button type="button" className="btn-ghost mt-1.5 !px-2 !py-1 text-[12px]" onClick={() => onSkip(!skipped)} data-testid="studio-skip-avatar">
            <Icon name={skipped ? "sparkles" : "x"} size={12} /> {skipped ? t("studio.avatarUnskip") : t("studio.avatarSkip")}
          </button>
        )}
        {!live && !project.outfit && <BringAvatar mate={mate} pid={project.id} />}
        <EmotionMap mate={mate} />
      </div>
    </div>
  );
}

export default function StudioSettings({ project, mate, env, act, reloadEnv, conv, api, focus, creating, onVoiceTested, onSkip, saving }: {
  project: AvatarProject;
  /** a new mate still being made (else: an existing mate's avatar — or a created one's) */
  creating: boolean;
  mate: Mate;
  env: AvatarEnv | null;
  act: Act;
  reloadEnv: () => void;
  conv: MateConversation;
  api: FieldsApi;
  /** open and show this section (a step or a "filled in" card was clicked) */
  focus: { id: SectionId; n: number } | null;
  onVoiceTested: () => void;
  onSkip: (skip: boolean) => void;
  saving: { busy: boolean; error: string | null };
}) {
  const t = useT();
  const studio = project.studio as StudioInfo;
  const kind = creating ? "new" : "existing";
  const [open, setOpen] = useState<Record<SectionId, boolean>>(() =>
    kind === "new"
      ? { concept: true, profile: true, style: false, avatar: project.status !== "interview", voice: false, model: false }
      : { concept: false, profile: false, style: false, avatar: true, voice: false, model: false },
  );
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    setOpen((o) => ({ ...o, [focus.id]: true }));
    const el = root.current?.querySelector(`#studio-${focus.id}`);
    setTimeout(() => el?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  }, [focus]);
  // the agent filled something in a closed section: it opens (the user sees it fill)
  const filledBy = useMemo(() => {
    const out: Record<SectionId, number> = { concept: 0, profile: 0, style: 0, avatar: 0, voice: 0, model: 0 };
    for (const k of Object.keys(studio.filled)) out[SECTION_OF_PATH(k)]++;
    return out;
  }, [studio.filled]);
  const lastFill = useMemo(() => Object.values(studio.filled).reduce((m, e) => (e.at > m ? e.at : m), ""), [studio.filled]);
  const seenFill = useRef(lastFill);
  useEffect(() => {
    if (lastFill && lastFill !== seenFill.current) {
      seenFill.current = lastFill;
      const sections = new Set(Object.entries(studio.filled).filter(([, e]) => e.at === lastFill).map(([k]) => SECTION_OF_PATH(k)));
      setOpen((o) => {
        const n = { ...o };
        sections.forEach((s) => (n[s] = true));
        return n;
      });
    }
  }, [lastFill, studio.filled]);
  // an estimate or a checkpoint waits: the Avatar section opens
  const waits = project.status === "waiting" || (project.status === "estimate" && !!project.plan);
  useEffect(() => {
    if (waits) setOpen((o) => ({ ...o, avatar: true }));
  }, [waits]);
  const toggle = (id: SectionId) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  const prefs = prefsOf(mate);
  const conceptN = CONCEPT_KEYS.filter((k) => studio.concept[k]).length;
  const avatarSummary =
    project.status === "interview" ? (studio.avatar_skipped ? t("studio.avatarSkipped") : t("studio.avatarSumInterview")) : t(`avatar.status_${project.status}` as MsgKey);

  return (
    <FieldsCtx.Provider value={api}>
      <div ref={root} className="mx-auto flex max-w-2xl flex-col gap-3 px-3 py-3 sm:px-4 sm:py-4" data-testid="studio-settings">
        <div className="flex items-center gap-2 px-1 text-[11.5px] text-content-faint" data-testid="studio-save-state" aria-live="polite">
          {saving.error ? (
            <span className="flex min-w-0 items-center gap-1 text-danger">
              <Icon name="warning" size={11} /> <span className="truncate">{saving.error}</span>
            </span>
          ) : saving.busy ? (
            <span className="flex items-center gap-1">
              <Icon name="spinner" size={11} spin /> {t("studio.saving")}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <Icon name="check" size={11} className="text-success" /> {t("studio.savedAuto")}
            </span>
          )}
          <span className="ml-auto hidden truncate sm:inline">{kind === "new" ? t("studio.rightHintNew") : t("studio.rightHintExisting", { name: mate.name })}</span>
        </div>
        {!project.outfit && (
        <>
        <Section id="concept" title={t("studio.secConcept")} icon="sparkles" open={open.concept} onToggle={() => toggle("concept")} filled={filledBy.concept} summary={studio.concept.pitch || (conceptN ? t("studio.conceptN", { count: conceptN }) : t("studio.conceptEmpty"))}>
          <ConceptSection studio={studio} />
        </Section>
        <Section id="profile" title={t("studio.secProfile")} icon="user" open={open.profile} onToggle={() => toggle("profile")} filled={filledBy.profile} summary={[mate.name || t("studio.untitled"), mate.persona.personality].filter(Boolean).join(" · ")}>
          <ProfileSection mate={mate} />
        </Section>
        <Section id="style" title={t("studio.secStyle")} icon="chat" open={open.style} onToggle={() => toggle("style")} filled={filledBy.style} summary={t(`studio.formality_${prefs.formality}` as MsgKey)}>
          <StyleSection mate={mate} />
        </Section>
        </>
        )}
        <Section id="avatar" title={t("studio.secAvatar")} icon="image" open={open.avatar} onToggle={() => toggle("avatar")} filled={0} summary={avatarSummary}>
          <AvatarStage project={project} mate={mate} kind={kind} onSkip={onSkip} />
          {!(kind === "new" && studio.avatar_skipped && !project.confirmation) && (
            <AvatarPanel project={project} env={env} act={act} reloadEnv={reloadEnv} studio={{ kind: studio.kind, mateId: mate.id, mateName: mate.name || t("studio.untitled") }} hideSteps={kind === "existing"} />
          )}
        </Section>
        {!project.outfit && (
        <>
        <Section id="voice" title={t("studio.secVoice")} icon="volume" open={open.voice} onToggle={() => toggle("voice")} filled={0} summary={studio.concept.voice ? t("studio.voiceSuggest", { voice: studio.concept.voice }) : mate.voice.tts.engine}>
          {studio.concept.voice && (
            <p className="flex items-start gap-2 rounded-lg border border-accent/30 bg-accent-soft/30 px-3 py-2 text-[12px] text-content-dim" data-testid="studio-voice-hint">
              <Icon name="sparkles" size={12} className="mt-0.5 shrink-0 text-accent" /> {t("studio.voiceHint", { voice: studio.concept.voice })}
            </p>
          )}
          <VoiceTab key={mate.id} mate={mate} conv={conv} onTest={onVoiceTested} />
        </Section>
        <Section id="model" title={t("studio.secModel")} icon="brain" open={open.model} onToggle={() => toggle("model")} filled={0} summary={mate.llm.model}>
          <ModelTab key={mate.id} mate={mate} />
        </Section>
        </>
        )}
      </div>
    </FieldsCtx.Provider>
  );
}
