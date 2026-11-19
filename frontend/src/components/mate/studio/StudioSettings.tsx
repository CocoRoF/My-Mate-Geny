/**
 * A new mate's settings in the studio's windows (docs/avatar-create.md §11, canvas/NodeSheet): Concept · Profile ·
 * Conversation style, each field saving itself — fields the agent filled glow and carry a badge with Undo; the user can
 * edit any of them (the agent hears what changed before its next turn) — and her avatar's stage before it is made.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { AvatarProject, ConceptKey, StudioInfo } from "../../../api/avatar";
import { fillAddress, prefsOf, type Mate } from "../../../api/mates";
import { MateAvatar } from "../../../mate/avatar/MateAvatar";
import { useT, type MsgKey } from "../../../i18n";
import Icon from "../../ui/Icon";
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

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-content-faint">{title}</h4>
      {children}
    </div>
  );
}

/** Concept: the pitch, who she is to the user, the voice character and the visual concept */
export function ConceptSection({ studio }: { studio: StudioInfo }) {
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

export function ProfileSection({ mate }: { mate: Mate }) {
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

export function StyleSection({ mate }: { mate: Mate }) {
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
        {/* (what she calls them, not a word for every sentence: when and how is hers — app/mate/prompt.ADDRESS_USE) */}
        <p className="rounded-lg bg-surface/70 px-2.5 py-1.5 text-[11.5px] text-content-faint" data-testid="studio-address-use">
          {t("mateSettings.profAddressUse", { name: mate.name })}
        </p>
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

/** a Live2D model's / LivLiv package's expressions that answer to her emotions (the agent maps them; Mate settings →
 *  Avatar changes them) */
export function EmotionMap({ mate }: { mate: Mate }) {
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
export function AvatarStage({ project, mate, kind, onSkip, onBring }: { project: AvatarProject; mate: Mate; kind: "new" | "existing"; onSkip?: (skip: boolean) => void; /** her look from a file instead (the import window) */ onBring?: () => void }) {
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
        <p className="mt-0.5 text-[11.5px] text-content-faint">{skipped ? t("studio.avatarSkippedHint") : live ? t("studio.avatarMakingHint") : project.outfit ? t("studio.outfitStageHint") : kind === "existing" ? t("studio.avatarCurrentHint") : has ? t("studio.avatarBroughtHint") : t("studio.avatarNoneHint")}</p>
        {kind === "new" && onSkip && !project.confirmation && (!has || skipped) && (
          <button type="button" className="btn-ghost mt-1.5 !px-2 !py-1 text-[12px]" onClick={() => onSkip(!skipped)} data-testid="studio-skip-avatar">
            <Icon name={skipped ? "sparkles" : "x"} size={12} /> {skipped ? t("studio.avatarUnskip") : t("studio.avatarSkip")}
          </button>
        )}
        {!live && !project.outfit && onBring && (
          <button type="button" className="btn-ghost mt-1.5 !px-2 !py-1 text-[12px]" onClick={onBring} title={t("studio.avatarBringHint")} data-testid="studio-avatar-bring">
            <Icon name="upload" size={12} /> {t("studio.avatarBring")}
          </button>
        )}
        <EmotionMap mate={mate} />
      </div>
    </div>
  );
}
