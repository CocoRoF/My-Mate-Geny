/**
 * Source-backed memories and shared experiences — the 기억 tab of her status window. One card per thing they are about
 * (the user, the two of them, her, a person, a game …: docs/mate-memory-graph.md "One record per thing"), each item of
 * it one line — a plain sentence, the words it rests on one click away. How she keeps and recalls them is in Mate
 * settings → 관계와 기억 (`onSettings`).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addMemory,
  deleteMemory,
  knowledgeStatus,
  listMemories,
  listMemoryEpisodes,
  organizeMemory,
  prefsOf,
  previewRecall,
  retryMemory,
  updateMemory,
  type KnowledgeStatus,
  type Mate,
  type Memory,
  type MemoryEpisode,
  type MemoryKind,
  type GraphKind,
  type RecallPreview,
} from "../../api/mates";
import { groupByEntity, type MemoryGroup } from "../../mate/memoryGroups";
import { useMateStore } from "../../stores/mateStore";
import { useT, type MsgKey } from "../../i18n";
import { relTime } from "../../i18n/format";
import Icon, { type IconName } from "../ui/Icon";
import ScrollRow from "../ui/ScrollRow";
import { kindLabel } from "./memory/NodeDetail";
import KnowledgePanel, {
  Evidence,
  MemoryHistoryDetails,
} from "./settings/KnowledgePanel";
import { ErrorLine } from "./settings/ui";

const KINDS: Record<MemoryKind, MsgKey> = {
  profile: "mateSettings.memKindProfile",
  preference: "mateSettings.memKindPreference",
  fact: "mateSettings.memKindFact",
  plan: "mateSettings.memKindPlan",
  context: "mateSettings.memKindContext",
};
const FILTERS: { id: string; label: MsgKey }[] = [
  { id: "all", label: "mate.notebookAll" },
  { id: "person", label: "mate.notebookPeople" },
  { id: "preference", label: "mateSettings.memKindPreference" },
  { id: "plan", label: "mateSettings.memKindPlan" },
  { id: "episodes", label: "mate.notebookExperiences" },
];
const ENTITY_ICON: Record<GraphKind, IconName> = {
  user: "user", us: "heart", self: "sparkles", person: "user", place: "map-pin", org: "users", work: "folder",
  game: "gamepad", thing: "brain", concept: "lightbulb", topic: "lightbulb", event: "calendar",
};

type Draft = Pick<Memory, "text" | "kind" | "importance" | "due_at">;
const EMPTY: Draft = { text: "", kind: "fact", importance: 3, due_at: null };

function MemoryForm({
  initial = EMPTY,
  busy,
  onSave,
  onCancel,
}: {
  initial?: Draft;
  busy: boolean;
  onSave: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(initial.text),
    [kind, setKind] = useState(initial.kind);
  const [importance, setImportance] = useState(initial.importance);
  const [date, setDate] = useState(initial.due_at?.split("T")[0] || "");
  const [time, setTime] = useState(
    initial.due_at?.split("T")[1]?.slice(0, 5) || "",
  );
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && text.trim())
          onSave({
            text: text.trim(),
            kind,
            importance,
            due_at:
              kind === "plan" && date ? date + (time ? `T${time}` : "") : null,
          });
      }}
      data-testid="memory-editor"
    >
      <textarea
        className="field min-h-24 resize-y"
        maxLength={1000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={t("mateSettings.memPh")}
        placeholder={t("mateSettings.memPh")}
        autoFocus
      />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[12px] text-content-dim">
          {t("mateSettings.memKind")}
          <select
            className="field !w-auto"
            value={kind}
            onChange={(e) => setKind(e.target.value as MemoryKind)}
          >
            {(Object.keys(KINDS) as MemoryKind[]).map((k) => (
              <option key={k} value={k}>
                {t(KINDS[k])}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12px] text-content-dim">
          {t("mateSettings.memImportance", { n: importance })}
          <input
            type="range"
            min={1}
            max={5}
            className="w-24"
            value={importance}
            onChange={(e) => setImportance(Number(e.target.value))}
          />
        </label>
      </div>
      {kind === "plan" && (
        <div className="flex flex-wrap gap-3">
          <label className="min-w-0 flex-1 space-y-1 text-[12px] text-content-dim">
            {t("mateSettings.memDue")}
            <input
              className="field"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="space-y-1 text-[12px] text-content-dim">
            {t("mateSettings.memDueTime")}
            <input
              className="field"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn-ghost"
          disabled={busy}
          onClick={onCancel}
        >
          {t("common.cancel")}
        </button>
        <button className="btn-soft" disabled={busy || !text.trim()}>
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}

function MemoryCard({
  mateId,
  memory,
  reload,
  fail,
}: {
  mateId: string;
  memory: Memory;
  reload: () => void;
  fail: (s: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false);
  const act = async (op: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await op();
      setEditing(false);
      reload();
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const item = memory.predicate && memory.predicate !== "habit" ? memory.predicate : "";
  return (
    <article
      className="space-y-2 border-t border-border/60 py-3 first:border-t-0 first:pt-0 last:pb-0"
      data-testid="memory-card"
      data-id={memory.id}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {!editing && (
            <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-content">
              {item && <span className="mr-1.5 font-semibold text-content-dim" data-testid="memory-item">{item}</span>}
              {memory.text}
            </p>
          )}
          <p className="mt-0.5 text-[11px] text-content-faint">
            {memory.predicate === "habit" ? t("mate.notebookHabit") : t(KINDS[memory.kind])} · {relTime(memory.updated_at)}
            {memory.pinned && ` · ${t("mateSettings.memCore")}`}
          </p>
        </div>
        <button
          type="button"
          className={`rounded-lg p-1.5 hover:bg-surface-3 ${memory.pinned ? "text-accent" : "text-content-faint"}`}
          disabled={busy}
          title={t(
            memory.pinned ? "mateSettings.memUnpin" : "mateSettings.memPin",
          )}
          aria-label={t(
            memory.pinned ? "mateSettings.memUnpin" : "mateSettings.memPin",
          )}
          onClick={() =>
            void act(() =>
              updateMemory(mateId, memory.id, {
                pinned: !memory.pinned,
                expected_revision: memory.revision,
              }),
            )
          }
        >
          <Icon name="pin" size={14} />
        </button>
      </div>
      {editing ? (
        <MemoryForm
          key={memory.revision}
          initial={memory}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={(draft) =>
            void act(() =>
              updateMemory(mateId, memory.id, {
                ...draft,
                expected_revision: memory.revision,
              }),
            )
          }
        />
      ) : null}
      {memory.due_at && (
        <p className="rounded-lg bg-accent-soft px-2.5 py-1.5 text-[12px] text-accent">
          {t("mateSettings.memDueOn", {
            when: memory.due_at.replace("T", " "),
          })}
        </p>
      )}
      <details className="text-[12px]">
        <summary className="cursor-pointer text-content-faint">
          {t("mate.notebookManage")}
        </summary>
        <div className="mt-2 space-y-2">
          <MemoryHistoryDetails
            mateId={mateId}
            memory={memory}
            onChanged={reload}
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              className="btn-ghost !px-2"
              onClick={() => setEditing(true)}
            >
              {t("mateSettings.memEdit")}
            </button>
            <button
              className="btn-ghost !px-2"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  updateMemory(mateId, memory.id, {
                    status: memory.status === "active" ? "archived" : "active",
                    expected_revision: memory.revision,
                  }),
                )
              }
            >
              {t(
                memory.status === "active"
                  ? "mateSettings.memArchive"
                  : "mateSettings.memRestore",
              )}
            </button>
            {memory.kind === "plan" && memory.status === "active" && (
              <button
                className="btn-ghost !px-2"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    updateMemory(mateId, memory.id, {
                      status: "done",
                      expected_revision: memory.revision,
                    }),
                  )
                }
              >
                {t("mateSettings.memDone")}
              </button>
            )}
            <button
              className="btn-ghost !px-2 text-danger"
              disabled={busy}
              onClick={() => void act(() => deleteMemory(mateId, memory.id))}
            >
              {t("mateSettings.memForget")}
            </button>
          </div>
        </div>
      </details>
    </article>
  );
}

function EntityCard({
  mateId,
  group,
  reload,
  fail,
}: {
  mateId: string;
  group: MemoryGroup;
  reload: () => void;
  fail: (s: string) => void;
}) {
  const t = useT(),
    e = group.entity;
  return (
    <section
      className="rounded-xl border border-border bg-surface-2/40 p-4"
      data-testid="memory-entity"
      data-entity={e?.id ?? ""}
    >
      <header className="mb-3 flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Icon name={e ? ENTITY_ICON[e.kind] ?? "brain" : "brain"} size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-[14px] font-semibold">
            {e ? e.name : t("mate.notebookUnsorted")}
          </h3>
          <p className="mt-0.5 text-[11px] text-content-faint">
            {e && e.kind !== "user" && e.kind !== "us" ? `${kindLabel(t, e.kind)} · ` : ""}
            {t("mate.notebookItems", { n: group.items.length })}
          </p>
        </div>
      </header>
      {group.items.map((m) => (
        <MemoryCard key={m.id} mateId={mateId} memory={m} reload={reload} fail={fail} />
      ))}
    </section>
  );
}

function EpisodeCard({
  mateId,
  episode,
  reload,
}: {
  mateId: string;
  episode: MemoryEpisode;
  reload: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false),
    [source, setSource] = useState(false);
  return (
    <details
      className="rounded-xl border border-border bg-surface-2/30 p-4"
      onToggle={(e) => setOpen(e.currentTarget.open)}
      data-testid="memory-episode"
    >
      <summary className="cursor-pointer text-[13px] font-medium">
        {episode.entities.length ? episode.entities.join(" · ") : episode.title}
        <span className="ml-2 text-[11px] font-normal text-content-faint">
          {relTime(episode.occurred_at || episode.observed_at)}
        </span>
      </summary>
      {open && (
        <div className="mt-3 space-y-3">
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-content-dim">
            {episode.quote}
          </p>
          <button
            className="btn-ghost !px-0 text-[12px]"
            onClick={() => setSource((v) => !v)}
            aria-expanded={source}
          >
            {t("mate.notebookEpisodeSource")}
          </button>
          {source && (
            <Evidence
              mateId={mateId}
              source={episode.source_id}
              revision={episode.source_revision}
              onForgot={reload}
            />
          )}
        </div>
      )}
    </details>
  );
}

export default function MemoryNotebook({ mate, onSettings }: { mate: Mate; onSettings?: () => void }) {
  const t = useT(),
    rev = useMateStore((s) => s.memoryRev[mate.id] ?? 0),
    prefs = prefsOf(mate);
  const [items, setItems] = useState<Memory[]>([]),
    [episodes, setEpisodes] = useState<MemoryEpisode[]>([]),
    [next, setNext] = useState<string | null>(null);
  const [status, setStatus] = useState<KnowledgeStatus | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all"),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState("");
  const [showing, setShowing] = useState<"active" | "done" | "archived">(
      "active",
    ),
    [refresh, setRefresh] = useState(0),
    [visible, setVisible] = useState(24);
  const [adding, setAdding] = useState(false),
    [saving, setSaving] = useState(false),
    [retrying, setRetrying] = useState(false),
    [moreBusy, setMoreBusy] = useState(false),
    [tidying, setTidying] = useState(false);
  const [probe, setProbe] = useState(""),
    [preview, setPreview] = useState<RecallPreview | null>(null);
  const generation = useRef(0),
    reload = () => setRefresh((n) => n + 1);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => setVisible(24), [filter, search, showing]);
  useEffect(() => setPreview(null), [rev]);
  useEffect(() => {
    const n = ++generation.current;
    setLoading(true);
    Promise.all([
      listMemories(mate.id, { status: showing, sort: "recent" }),
      listMemoryEpisodes(mate.id, undefined, search),
      knowledgeStatus(mate.id),
    ])
      .then(([m, e, s]) => {
        if (n !== generation.current) return;
        setItems(m);
        setEpisodes(e.items);
        setNext(e.next_cursor);
        setStatus(s);
        setError("");
      })
      .catch((e) => {
        if (n === generation.current) setError(e.message);
      })
      .finally(() => {
        if (n === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [mate.id, rev, showing, search, refresh]);
  useEffect(() => {
    const busy = (status?.jobs.pending ?? 0) + (status?.jobs.running ?? 0);
    const sorting = status?.organize?.state === "asked" || status?.organize?.state === "running";
    if (!status || (!busy && !sorting)) return;
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [status]);
  const normalized = search.toLocaleLowerCase();
  const memories = useMemo(
    () =>
      items.filter(
        (m) =>
          (filter === "all" ||
            (filter === "person" && (m.entity?.kind ?? m.subject_type) === "person") ||
            m.kind === filter) &&
          (!normalized ||
            `${m.entity?.name || m.subject || ""} ${m.predicate || ""} ${m.text}`
              .toLocaleLowerCase()
              .includes(normalized)),
      ),
    [items, filter, normalized],
  );
  const groups = useMemo(() => groupByEntity(memories), [memories]);
  const showEpisodes =
    showing === "active" && (filter === "all" || filter === "episodes");
  const pending = (status?.jobs.pending ?? 0) + (status?.jobs.running ?? 0),
    failed = status?.jobs.failed ?? 0,
    last = status?.recent_runs?.[0],
    organize = status?.organize,
    organizing = organize?.state === "asked" || organize?.state === "running";
  const save = async (draft: Draft) => {
    setSaving(true);
    try {
      await addMemory(mate.id, draft);
      setAdding(false);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const retry = async () => {
    setRetrying(true);
    try {
      await retryMemory(mate.id);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetrying(false);
    }
  };
  const tidy = async () => {
    setTidying(true);
    try {
      const state = await organizeMemory(mate.id);
      setStatus((s) => (s ? { ...s, organize: state } : s));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTidying(false);
    }
  };
  const more = async () => {
    const n = generation.current;
    setMoreBusy(true);
    try {
      const data = await listMemoryEpisodes(mate.id, next || undefined, search);
      if (n === generation.current) {
        setEpisodes((old) => [...old, ...data.items]);
        setNext(data.next_cursor);
      }
    } catch (e) {
      if (n === generation.current) setError((e as Error).message);
    } finally {
      setMoreBusy(false);
    }
  };
  return (
    <div className="space-y-4" data-testid="mate-memory-notebook">
      <div className="space-y-3 rounded-2xl border border-accent/20 bg-accent-soft/30 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">
              {t("mate.notebookTitle", { name: mate.name })}
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-content-dim">
              {t("mate.notebookHint")}
            </p>
          </div>
          <button
            className="btn-ghost shrink-0 !px-2"
            onClick={reload}
            aria-label={t("common.reload")}
          >
            <Icon name="refresh" size={15} />
          </button>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
          <span>{t("mate.notebookFactCount", { n: items.length })}</span>
          <span>
            {t("mate.notebookEpisodeCount", {
              n: status?.episodes ?? episodes.length,
            })}
          </span>
        </div>
        <div
          className={`rounded-lg px-3 py-2 text-[12px] ${failed ? "bg-warning/10 text-warning" : "bg-surface-2/60 text-content-dim"}`}
          role="status"
          data-testid="memory-processing-status"
        >
          {!prefs.memory.self_save
            ? t("mate.notebookAutoOff")
            : pending
              ? t("mate.notebookPending", { n: pending })
              : failed
                ? t("mate.notebookFailed", { n: failed })
                : last
                  ? t("mate.notebookLastRun", {
                      when: relTime(last.finished_at || last.started_at),
                      facts: last.facts,
                      episodes: last.episodes,
                    })
                  : t("mate.notebookReady")}
          {onSettings && (
            <button className="ml-2 text-accent hover:underline" onClick={onSettings} data-testid="memory-settings-link">
              {t("mate.notebookSettings")}
            </button>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2" data-testid="memory-organize">
            <span>
              {organizing
                ? t("mate.notebookOrganizing")
                : organize?.state === "done" && organize.at
                  ? t("mate.notebookOrganized", { when: relTime(organize.at) })
                  : organize?.state === "failed"
                    ? t("mate.notebookOrganizeFailed")
                    : t("mate.notebookOrganizeHint")}
            </span>
            {!organizing && items.length > 0 && (
              <button
                className="text-accent hover:underline disabled:opacity-50"
                disabled={tidying}
                onClick={() => void tidy()}
                data-testid="memory-organize-button"
              >
                {t("mate.notebookOrganize")}
              </button>
            )}
          </div>
          {failed > 0 && prefs.memory.self_save && (
            <button
              className="btn-ghost mt-2 !px-0"
              disabled={retrying}
              onClick={() => void retry()}
            >
              {t("mate.notebookRetry")}
            </button>
          )}
        </div>
      </div>
      <ErrorLine text={error} />
      <div className="flex gap-2">
        <input
          type="search"
          className="field min-w-0 flex-1"
          aria-label={t("mateSettings.memSearch")}
          placeholder={t("mate.notebookSearch")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="notebook-search"
        />
        <button
          className="btn-soft shrink-0"
          onClick={() => setAdding((v) => !v)}
          aria-expanded={adding}
          aria-label={t("common.add")}
        >
          <Icon name="plus" size={14} />
          <span className="hidden min-[400px]:inline">{t("common.add")}</span>
        </button>
      </div>
      {adding && (
        <div className="rounded-xl border border-border p-3">
          <MemoryForm
            busy={saving}
            onSave={(draft) => void save(draft)}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}
      <ScrollRow
        className="gap-1"
        role="tablist"
        aria-label={t("mateSettings.memKind")}
        watch={filter}
      >
        {FILTERS.map((f) => (
          <button
            type="button"
            role="tab"
            key={f.id}
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] ${filter === f.id ? "bg-accent-soft text-accent" : "bg-surface-2 text-content-faint hover:text-content"}`}
          >
            {t(f.label)}
          </button>
        ))}
      </ScrollRow>
      {loading && !status ? (
        <p className="text-sm text-content-faint">{t("common.loading")}</p>
      ) : (
        <>
          {!memories.length && (!showEpisodes || !episodes.length) && (
            <div className="rounded-xl border border-dashed border-border p-6 text-center text-[13px] leading-relaxed text-content-dim">
              {t(normalized ? "mate.notebookNoMatch" : "mate.notebookEmpty")}
            </div>
          )}
          {groups.length > 0 && (
            <div className="space-y-3" data-testid="notebook-facts">
              {groups.slice(0, visible).map((g) => (
                <EntityCard
                  key={g.key}
                  mateId={mate.id}
                  group={g}
                  reload={reload}
                  fail={setError}
                />
              ))}
              {groups.length > visible && (
                <button
                  className="btn-soft"
                  onClick={() => setVisible((v) => v + 24)}
                >
                  {t("mateSettings.knowledgeMore")}
                </button>
              )}
            </div>
          )}
          {showEpisodes && episodes.length > 0 && (
            <section className="space-y-3" data-testid="notebook-episodes">
              <h3 className="px-1 text-[12px] font-medium text-content-faint">
                {t("mate.notebookExperiences")}
              </h3>
              {episodes.map((e) => (
                <EpisodeCard
                  key={e.id}
                  mateId={mate.id}
                  episode={e}
                  reload={reload}
                />
              ))}
            </section>
          )}
          {showEpisodes && next && (
            <button
              className="btn-soft"
              disabled={moreBusy || loading}
              onClick={() => void more()}
            >
              {t("mateSettings.knowledgeMore")}
            </button>
          )}
        </>
      )}
      <details className="rounded-xl border border-border p-4">
        <summary className="cursor-pointer text-[13px] text-content-dim">
          {t("mate.notebookOptions")}
        </summary>
        <div className="mt-4 space-y-4">
          <label className="block space-y-2 text-[12px] text-content-dim">
            {t("mateSettings.memShow")}
            <select
              className="field"
              value={showing}
              onChange={(e) => setShowing(e.target.value as typeof showing)}
            >
              {(["active", "done", "archived"] as const).map((id) => (
                <option key={id} value={id}>
                  {t(
                    (
                      {
                        active: "mateSettings.memShowActive",
                        done: "mateSettings.memShowDone",
                        archived: "mateSettings.memShowArchived",
                      } as const
                    )[id],
                  )}
                </option>
              ))}
            </select>
          </label>
          <details className="text-[12px]">
            <summary className="cursor-pointer text-content-dim">
              {t("mateSettings.memTest")}
            </summary>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void previewRecall(mate.id, probe)
                  .then(setPreview)
                  .catch((e) => setError(e.message));
              }}
            >
              <input
                className="field min-w-0 flex-1"
                value={probe}
                onChange={(e) => setProbe(e.target.value)}
                placeholder={t("mateSettings.memTestPh")}
                aria-label={t("mateSettings.memTest")}
              />
              <button className="btn-soft shrink-0">
                {t("mateSettings.memTestRun")}
              </button>
            </form>
            {preview && (
              <div className="mt-2 space-y-2" role="status">
                {[...preview.core, ...preview.recalled].map((m) => (
                  <p
                    key={m.id}
                    className="rounded-lg bg-surface-2 p-2 text-content-dim"
                  >
                    {m.text}
                  </p>
                ))}
                {!preview.core.length && !preview.recalled.length && (
                  <p className="text-content-faint">
                    {t("mateSettings.memEmpty")}
                  </p>
                )}
              </div>
            )}
          </details>
        </div>
      </details>
      <details className="rounded-xl border border-border p-4">
        <summary className="cursor-pointer text-[13px] text-content-dim">
          {t("mate.notebookOriginals")}
        </summary>
        <div className="mt-4">
          <KnowledgePanel mateId={mate.id} rev={rev} />
        </div>
      </details>
    </div>
  );
}
