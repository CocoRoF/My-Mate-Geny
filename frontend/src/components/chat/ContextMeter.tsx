import { useState } from "react";
import {
  COMPACT_BUFFER,
  DEFAULT_PRESETS,
  WINDOW_HINT,
  ctxBar,
  ctxTone,
  fmtCtx,
  fmtWindow,
  limitsFor,
  meterOf,
  presetLabel,
  type Meter,
} from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";
import { useConfigStore } from "../../stores/configStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useUsageStore } from "../../stores/usageStore";
import type { Compaction, ContextInfo, Session } from "../../types";
import HoverPopover from "../ui/HoverPopover";
import Icon from "../ui/Icon";

const clock = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";

function Bar({ m }: { m: Meter }) {
  const fill = m.pct ?? 0;
  const mark = m.threshold ? Math.min(100, (m.threshold / m.window) * 100) : null;
  return (
    <div className="relative mt-2 h-2 overflow-visible rounded-full bg-accent/15">
      <div className={`h-full rounded-full ${ctxBar(m.toCompact)}`} style={{ width: `${fill}%` }} />
      {mark !== null && (
        <span
          className="absolute -top-0.5 h-3 w-0.5 rounded bg-content-dim"
          style={{ left: `calc(${mark}% - 1px)` }}
          title={`Auto-compacts at ${fmtCtx(m.threshold)}`}
        />
      )}
    </div>
  );
}

function Panel({
  session,
  m,
  ctx,
  last,
  configured,
  globalDefault,
  onCompact,
}: {
  session: Session;
  m: Meter;
  ctx: ContextInfo | null;
  last: Compaction | null;
  configured: number;
  globalDefault: number;
  onCompact: () => void;
}) {
  const isStreaming = useChatStore((s) => s.isStreaming);
  const update = useSessionStore((s) => s.update);
  const presets = useConfigStore((s) => s.catalog.claude?.auto_compact_presets) || DEFAULT_PRESETS;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const own = session.auto_compact_window ?? null;
  const pending = !!ctx?.window && ctx.window_source !== "estimate" && limitsFor(session.model, configured).window !== ctx.window;

  const choose = async (value: number) => {
    setBusy(true);
    setError("");
    try {
      await update(session.id, { auto_compact_window: value });
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const left = m.threshold && m.tokens !== null ? Math.max(0, m.threshold - m.tokens) : null;
  const source =
    ctx?.source === "cli" ? "the engine's own count after the last reply" : ctx?.source === "call" ? "the latest model call" : "";

  return (
    <div className="w-[330px] p-3 text-[12px]">
      <div className="flex items-center gap-2">
        <Icon name="activity" size={13} className="text-accent" />
        <span className="font-medium text-content">Context window</span>
        {m.pct !== null && <span className={`ml-auto font-mono ${ctxTone(m.toCompact)}`}>{Math.round(m.pct)}%</span>}
      </div>
      <Bar m={m} />
      <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
        <dt className="text-content-faint">In context</dt>
        <dd className="text-right font-mono text-content-dim">
          {m.tokens === null ? "after the first reply" : `${m.tokens.toLocaleString("en-US")} tokens`}
        </dd>
        <dt className="text-content-faint">Window</dt>
        <dd className="text-right font-mono text-content-dim">
          {fmtWindow(m.window)}
          {ctx?.model_window && ctx.model_window !== m.window ? ` (model ${fmtWindow(ctx.model_window)})` : ""}
        </dd>
        <dt className="text-content-faint">Auto-compacts at</dt>
        <dd className="text-right font-mono text-content-dim">
          {m.threshold === null ? "off" : `${fmtCtx(m.threshold)}${left !== null ? ` · ${fmtCtx(left)} to go` : ""}`}
        </dd>
        <dt className="text-content-faint">Last compaction</dt>
        <dd className="text-right font-mono text-content-dim">
          {last
            ? `${last.trigger || ""} ${clock(last.at)}${
                typeof last.pre_tokens === "number" && typeof last.post_tokens === "number"
                  ? ` · ${fmtCtx(last.pre_tokens)} → ${fmtCtx(last.post_tokens)}`
                  : ""
              }`.trim()
            : "none in this chat"}
        </dd>
      </dl>
      {source && (
        <p className="mt-1.5 text-[10.5px] text-content-faint">
          From {source}
          {ctx?.at ? `, ${clock(ctx.at)}` : ""}. Size = the last model call's input + cache read + cache write tokens.
        </p>
      )}
      {m.estimated && m.tokens !== null && (
        <p className="mt-1 text-[10.5px] text-content-faint">Window estimated from the model until the engine reports it.</p>
      )}

      <button
        onClick={onCompact}
        disabled={isStreaming || m.tokens === null}
        className="btn-soft mt-2.5 w-full justify-center py-1.5 text-[12px] disabled:opacity-50"
        title={isStreaming ? "Wait for the current turn to finish" : "Summarise the conversation now (/compact)"}
      >
        <Icon name="file-text" size={13} /> Compact now
      </button>

      <div className="mt-3 border-t border-border/70 pt-2.5">
        <div className="text-[11px] font-medium text-content">Auto-compact window · this chat</div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          <button
            disabled={busy}
            onClick={() => choose(-1)}
            className={`pill ${own === null ? "bg-accent-soft text-accent" : "bg-surface-3 text-content-dim hover:text-content"}`}
            title="Use the default from the Providers page"
          >
            Default ({presetLabel(globalDefault)})
          </button>
          {presets.map((p) => (
            <button
              key={p}
              disabled={busy}
              onClick={() => choose(p)}
              className={`pill ${own === p ? "bg-accent-soft text-accent" : "bg-surface-3 text-content-dim hover:text-content"}`}
              title={p === 0 ? "The model's full window — same as Claude Code" : `Compact at about ${fmtWindow(p - COMPACT_BUFFER)}`}
            >
              {presetLabel(p)}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[10.5px] leading-snug text-content-faint">
          {WINDOW_HINT} Applies from the next message (the engine restarts; running background tasks stop).
        </p>
        {pending && <p className="mt-1 text-[10.5px] text-warning">Changed — takes effect with the next message.</p>}
        {error && <p className="mt-1 text-[10.5px] text-danger">{error}</p>}
      </div>
    </div>
  );
}

/** Composer footer: how full the agent's context is, against the window the
 * CLI uses and its auto-compact point (Claude). */
export default function ContextMeter({ session, onCompact }: { session: Session; onCompact: () => void }) {
  const ctx = useChatStore((s) => s.context);
  const last = useChatStore((s) => s.lastCompaction);
  const globalDefault = useUsageStore((s) => s.accounts[session.provider]?.pool?.auto_compact_window) ?? 0;
  const buffer = useConfigStore((s) => s.catalog.claude?.auto_compact_buffer) || COMPACT_BUFFER;
  if (session.provider !== "claude") return null;

  const configured = session.auto_compact_window ?? globalDefault;
  const m = meterOf(ctx, limitsFor(ctx?.model || session.model, configured, buffer));

  return (
    <HoverPopover
      label="Context window"
      triggerClassName={`inline-flex items-center gap-1 rounded px-1 -mx-1 py-0.5 hover:bg-surface-3 transition ${ctxTone(m.toCompact)}`}
      trigger={
        <>
          <span className="text-content-faint">ctx</span>
          {m.tokens === null ? (
            <span>—</span>
          ) : (
            <>
              <span className="hidden sm:inline">
                {fmtCtx(m.tokens)} / {fmtWindow(m.window)} ·
              </span>
              <span>{Math.round(m.pct ?? 0)}%</span>
            </>
          )}
        </>
      }
    >
      {() => (
        <Panel
          session={session}
          m={m}
          ctx={ctx}
          last={last}
          configured={configured}
          globalDefault={globalDefault}
          onCompact={onCompact}
        />
      )}
    </HoverPopover>
  );
}
