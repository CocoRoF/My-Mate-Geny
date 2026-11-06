/**
 * The creation agent's conversation (the Mate Create studio's left side, docs/avatar-create.md §11): the agent's lines
 * (MateReply bubbles), its tools as small chips, its cards — questions (choices / concept directions / slider /
 * upload / text / mate picker — the answer goes back as the user's message), "filled in" cards for the settings it
 * wrote on the right, the estimate card where it priced the plan — and the run's events as dividers. A plain composer
 * (text + pictures).
 */
import { memo, useMemo, useRef, useState } from "react";
import { answered, uploadReference, type AvatarEnv, type AvatarProject, type Question } from "../../../api/avatar";
import { uploadAttachment } from "../../../api/attachments";
import type { FlowItem, ToolActivity, Turn } from "../../../stores/chatStore";
import { useMateStore } from "../../../stores/mateStore";
import { useHistoryScroll } from "../../../hooks/useHistoryScroll";
import type { Attachment } from "../../../types";
import MessageAttachments from "../../attachments/MessageAttachments";
import HistoryEdge from "../../chat/HistoryEdge";
import Icon, { type IconName } from "../../ui/Icon";
import MateReply from "../MateReply";
import { EstimateCard, ExtraCard, type Act } from "./AvatarPanel";
import { useAvatarChat, type AgentChat } from "./useAgentChat";
import { tr, useT, type MsgKey } from "../../../i18n";

const TOOL: Record<string, { icon: IconName; label: MsgKey }> = {
  get_project: { icon: "eye", label: "avatar.toolGetProject" },
  update_mate_draft: { icon: "pencil", label: "studio.toolDraft" },
  ask_user: { icon: "chat", label: "avatar.toolAsk" },
  update_brief: { icon: "pencil", label: "avatar.toolBrief" },
  use_reference: { icon: "image", label: "avatar.toolReference" },
  estimate: { icon: "sparkles", label: "avatar.toolEstimate" },
  look: { icon: "eye", label: "avatar.toolLook" },
  regenerate: { icon: "rotate", label: "avatar.toolRedo" },
  extend: { icon: "plus", label: "avatar.toolExtend" },
  pause: { icon: "pause", label: "avatar.toolPause" },
  resume: { icon: "play", label: "avatar.toolResume" },
  cancel: { icon: "x", label: "avatar.toolCancel" },
};

const toolName = (t: ToolActivity) => t.name.replace(/^mcp__avatar__/, "");

/** the settings section a field path lives in (the studio scrolls there) */
export const sectionOf = (path: string): string =>
  path.startsWith("concept.") ? "concept" : path.startsWith("prefs.") && !/^prefs\.(user_name|self_ref)$/.test(path) ? "style" : "profile";

/** update_mate_draft's arguments → the field paths it wrote (like the server's studio.paths_of) */
export function draftPaths(input: unknown): string[] {
  const a = (input || {}) as Record<string, any>;
  const f = (a.fields && typeof a.fields === "object" ? a.fields : a) as Record<string, any>;
  const out: string[] = [];
  if (typeof f.name === "string") out.push("name");
  for (const k of Object.keys(f.persona || {})) out.push(`persona.${k}`);
  for (const [k, v] of Object.entries(f.prefs || {})) {
    if (k === "tone" && v && typeof v === "object") out.push(...Object.keys(v as object).map((x) => `prefs.tone.${x}`));
    else out.push(`prefs.${k}`);
  }
  for (const k of Object.keys(f.concept || {})) out.push(`concept.${k}`);
  return out;
}

/** a field path's label (the same words as the settings on the right) */
export function fieldLabel(t: ReturnType<typeof useT>, path: string): string {
  const key = `studio.f_${path.replace(/\./g, "_")}` as MsgKey;
  const v = t(key);
  return v === key ? path : v;
}

/** the agent wrote settings on the right: which ones, and a way there */
function FilledCard({ tool, onShow }: { tool: ToolActivity; onShow?: (section: string) => void }) {
  const t = useT();
  const paths = draftPaths(tool.input);
  const running = tool.durationMs === undefined;
  if (tool.isError) return <Chip tool={tool} />;
  return (
    <div className="w-full max-w-[92%] rounded-xl border border-success/30 bg-success/[0.06] px-3 py-2.5" data-testid="studio-filled-card">
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-content">
        <Icon name={running ? "spinner" : "sparkles"} size={13} spin={running} className="text-success" />
        <span className="min-w-0 flex-1">{t("studio.filledCard", { count: paths.length })}</span>
        {onShow && paths.length > 0 && (
          <button className="rounded-md px-1.5 py-0.5 text-[11.5px] text-accent hover:bg-accent-soft" onClick={() => onShow(sectionOf(paths[0]))} data-testid="studio-filled-show">
            {t("studio.filledShow")}
          </button>
        )}
      </div>
      {paths.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {paths.slice(0, 14).map((p) => (
            <span key={p} className="rounded-full bg-surface/80 px-2 py-0.5 text-[11px] text-content-dim">
              {fieldLabel(t, p)}
            </span>
          ))}
          {paths.length > 14 && <span className="px-1 text-[11px] text-content-faint">+{paths.length - 14}</span>}
        </div>
      )}
    </div>
  );
}

/** a concept direction: name, one-line pitch, colours */
function ConceptOption({ o, live, onPick }: { o: { value: string; label: string; description?: string | null; palette?: string[] }; live: boolean; onPick: () => void }) {
  return (
    <button
      disabled={!live}
      onClick={onPick}
      className="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface text-left transition hover:-translate-y-0.5 hover:border-accent/60 hover:shadow-card focus-visible:border-accent disabled:cursor-default disabled:opacity-60 disabled:hover:translate-y-0"
      data-testid="studio-concept-option"
      data-value={o.value}
    >
      <div className="flex h-9 w-full" aria-hidden>
        {(o.palette?.length ? o.palette : ["rgb(var(--c-surface-3))"]).map((c, i) => (
          <span key={i} className="h-full flex-1" style={{ background: c }} />
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-1 px-3 py-2.5">
        <span className="text-[13.5px] font-semibold text-content">{o.label}</span>
        {o.description && <span className="text-[12px] leading-relaxed text-content-dim">{o.description}</span>}
      </div>
    </button>
  );
}

function Chip({ tool }: { tool: ToolActivity }) {
  const t = useT();
  const name = toolName(tool);
  const d = TOOL[name] || { icon: "bolt" as IconName, label: "avatar.toolOther" as MsgKey };
  const running = tool.durationMs === undefined;
  const input = (tool.input || {}) as Record<string, unknown>;
  const extra = tool.isError ? "" : name === "look" && input.target ? ` · ${String(input.target)}` : name === "regenerate" && input.item ? ` · ${String(input.item)}` : "";
  return (
    <div className="flex flex-col items-start gap-1.5" data-testid="avatar-tool">
      <span
        className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] ${
          tool.isError ? "border-warning/30 bg-warning/10 text-warning" : "border-border bg-surface-2/80 text-content-dim"
        }`}
        data-testid={`avatar-tool-${name}`}
        data-error={tool.isError ? "1" : "0"}
      >
        <Icon name={running ? "spinner" : tool.isError ? "warning" : d.icon} size={11} spin={running} />
        <span className="truncate">
          {tool.isError ? t("avatar.toolFailed") : t(d.label)}
          {extra}
        </span>
      </span>
      {/* (the agent's own business, in its language: it usually goes on another way) */}
      {tool.isError && tool.output && (
        <details className="max-w-full break-words pl-2 text-[11px] text-content-faint" data-testid="avatar-tool-error">
          <summary className="cursor-pointer">{t("avatar.toolFailedDetail")}</summary>
          {tool.output.slice(0, 240)}
        </details>
      )}
      {!!tool.images?.length && (
        <div className="max-w-full">
          <MessageAttachments attachments={tool.images} />
        </div>
      )}
    </div>
  );
}

/** a question card the agent asked; live while it is the project's open question, else a short record */
function QuestionCard({ q, live, project, send }: { q: Question; live: boolean; project: AvatarProject; send: (text: string) => void }) {
  const t = useT();
  const mates = useMateStore((s) => s.mates);
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [num, setNum] = useState<number>(q.default ?? q.min ?? 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const reply = (answer: string) => {
    send(`${q.question}\n→ ${answer}`);
    void answered(project.id).catch(() => {});
  };
  const opt = (value: string, label: string, desc?: string | null) => (
    <button
      key={value}
      disabled={!live}
      onClick={() => (q.kind === "multi" ? setPicked((p) => (p.includes(value) ? p.filter((x) => x !== value) : [...p, value])) : reply(label))}
      className={`rounded-lg border px-3 py-1.5 text-left text-[12.5px] transition ${
        picked.includes(value) ? "border-accent bg-accent-soft text-content" : "border-border bg-surface hover:border-border-strong hover:text-content"
      } disabled:cursor-default disabled:opacity-60`}
      data-testid="avatar-q-option"
      data-value={value}
    >
      <span className="block text-content">{label}</span>
      {desc && <span className="mt-0.5 block text-[11px] text-content-faint">{desc}</span>}
    </button>
  );
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setErr(null);
    try {
      const p = await uploadReference(project.id, f);
      reply(tr("avatar.uploadedRef", { name: p.brief.reference.files[p.brief.reference.files.length - 1] || f.name }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={`w-full rounded-xl border p-3 ${q.kind === "concepts" ? "max-w-full" : "max-w-[92%]"} ${live ? "border-accent/40 bg-accent-soft/30 shadow-card" : "border-border bg-surface-2/40"}`}
      data-testid="avatar-question"
      data-live={live ? "1" : "0"}
      data-kind={q.kind}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-accent">
        <Icon name={q.kind === "concepts" ? "sparkles" : "chat"} size={11} /> {q.kind === "concepts" ? t("studio.cardConcepts") : t("studio.cardQuestion")}
      </div>
      <p className="mb-2 text-[13px] font-medium text-content">{q.question}</p>
      {q.kind === "concepts" ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {q.options.map((o) => (
              <ConceptOption key={o.value} o={o} live={live} onPick={() => reply(o.description ? `${o.label} — ${o.description}` : o.label)} />
            ))}
          </div>
          {q.allow_other && live && (
            <div className="mt-2 flex gap-2">
              <input className="field flex-1 text-[12.5px]" value={other} onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && other.trim() && reply(other.trim())} placeholder={t("studio.conceptOwn")} data-testid="avatar-q-other" />
              <button className="btn-soft !py-1" disabled={!other.trim()} onClick={() => reply(other.trim())}>
                {t("avatar.answer")}
              </button>
            </div>
          )}
        </>
      ) : q.kind === "slider" ? (
        <div className="flex items-center gap-3">
          <input type="range" min={q.min ?? 0} max={q.max ?? 10} step={q.step ?? 1} value={num} disabled={!live} onChange={(e) => setNum(Number(e.target.value))} className="flex-1" data-testid="avatar-q-slider" />
          <span className="w-16 text-right text-[13px] text-content">
            {num} {q.unit || ""}
          </span>
          <button className="btn-primary !py-1" disabled={!live} onClick={() => reply(`${num}${q.unit ? " " + q.unit : ""}`)} data-testid="avatar-q-send">
            {t("avatar.answer")}
          </button>
        </div>
      ) : q.kind === "text" ? (
        <div className="flex gap-2">
          <input className="field flex-1 text-[12.5px]" value={other} disabled={!live} onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => e.key === "Enter" && other.trim() && reply(other.trim())} data-testid="avatar-q-text" />
          <button className="btn-primary !py-1" disabled={!live || !other.trim()} onClick={() => reply(other.trim())} data-testid="avatar-q-send">
            {t("avatar.answer")}
          </button>
        </div>
      ) : q.kind === "mate" ? (
        <div className="flex flex-wrap gap-1.5">
          {mates.map((m) => opt(`mate:${m.id}`, tr("avatar.mateAnswer", { name: m.name, id: m.id })))}
          <div className="flex w-full gap-2 pt-1">
            <input className="field flex-1 text-[12.5px]" value={newName} disabled={!live} onChange={(e) => setNewName(e.target.value)} placeholder={t("avatar.newMateName")} data-testid="avatar-q-newmate" />
            <button className="btn-soft !py-1" disabled={!live || !newName.trim()} onClick={() => reply(tr("avatar.newMateAnswer", { name: newName.trim() }))}>
              {t("avatar.newMate")}
            </button>
          </div>
        </div>
      ) : (
        <>
          {q.kind === "upload" && (
            <div className="mb-2">
              <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} data-testid="avatar-q-file" />
              <button className="btn-primary" disabled={!live || busy} onClick={() => file.current?.click()} data-testid="avatar-q-upload">
                {busy ? <Icon name="spinner" size={14} spin /> : <Icon name="upload" size={14} />} {t("avatar.uploadRef")}
              </button>
              {err && <p className="mt-1 text-[11.5px] text-danger">{err}</p>}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">{q.options.map((o) => opt(o.value, o.label, o.description))}</div>
          {q.kind === "multi" && (
            <div className="mt-2 flex justify-end">
              <button
                className="btn-primary !py-1"
                disabled={!live || (!picked.length && !other.trim())}
                onClick={() => reply([...q.options.filter((o) => picked.includes(o.value)).map((o) => o.label), ...(other.trim() ? [other.trim()] : [])].join(", "))}
                data-testid="avatar-q-send"
              >
                {t("avatar.answer")}
              </button>
            </div>
          )}
          {q.allow_other && live && q.kind !== "multi" && (
            <div className="mt-2 flex gap-2">
              <input className="field flex-1 text-[12.5px]" value={other} onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => e.key === "Enter" && other.trim() && reply(other.trim())} placeholder={t("avatar.other")} data-testid="avatar-q-other" />
              <button className="btn-soft !py-1" disabled={!other.trim()} onClick={() => reply(other.trim())}>
                {t("avatar.answer")}
              </button>
            </div>
          )}
          {q.allow_other && live && q.kind === "multi" && (
            <input className="field mt-2 w-full text-[12.5px]" value={other} onChange={(e) => setOther(e.target.value)} placeholder={t("avatar.other")} />
          )}
        </>
      )}
    </div>
  );
}

const EVENT_LABEL: Record<string, MsgKey> = {
  start: "avatar.evStart",
  confirmed: "avatar.evConfirmed",
  declined: "avatar.evDeclined",
  checkpoint_pick: "avatar.evCandidates",
  checkpoint_home: "avatar.evBase",
  checkpoint_stills: "avatar.evStills",
  ready: "avatar.evReady",
  failed: "avatar.evFailed",
  job_failed: "avatar.evJobFailed",
  cap: "avatar.evCap",
  applied: "avatar.evApplied",
  extra_confirmed: "avatar.evExtra",
  mate_created: "studio.evCreated",
  avatar_skipped: "studio.evSkipped",
  avatar_back: "studio.evAvatarBack",
};

function EventDivider({ text }: { text: string }) {
  const t = useT();
  const kinds = Array.from(text.matchAll(/<avatar_event kind="([\w-]+)">/g)).map((m) => m[1]);
  const labels = Array.from(new Set(kinds.map((k) => (k.startsWith("decision_") ? "avatar.evDecision" : EVENT_LABEL[k] || "avatar.evOther") as MsgKey)));
  return (
    <div className="flex items-center gap-3 py-1 text-[11px] text-content-faint" data-testid="avatar-event">
      <span className="h-px flex-1 bg-border" />
      <span className="text-center">{labels.map((l) => t(l)).join(" · ")}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

const AgentTurn = memo(function AgentTurn({ turn, project, env, act, send, lastAsk, lastEstimate, onShow }: {
  turn: Turn; project: AvatarProject; env: AvatarEnv | null; act: Act; send: (s: string) => void; lastAsk: string | null; lastEstimate: string | null;
  onShow?: (section: string) => void;
}) {
  const tt = useT();
  const running = !turn.complete;
  const toolsById = new Map(turn.tools.map((t) => [t.id, t]));
  const lastText = turn.flow.reduce((n, f, i) => (f.kind === "text" ? i : n), -1);
  const items: JSX.Element[] = [];
  turn.flow.forEach((f: FlowItem, i) => {
    if (f.kind === "text") items.push(<MateReply key={i} keyPrefix={`${i}.`} text={f.text} streaming={running && i === lastText} />);
    else if (f.kind === "tool") {
      const tool = toolsById.get(f.toolId);
      if (!tool) return;
      const name = toolName(tool);
      const input = (tool.input || {}) as Partial<Question> & Record<string, unknown>;
      if (name === "ask_user" && !tool.isError && input.question) {
        const q: Question = { id: tool.id, kind: (input.kind as Question["kind"]) || "choice", question: String(input.question), options: (input.options || []).map((o: any) => (typeof o === "string" ? { value: o, label: o } : { value: String(o.value ?? o.label), label: String(o.label ?? o.value), description: o.description, palette: Array.isArray(o.palette) ? o.palette.filter((c: unknown) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c.trim())).slice(0, 5) : undefined })), allow_other: input.allow_other ?? (input.kind === "choice" || input.kind === "multi" || input.kind === "concepts"), min: input.min, max: input.max, step: input.step, default: input.default, unit: input.unit };
        items.push(<QuestionCard key={i} q={q} live={lastAsk === tool.id && !!project.question} project={project} send={send} />);
      } else if (name === "update_mate_draft") {
        items.push(<FilledCard key={i} tool={tool} onShow={onShow} />);
      } else if (name === "estimate" && !tool.isError && lastEstimate === tool.id && project.plan && !project.confirmation && project.status === "estimate") {
        items.push(
          <div key={i} className="w-full max-w-[92%]">
            <EstimateCard project={project} env={env} act={act} inline />
          </div>,
        );
      } else items.push(<Chip key={i} tool={tool} />);
    } else if (f.kind === "steer") {
      items.push(<UserBubble key={i} text={f.text} attachments={f.attachments} />);
    } else if (f.kind === "notice") {
      items.push(
        <div key={i} className={`text-[11.5px] ${f.level === "warning" ? "text-warning" : "text-content-faint"}`}>
          {f.message}
        </div>,
      );
    }
  });
  return (
    <div className="flex flex-col items-start gap-1.5 animate-fade-in" data-testid="avatar-turn">
      {items}
      {running && lastText < 0 && (
        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-content-faint">
          <Icon name="spinner" size={11} spin /> {tt("avatar.working")}
        </span>
      )}
      {turn.error && turn.status !== "interrupted" && (
        <div className="flex items-start gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">
          <Icon name="warning" size={12} className="mt-0.5 shrink-0" />
          <span className="break-words">{turn.error.message || tt("nav.errSomethingWrong")}</span>
        </div>
      )}
    </div>
  );
});

function UserBubble({ text, attachments }: { text: string; attachments?: Attachment[] }) {
  return (
    <div className="flex w-full flex-col items-end gap-1.5" data-testid="avatar-user-message">
      {!!attachments?.length && <MessageAttachments attachments={attachments} />}
      {text.trim() && (
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-accent/30 bg-gradient-to-br from-accent/[0.22] to-accent/[0.12] px-3.5 py-2 text-sm leading-relaxed text-content shadow-bubble">
          {text}
        </div>
      )}
    </div>
  );
}

function Composer({ sid, chat, placeholder }: { sid: string; chat: AgentChat; placeholder?: string }) {
  const t = useT();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const submit = () => {
    if (!text.trim() && !files.length) return;
    if (chat.send(text, files)) {
      setText("");
      setFiles([]);
    }
  };
  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setErr(null);
    try {
      const out: Attachment[] = [];
      for (const f of Array.from(list)) out.push(await uploadAttachment(sid, f, () => {}).promise);
      setFiles((x) => [...x, ...out]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shrink-0 border-t border-border/60 px-3 pb-3 pt-2" data-testid="avatar-composer">
      {files.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <span key={f.id} className="pill bg-surface-3 text-content-dim">
              {f.name}
              <button onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))} aria-label={t("common.remove")}>
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      {err && <p className="mb-1 text-[11.5px] text-danger">{err}</p>}
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface-2 px-2 py-1.5 focus-within:border-accent/50">
        <input ref={pick} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void add(e.target.files)} />
        <button className="btn-ghost !px-2" onClick={() => pick.current?.click()} disabled={busy} aria-label={t("avatar.attach")} data-testid="avatar-attach">
          <Icon name={busy ? "spinner" : "paperclip"} size={16} spin={busy} />
        </button>
        <textarea
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder ?? t("avatar.composerPlaceholder")}
          className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent py-2 text-sm outline-none"
          data-testid="avatar-input"
        />
        {chat.streaming && !text.trim() ? (
          <button className="btn-soft !px-2.5" onClick={chat.stop} aria-label={t("avatar.stop")} data-testid="avatar-stop">
            <Icon name="stop" size={15} />
          </button>
        ) : (
          <button className="btn-primary !px-2.5" onClick={submit} disabled={!text.trim() && !files.length} aria-label={t("avatar.send")} data-testid="avatar-send">
            <Icon name="send" size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

export default function AvatarChat({ project, env, act, chat, onShow, placeholder, top }: {
  project: AvatarProject;
  env: AvatarEnv | null;
  act: Act;
  chat: AgentChat;
  /** the studio: show a settings section (a "filled in" card's Show) */
  onShow?: (section: string) => void;
  placeholder?: string;
  /** above the conversation (the studio's run status) */
  top?: React.ReactNode;
}) {
  const t = useT();
  const turns = useAvatarChat((s) => s.turns);
  const { ref, onScroll, paging, loadOlder } = useHistoryScroll(useAvatarChat, 100);
  const send = (s: string) => {
    chat.send(s);
  };
  const pending = project.extras.filter((x) => x.status === "pending");
  // the open question / the current estimate: the last such tool call of the conversation
  const { lastAsk, lastEstimate } = useMemo(() => {
    let ask: string | null = null;
    let est: string | null = null;
    for (const turn of turns) {
      for (const tool of turn.tools) {
        const n = toolName(tool);
        if (n === "ask_user" && !tool.isError) ask = tool.id;
        if (n === "estimate" && !tool.isError) est = tool.id;
      }
    }
    return { lastAsk: ask, lastEstimate: est };
  }, [turns]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="avatar-chat">
      {(chat.error || chat.connection === "reconnecting") && (
        <div className="mx-auto mt-2 w-fit rounded-full border border-warning/30 bg-surface-2 px-3 py-1 text-[11.5px] text-warning">{chat.error || t("mate.reconnecting")}</div>
      )}
      {top}
      <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex max-w-2xl flex-col gap-3 px-4 py-4">
          <HistoryEdge paging={paging} empty={turns.length === 0} onRetry={loadOlder} />
          {turns.length === 0 && (
            <div className="flex flex-col items-center gap-3 pt-12 text-center" data-testid="avatar-chat-empty">
              <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent-soft text-accent">
                <Icon name="sparkles" size={18} />
              </span>
              <p className="flex items-center gap-1.5 text-sm text-content-faint">
                <Icon name="spinner" size={13} spin /> {t("avatar.chatEmpty")}
              </p>
            </div>
          )}
          {turns.map((turn) => {
            if (turn.role === "user") {
              if (turn.meta?.internal) return turn.meta.kind === "avatar_event" ? <EventDivider key={turn.key} text={turn.text} /> : null;
              return <UserBubble key={turn.key} text={turn.text} attachments={turn.attachments} />;
            }
            if (turn.role === "system") {
              return (
                <div key={turn.key} className="text-center text-[11px] text-content-faint">
                  {turn.text}
                </div>
              );
            }
            return <AgentTurn key={turn.key} turn={turn} project={project} env={env} act={act} send={send} lastAsk={lastAsk} lastEstimate={lastEstimate} onShow={onShow} />;
          })}
        </div>
      </div>
      {/* what waits for the user's OK stays in sight: on a phone the settings are on another tab */}
      {pending.length > 0 && (
        <div className="flex max-h-[45dvh] shrink-0 flex-col gap-2 overflow-y-auto px-3 pb-2" data-testid="avatar-chat-extras">
          {pending.map((x) => (
            <ExtraCard key={x.id} project={project} x={x} act={act} />
          ))}
        </div>
      )}
      <div className="shrink-0 pb-safe">
        <Composer sid={project.session_id} chat={chat} placeholder={placeholder} />
      </div>
    </div>
  );
}
