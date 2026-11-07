import { useState } from "react";
import {
  COMPACT_BUFFER,
  DEFAULT_PRESETS,
  ctxBar,
  ctxTone,
  fmtCtx,
  fmtWindow,
  limitsFor,
  meterOf,
  presetLabel,
  windowHint,
  type Meter,
} from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";
import { useConfigStore } from "../../stores/configStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useUsageStore } from "../../stores/usageStore";
import type { Compaction, ContextInfo, Session } from "../../types";
import HoverPopover from "../ui/HoverPopover";
import Icon from "../ui/Icon";
import { useT } from "../../i18n";
import { fmtNum, fmtTime } from "../../i18n/format";

const clock = (iso?: string) => (iso ? fmtTime(iso) : "");

function Bar({ m }: { m: Meter }) {
  const t = useT();
  const fill = m.pct ?? 0;
  const mark = m.threshold ? Math.min(100, (m.threshold / m.window) * 100) : null;
  return (
    <div className="relative mt-2 h-2 overflow-visible rounded-full bg-accent/15">
      <div className={`h-full rounded-full ${ctxBar(m.toCompact)}`} style={{ width: `${fill}%` }} />
      {mark !== null && (
        <span
          className="absolute -top-0.5 h-3 w-0.5 rounded bg-content-dim"
          style={{ left: `calc(${mark}% - 1px)` }}
          title={t("chat.autoCompactsAtTitle", { n: fmtCtx(m.threshold) })}
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
  const t = useT();
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
    ctx?.source === "cli" ? t("chat.ctxSourceCli") : ctx?.source === "call" ? t("chat.ctxSourceCall") : "";

  return (
    <div className="w-[330px] p-3 text-[12px]">
      <div className="flex items-center gap-2">
        <Icon name="activity" size={13} className="text-accent" />
        <span className="font-medium text-content">{t("chat.contextWindow")}</span>
        {m.pct !== null && <span className={`ml-auto font-mono ${ctxTone(m.toCompact)}`}>{Math.round(m.pct)}%</span>}
      </div>
      <Bar m={m} />
      <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
        <dt className="text-content-faint">{t("chat.inContext")}</dt>
        <dd className="text-right font-mono text-content-dim">
          {m.tokens === null ? t("chat.afterFirstReply") : t("chat.tokensN", { n: fmtNum(m.tokens) })}
        </dd>
        <dt className="text-content-faint">{t("chat.window")}</dt>
        <dd className="text-right font-mono text-content-dim">
          {fmtWindow(m.window)}
          {ctx?.model_window && ctx.model_window !== m.window ? ` (${t("chat.modelWindow", { n: fmtWindow(ctx.model_window) })})` : ""}
        </dd>
        <dt className="text-content-faint">{t("chat.autoCompactsAt")}</dt>
        <dd className="text-right font-mono text-content-dim">
          {m.threshold === null ? t("common.off") : `${fmtCtx(m.threshold)}${left !== null ? ` · ${t("chat.toGo", { n: fmtCtx(left) })}` : ""}`}
        </dd>
        <dt className="text-content-faint">{t("chat.lastCompaction")}</dt>
        <dd className="text-right font-mono text-content-dim">
          {last
            ? `${last.trigger === "auto" ? t("chat.triggerAuto") : last.trigger === "manual" ? t("chat.triggerManual") : last.trigger || ""} ${clock(last.at)}${
                typeof last.pre_tokens === "number" && typeof last.post_tokens === "number"
                  ? ` · ${fmtCtx(last.pre_tokens)} → ${fmtCtx(last.post_tokens)}`
                  : ""
              }`.trim()
            : t("chat.noneInChat")}
        </dd>
      </dl>
      {source && (
        <p className="mt-1.5 text-[10.5px] text-content-faint">
          {t("chat.ctxFrom", { source: ctx?.at ? `${source}, ${clock(ctx.at)}` : source })}
        </p>
      )}
      {m.estimated && m.tokens !== null && (
        <p className="mt-1 text-[10.5px] text-content-faint">{t("chat.windowEstimated")}</p>
      )}

      <button
        onClick={onCompact}
        disabled={isStreaming || m.tokens === null}
        className="btn-soft mt-2.5 w-full justify-center py-1.5 text-[12px] disabled:opacity-50"
        title={isStreaming ? t("chat.waitTurn") : t("chat.compactNowTitle")}
      >
        <Icon name="file-text" size={13} /> {t("chat.compactNow")}
      </button>

      <div className="mt-3 border-t border-border/70 pt-2.5">
        <div className="text-[11px] font-medium text-content">{t("chat.autoCompactWindowChat")}</div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          <button
            disabled={busy}
            onClick={() => choose(-1)}
            className={`pill ${own === null ? "bg-accent-soft text-accent" : "bg-surface-3 text-content-dim hover:text-content"}`}
            title={t("chat.useProvidersDefault")}
          >
            {t("common.default")} ({presetLabel(globalDefault)})
          </button>
          {presets.map((p) => (
            <button
              key={p}
              disabled={busy}
              onClick={() => choose(p)}
              className={`pill ${own === p ? "bg-accent-soft text-accent" : "bg-surface-3 text-content-dim hover:text-content"}`}
              title={p === 0 ? t("chat.fullWindowTitle") : t("chat.compactAtAbout", { n: fmtWindow(p - COMPACT_BUFFER) })}
            >
              {presetLabel(p)}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[10.5px] leading-snug text-content-faint">
          {windowHint()} {t("chat.appliesNext")}
        </p>
        {pending && <p className="mt-1 text-[10.5px] text-warning">{t("chat.changedNext")}</p>}
        {error && <p className="mt-1 text-[10.5px] text-danger">{error}</p>}
      </div>
    </div>
  );
}

/** Composer footer: how full the agent's context is, against the window the
 * CLI uses and its auto-compact point (Claude). */
export default function ContextMeter({ session, onCompact }: { session: Session; onCompact: () => void }) {
  const t = useT();
  const ctx = useChatStore((s) => s.context);
  const last = useChatStore((s) => s.lastCompaction);
  const globalDefault = useUsageStore((s) => s.accounts[session.provider]?.pool?.auto_compact_window) ?? 0;
  const buffer = useConfigStore((s) => s.catalog.claude?.auto_compact_buffer) || COMPACT_BUFFER;
  if (session.provider !== "claude") return null;

  const configured = session.auto_compact_window ?? globalDefault;
  const m = meterOf(ctx, limitsFor(ctx?.model || session.model, configured, buffer));

  return (
    <HoverPopover
      label={t("chat.contextWindow")}
      triggerClassName={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 -mx-1 py-0.5 hover:bg-surface-3 transition ${ctxTone(m.toCompact)}`}
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
