/**
 * The heart panel's 공부 tab (docs/mate-memory-graph.md "Studying"): ask her to study a topic or read a page, see her
 * studies — running ones live (what she searched, the pages she read, what she filed, her notes), finished ones with
 * what she learned and what is still open — cancel or remove one, and choose how often she studies on her own.
 */
import { useEffect, useState } from "react";
import { cancelStudy, deleteStudy, getStudy, listStudies, prefsOf, requestStudy, updateMate, type Curiosity, type Mate, type Study, type StudyEvent } from "../../../api/mates";
import { useT, type MsgKey } from "../../../i18n";
import { relTime } from "../../../i18n/format";
import { useMateStore } from "../../../stores/mateStore";
import { confirmDialog } from "../../ui/ConfirmDialog";
import Icon from "../../ui/Icon";

/** 매우 얕게 · 얕게 · 보통 · 깊게 · 매우 깊게 (backend app/mate/study.py DEPTHS) */
const DEPTHS: Study["depth"][] = ["very_quick", "quick", "normal", "deep", "very_deep"];

const STATE_TONE: Record<Study["state"], string> = {
  queued: "bg-surface-3 text-content-dim",
  running: "bg-accent-soft text-accent",
  done: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  canceled: "bg-surface-3 text-content-faint",
  interrupted: "bg-warning/15 text-warning",
};

export default function StudyPanel({ mate }: { mate: Mate }) {
  const t = useT();
  const rev = useMateStore((s) => s.graphRev[mate.id] ?? 0);
  const [items, setItems] = useState<Study[] | null>(null);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"topic" | "url">("topic");
  const [topic, setTopic] = useState("");
  const [url, setUrl] = useState("");
  const [goal, setGoal] = useState("");
  const [depth, setDepth] = useState<Study["depth"]>("normal");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const curiosity: Curiosity = prefsOf(mate).memory.curiosity ?? "sometimes";
  useEffect(() => {
    let dead = false;
    listStudies(mate.id)
      .then((x) => !dead && setItems(x))
      .catch((e) => !dead && setErr((e as Error).message));
    return () => {
      dead = true;
    };
  }, [mate.id, rev]);
  const running = items?.some((s) => s.state === "running" || s.state === "queued");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => listStudies(mate.id).then(setItems).catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [running, mate.id]);
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const st = await requestStudy(mate.id, mode === "url" ? { kind: "url", url: url.trim(), goal: goal.trim(), depth } : { kind: "topic", topic: topic.trim(), goal: goal.trim(), depth });
      setTopic("");
      setUrl("");
      setGoal("");
      setOpen(st.id);
      setItems(await listStudies(mate.id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setCuriosity = async (c: Curiosity) => {
    try {
      await updateMate(mate.id, { prefs: { memory: { curiosity: c } } });
      void useMateStore.getState().load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const can = !busy && (mode === "url" ? /^https?:\/\/\S+$/.test(url.trim()) : topic.trim().length > 0);
  return (
    <div className="space-y-4" data-testid="study-panel">
      <p className="text-[12px] leading-relaxed text-content-dim">{t("memgraph.studyHint", { name: mate.name })}</p>
      <form className="space-y-2.5 rounded-xl border border-accent/25 bg-accent-soft/20 p-3.5" onSubmit={(e) => { e.preventDefault(); if (can) void submit(); }} data-testid="study-form">
        <div className="flex overflow-hidden rounded-lg border border-border text-[12px]" role="group">
          {(["topic", "url"] as const).map((m) => (
            <button key={m} type="button" className={`inline-flex flex-1 items-center justify-center gap-1.5 px-2.5 py-1.5 ${mode === m ? "bg-accent text-white" : "text-content-dim hover:bg-surface-3"}`} aria-pressed={mode === m} onClick={() => setMode(m)} data-testid={`study-mode-${m}`}>
              <Icon name={m === "topic" ? "book" : "external"} size={12} />
              {t(m === "topic" ? "memgraph.studyTopic" : "memgraph.studyUrl")}
            </button>
          ))}
        </div>
        {mode === "topic" ? (
          <input className="field text-[13px]" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={t("memgraph.topicPh")} data-testid="study-topic" />
        ) : (
          <input className="field text-[13px]" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" inputMode="url" data-testid="study-url" />
        )}
        <input className="field text-[12.5px]" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t("memgraph.goalPh")} data-testid="study-goal" />
        {/* how deep: a topic — how many pages, how long; a page — how far into the site it leads to */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-content-dim">
          {t("memgraph.depth")}
          <div className="flex overflow-hidden rounded-lg border border-border" role="group" aria-label={t("memgraph.depth")}>
            {DEPTHS.map((d) => (
              <button key={d} type="button" className={`whitespace-nowrap px-2.5 py-1 ${depth === d ? "bg-accent text-white" : "hover:bg-surface-3"}`} aria-pressed={depth === d} onClick={() => setDepth(d)} data-testid={`study-depth-${d}`}>
                {t(`memgraph.depth_${d}` as MsgKey)}
              </button>
            ))}
          </div>
          <span className="text-[11.5px] text-content-faint" data-testid="study-depth-hint">{t(`memgraph.${mode === "url" ? "depthUrl" : "depthHint"}_${depth}` as MsgKey)}</span>
        </div>
        <div className="flex items-center justify-end gap-2">
          <span className="min-w-0 flex-1 text-[11px] text-content-faint">{t("memgraph.studyCost")}</span>
          <button className="btn-primary !py-1.5 text-[12.5px]" disabled={!can} data-testid="study-submit">
            {busy ? <Icon name="spinner" size={13} spin /> : <Icon name="sparkles" size={13} />} {t(mode === "url" ? "memgraph.readIt" : "memgraph.studyIt")}
          </button>
        </div>
      </form>

      <div className="space-y-1.5 rounded-xl border border-border bg-surface-2/40 px-3.5 py-3 text-[12px]" data-testid="study-curiosity">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-[8rem] flex-1 font-medium text-content">{t("memgraph.curiosity")}</span>
          <select className="field !w-auto max-w-full !py-1 text-[12px]" value={curiosity} onChange={(e) => void setCuriosity(e.target.value as Curiosity)} aria-label={t("memgraph.curiosity")}>
            {(["off", "sometimes", "often"] as const).map((c) => <option key={c} value={c}>{t(`memgraph.curiosity_${c}` as MsgKey)}</option>)}
          </select>
        </div>
        <p className="text-[11.5px] leading-relaxed text-content-faint">{t("memgraph.curiosityHint", { name: mate.name })}</p>
      </div>

      {err && <p className="text-[12px] text-danger">{err}</p>}
      {!items ? (
        <p className="text-[12px] text-content-faint">{t("common.loading")}</p>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-[12px] text-content-faint" data-testid="study-none">{t("memgraph.noStudies", { name: mate.name })}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((s) => (
            <StudyCard key={s.id} mateId={mate.id} study={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)}
              onChanged={() => listStudies(mate.id).then(setItems).catch(() => {})} />
          ))}
        </ul>
      )}
    </div>
  );
}

function StudyCard({ mateId, study, open, onToggle, onChanged }: { mateId: string; study: Study; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const t = useT();
  const [events, setEvents] = useState<StudyEvent[] | null>(null);
  const live = study.state === "running" || study.state === "queued";
  useEffect(() => {
    if (!open) return;
    let dead = false;
    const load = () => getStudy(mateId, study.id).then((x) => !dead && setEvents(x.events ?? [])).catch(() => {});
    void load();
    const timer = live ? setInterval(load, 3000) : undefined;
    return () => {
      dead = true;
      if (timer) clearInterval(timer);
    };
  }, [open, live, mateId, study.id, study.pages, study.facts]);
  const who = study.requested_by === "self" ? t("memgraph.bySelf") : study.requested_by === "mate" ? t("memgraph.byMate") : t("memgraph.byUser");
  return (
    <li className="rounded-xl border border-border bg-surface-2/40 p-3" data-testid="study-card" data-state={study.state} data-id={study.id}>
      <button className="flex w-full items-start gap-2 text-left" onClick={onToggle} aria-expanded={open}>
        <Icon name={study.kind === "url" ? "external" : study.kind === "curiosity" ? "sparkles" : "book"} size={14} className="mt-0.5 shrink-0 text-accent" />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-[13px] font-medium text-content">{study.topic || study.url}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-content-faint">
            <span className={`pill ${STATE_TONE[study.state]}`}>
              {live && study.state === "running" && <Icon name="spinner" size={10} spin />} {t(`memgraph.state_${study.state}` as MsgKey)}
            </span>
            <span>{who}</span>
            {study.kind !== "curiosity" && DEPTHS.includes(study.depth) && <span>{t(`memgraph.depth_${study.depth}` as MsgKey)}</span>}
            <span>{t("memgraph.studyPages", { n: study.pages })} · {t("memgraph.facts", { n: study.facts })}</span>
            <span>{relTime(study.finished_at || study.started_at || study.created_at)}</span>
          </span>
        </span>
        <Icon name="chevron" size={13} className={`mt-1 shrink-0 text-content-faint transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-2.5 space-y-2.5 border-t border-border/60 pt-2.5">
          {study.goal && <p className="text-[12px] text-content-faint">{t("memgraph.goal")}: {study.goal}</p>}
          {study.summary && <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-content" data-testid="study-summary">{study.summary}</p>}
          {study.error && study.state !== "done" && <p className="text-[12px] text-danger">{study.error}</p>}
          {study.open_questions.length > 0 && (
            <div className="text-[12px]">
              <span className="font-medium text-content-dim">{t("memgraph.openQuestions")}</span>
              <ul className="mt-0.5 list-disc pl-4 text-content-faint">{study.open_questions.map((q) => <li key={q}>{q}</li>)}</ul>
            </div>
          )}
          {events && events.length > 0 && (
            <ol className="max-h-56 space-y-1 overflow-y-auto border-l border-border pl-3 text-[11.5px]" data-testid="study-events">
              {events.filter((e) => e.kind !== "queued").map((e, i) => (
                <li key={i} className="text-content-dim">
                  <span className="text-content-faint">{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>{" "}
                  {eventText(t, e)}
                </li>
              ))}
            </ol>
          )}
          <div className="flex justify-end gap-2">
            {live ? (
              <button className="btn-ghost !py-1 text-[12px]" onClick={() => void cancelStudy(mateId, study.id).then(onChanged)} data-testid="study-cancel">
                {t("common.cancel")}
              </button>
            ) : (
              <button className="btn-ghost !py-1 text-[12px] text-content-faint"
                onClick={async () => {
                  if (await confirmDialog({ body: t("memgraph.removeStudy"), confirmLabel: t("memgraph.remove") }))
                    void deleteStudy(mateId, study.id).then(onChanged);
                }}>
                {t("memgraph.remove")}
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function eventText(t: ReturnType<typeof useT>, e: StudyEvent): string {
  switch (e.kind) {
    case "search":
      return t("memgraph.ev_search", { q: e.text });
    case "reading":
      return t("memgraph.ev_reading", { url: e.text });
    case "read":
      return t("memgraph.ev_read", { title: e.text });
    case "unreadable":
      return t("memgraph.ev_unreadable", { url: e.text, reason: String(e.data.reason ?? "") });
    case "filed":
      return t("memgraph.ev_filed", { n: Number(e.data.facts ?? 0) });
    case "note":
      return e.text;
    case "summary":
      return t("memgraph.ev_summary");
    case "timeout":
      return t("memgraph.ev_timeout");
    case "started":
      return t("memgraph.ev_started");
    default:
      return t(`memgraph.state_${e.kind}` as MsgKey) + (e.text ? ` — ${e.text}` : "");
  }
}
