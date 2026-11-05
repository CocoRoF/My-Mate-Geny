import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { stopTask } from "../../../api/sessions";
import { useChatStore, withDetached, type ToolActivity, type Turn } from "../../../stores/chatStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { useSubagentUi } from "../../../stores/subagentStore";
import { useTaskStore } from "../../../stores/taskStore";
import { useBackHandler } from "../../../lib/back";
import Icon from "../../ui/Icon";
import Markdown from "../../ui/Markdown";
import ThinkingBlock from "./ThinkingBlock";
import ToolGroup from "./ToolGroup";
import { FullToolNote, useFullTools } from "./useFullTool";
import SubagentCard, { StatusIcon, StatusPill, useAgentView } from "./SubagentCard";
import { agentStatus, allAgents, isAgentTool, taskFor } from "./subagent";
import { fmtMs } from "./toolMeta";
import { useT } from "../../../i18n";

const turnWith = (turns: Turn[], id: string) => {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].tools.some((t) => t.id === id)) return turns[i];
  return null;
};

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

/** Shared shell: full-screen sheet on phones, centered dialog on wider screens. */
function Sheet({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-stretch justify-center bg-scrim/50 backdrop-blur-[2px] sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full flex-col bg-surface pt-safe pb-safe shadow-float animate-fade-in sm:h-auto sm:max-h-[88vh] sm:max-w-3xl sm:rounded-2xl sm:border sm:border-border sm:pt-0"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

type Seg =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; at: number; endedAt?: number; timingKnown?: boolean; scope?: "response" }
  | { kind: "tools"; tools: ToolActivity[] }
  | { kind: "agent"; tool: ToolActivity };

function StopButton({ sid, taskId }: { sid: string; taskId: string }) {
  const t = useT();
  const [stopping, setStopping] = useState(false);
  return (
    <button
      onClick={async () => {
        setStopping(true);
        try {
          await stopTask(sid, taskId);
        } finally {
          setTimeout(() => setStopping(false), 4000);
        }
      }}
      disabled={stopping}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] text-content-dim transition hover:border-danger/50 hover:text-danger disabled:opacity-40"
      title={t("turn.stopSubagent")}
      aria-label={t("turn.stopSubagent")}
    >
      {stopping ? <Icon name="spinner" size={12} spin /> : <span className="block w-2.5 h-2.5 rounded-[2px] bg-current" />}
      <span className="hidden sm:inline">{t("common.stop")}</span>
    </button>
  );
}

const SectionTitle = ({ children }: { children: ReactNode }) => (
  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-content-faint">{children}</div>
);

/** Everything one subagent did: prompt, its prose/reasoning and calls in order, its report. */
function Detail({ id, depth, onBack, onClose }: { id: string; depth: number; onBack: () => void; onClose: () => void }) {
  // (or under background work whose turn isn't loaded yet)
  const t = useT();
  const turn = useChatStore((s) => turnWith(s.turns, id) || (s.detached ? turnWith([s.detached], id) : null));
  const tool = turn?.tools.find((x) => x.id === id);
  if (!turn || !tool) {
    return (
      <Sheet onClose={onClose}>
        <div className="flex h-14 items-center justify-between border-b border-border px-4 text-sm text-content-dim">
          {t("turn.subagentNotFound")}
          <button onClick={onClose} className="rounded-md p-1 text-content-faint hover:bg-surface-3 hover:text-content" aria-label={t("common.close")}>
            <Icon name="x" size={17} />
          </button>
        </div>
      </Sheet>
    );
  }
  return <DetailBody turn={turn} tool={tool} depth={depth} onBack={onBack} onClose={onClose} />;
}

function DetailBody({
  turn,
  tool,
  depth,
  onBack,
  onClose,
}: {
  turn: Turn;
  tool: ToolActivity;
  depth: number;
  onBack: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const v = useAgentView(tool, turn.tools);
  const full = useFullTools([tool], true); // its prompt / report in full (a lite page has previews)
  const sid = useSessionStore((s) => s.activeId);
  const running = v.status === "running";
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const segments = useMemo(() => {
    const byId = new Map(v.children.map((c) => [c.id, c]));
    const out: Seg[] = [];
    const steps = tool.sub || [];
    steps.forEach((item, idx) => {
      const last = out[out.length - 1];
      if (item.kind === "text") {
        // its closing message is the report, shown once under Result
        if (!item.text.trim() || (idx === steps.length - 1 && item.text.trim() === v.result.trim())) return;
        if (last?.kind === "text") last.text += `\n\n${item.text}`;
        else out.push({ kind: "text", text: item.text });
      } else if (item.kind === "thinking") {
        out.push({ ...item });
      } else {
        const c = byId.get(item.toolId);
        if (!c) return;
        if (isAgentTool(c)) out.push({ kind: "agent", tool: c });
        else if (last?.kind === "tools") last.tools.push(c);
        else out.push({ kind: "tools", tools: [c] });
      }
    });
    // Calls recorded without their order (shouldn't happen): still listed.
    const placed = new Set((tool.sub || []).filter((s) => s.kind === "tool").map((s) => (s as { toolId: string }).toolId));
    const loose = v.children.filter((c) => !placed.has(c.id));
    if (loose.length) out.push({ kind: "tools", tools: loose });
    return out;
  }, [tool.sub, v.children, v.result]);

  // Follow live output while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && running && stick.current) el.scrollTop = el.scrollHeight;
  }, [segments, running]);

  const meta = [
    v.type,
    v.background ? t("turn.background") : null,
    tool.agent?.model,
    v.toolCount ? t("turn.toolsN", { count: v.toolCount }) : null,
    tool.agent?.total_tokens || v.task?.total_tokens ? t("turn.tokensN", { n: k(tool.agent?.total_tokens || v.task?.total_tokens || 0) }) : null,
    fmtMs(v.elapsedMs),
  ].filter(Boolean);
  const failedOutput = v.status === "failed" && tool.isError ? tool.output || "" : "";

  return (
    <Sheet onClose={onClose}>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-4">
        {depth > 0 ? (
          <button onClick={onBack} className="rounded-md p-1 text-content-faint hover:bg-surface-3 hover:text-content" title={t("common.back")} aria-label={t("common.back")}>
            <Icon name="chevron-left" size={17} />
          </button>
        ) : (
          <span className="grid place-items-center w-7 h-7 shrink-0 rounded-lg bg-violet/12 text-violet">
            <Icon name="bolt" size={14} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-sm font-semibold text-content">{v.title}</span>
            <StatusPill status={v.status} />
          </div>
          <div className="truncate font-mono text-[10.5px] text-content-faint">{meta.join(" · ")}</div>
        </div>
        {running && sid && v.task?.task_id && <StopButton sid={sid} taskId={v.task.task_id} />}
        <button onClick={onClose} className="rounded-md p-1 text-content-faint hover:bg-surface-3 hover:text-content" title={t("common.close")} aria-label={t("common.close")}>
          <Icon name="x" size={17} />
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
      >
        {tool.lazy && <FullToolNote failed={full.failed} retry={full.retry} />}
        {v.prompt && !tool.lazy && (
          <section>
            <SectionTitle>{t("turn.prompt")}</SectionTitle>
            <details open={v.prompt.length <= 600} className="group rounded-lg border border-border bg-bg/50">
              <summary className="cursor-pointer select-none px-3 py-1.5 text-[11.5px] text-content-faint hover:text-content-dim">
                <span className="group-open:hidden">{v.prompt.slice(0, 140).replace(/\s+/g, " ")}… {t("turn.showAll")}</span>
                <span className="hidden group-open:inline">{t("turn.promptHint")}</span>
              </summary>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-border/70 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-content-dim">
                {v.prompt}
              </pre>
            </details>
          </section>
        )}

        <section className="space-y-2.5">
          <SectionTitle>{t("turn.activity")}</SectionTitle>
          {segments.length === 0 && (
            <p className="text-[12.5px] text-content-faint">
              {running
                ? v.task?.activity || t("turn.waitingFirstStep")
                : t("turn.noSteps")}
            </p>
          )}
          {segments.map((s, i) => {
            switch (s.kind) {
              case "text":
                return (
                  <div key={i} className="text-[13.5px]">
                    <Markdown>{s.text}</Markdown>
                  </div>
                );
              case "thinking":
                return <ThinkingBlock key={i} text={s.text} startedAt={s.at} endedAt={s.endedAt} timingKnown={s.timingKnown} scope={s.scope} live={running} />;
              case "tools":
                return <ToolGroup key={i} tools={s.tools} allTools={turn.tools} defaultOpen />;
              case "agent":
                return <SubagentCard key={i} tool={s.tool} allTools={turn.tools} />;
            }
          })}
          {running && (
            <div className="flex items-center gap-1.5 py-1 text-sm text-content-faint">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot" />
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot [animation-delay:0.2s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot [animation-delay:0.4s]" />
              {segments.length > 0 && <span className="ml-1 truncate text-[12px]">{v.activity}</span>}
            </div>
          )}
        </section>

        {(v.result || failedOutput) && (
          <section>
            <SectionTitle>{failedOutput ? t("common.error") : t("turn.result")}</SectionTitle>
            {failedOutput ? (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-danger/30 bg-danger/8 p-2.5 font-mono text-[11.5px] text-danger/90 light:text-danger">
                {failedOutput}
              </pre>
            ) : (
              <div className="rounded-lg border border-border bg-bg/50 p-3 text-[13px]">
                <Markdown>{v.result}</Markdown>
              </div>
            )}
          </section>
        )}
      </div>
    </Sheet>
  );
}

/** Every subagent in this chat: running first, then the latest finished ones. */
function AgentList({ onClose }: { onClose: () => void }) {
  const loaded = useChatStore((s) => s.turns);
  const detached = useChatStore((s) => s.detached);
  const turns = useMemo(() => withDetached(loaded, detached), [loaded, detached]);
  const sid = useSessionStore((s) => s.activeId);
  const tasks = useTaskStore((s) => (sid ? s.bySession[sid] : undefined));
  const agents = useMemo(() => allAgents(turns), [turns]);
  const running = agents.filter((a) => agentStatus(a.tool, taskFor(a.tool, tasks)) === "running");
  const done = agents.filter((a) => !running.includes(a)).slice(0, 50);
  const t = useT();
  return (
    <Sheet onClose={onClose}>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <Icon name="bolt" size={16} className="text-violet" />
        <span className="text-sm font-semibold">{t("turn.subagents")}</span>
        {running.length > 0 && <span className="pill bg-accent-soft text-accent">{t("turn.runningN", { n: running.length })}</span>}
        <button onClick={onClose} className="ml-auto rounded-md p-1 text-content-faint hover:bg-surface-3 hover:text-content" aria-label={t("common.close")}>
          <Icon name="x" size={17} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {agents.length === 0 && (
          <p className="py-12 text-center text-[13px] text-content-dim">{t("turn.noSubagents")}</p>
        )}
        {running.length > 0 && (
          <section>
            <SectionTitle>{t("turn.runningSection", { n: running.length })}</SectionTitle>
            <div className="space-y-1.5">
              {running.map((a) => (
                <SubagentCard key={a.tool.id} tool={a.tool} allTools={a.turn.tools} />
              ))}
            </div>
          </section>
        )}
        {done.length > 0 && (
          <section>
            <SectionTitle>{t("turn.finishedSection", { n: done.length })}</SectionTitle>
            <div className="space-y-1.5">
              {done.map((a) => (
                <SubagentCard key={a.tool.id} tool={a.tool} allTools={a.turn.tools} />
              ))}
            </div>
          </section>
        )}
      </div>
    </Sheet>
  );
}

/** The subagent list + detail views (one layer per chat). */
export function SubagentLayer() {
  const stack = useSubagentUi((s) => s.stack);
  const listOpen = useSubagentUi((s) => s.listOpen);
  const back = useSubagentUi((s) => s.back);
  const setList = useSubagentUi((s) => s.setList);
  const closeAll = useSubagentUi((s) => s.closeAll);
  const activeId = useSessionStore((s) => s.activeId);

  useEffect(() => closeAll, [activeId, closeAll]); // another chat: nothing stays open
  useBackHandler(listOpen, () => setList(false));
  useBackHandler(stack.length > 0, back);
  useEffect(() => {
    if (!stack.length && !listOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".z-\\[100\\]")) return; // a lightbox closes first
      if (useSubagentUi.getState().stack.length) back();
      else setList(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stack.length, listOpen, back, setList]);

  const top = stack[stack.length - 1];
  return (
    <>
      {listOpen && <AgentList onClose={() => setList(false)} />}
      {top && <Detail key={top} id={top} depth={stack.length - 1} onBack={back} onClose={closeAll} />}
    </>
  );
}

/** "2 subagents running" — at a glance, near the bottom of the chat. */
export function SubagentPill() {
  const loaded = useChatStore((s) => s.turns);
  const detached = useChatStore((s) => s.detached);
  const turns = useMemo(() => withDetached(loaded, detached), [loaded, detached]);
  const sid = useSessionStore((s) => s.activeId);
  const tasks = useTaskStore((s) => (sid ? s.bySession[sid] : undefined));
  const setList = useSubagentUi((s) => s.setList);
  const running = useMemo(
    () => allAgents(turns).filter((a) => agentStatus(a.tool, taskFor(a.tool, tasks)) === "running").length,
    [turns, tasks],
  );
  const t = useT();
  if (!running) return null;
  return (
    <button
      onClick={() => setList(true)}
      className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-violet/30 bg-surface-2 px-3 py-1.5 text-[12px] text-content-dim shadow-float transition hover:text-content animate-fade-in"
      title={t("turn.showSubagents")}
    >
      <StatusIcon status="running" size={12} />
      {t("turn.subagentsRunning", { count: running })}
    </button>
  );
}
