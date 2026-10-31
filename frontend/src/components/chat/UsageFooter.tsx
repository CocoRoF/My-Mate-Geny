import { useEffect, useMemo, useState } from "react";
import type { Account } from "../../api/accounts";
import {
  API_COST_HINT,
  fmtTokens,
  fmtUsd,
  fromAccount,
  fromLive,
  mergeWindows,
  pctTone,
  tokenBreakdown,
  windowsLabel,
  type PlanWindows,
} from "../../lib/usage";
import { useChatStore } from "../../stores/chatStore";
import { useConfigStore } from "../../stores/configStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useUsageStore } from "../../stores/usageStore";
import type { AccountRef, PlanUsage, Session } from "../../types";
import PlanWindowBars from "../usage/PlanWindowBars";
import HoverPopover from "../ui/HoverPopover";
import Icon from "../ui/Icon";

const STATUS_STYLE: Record<string, string> = {
  ready: "bg-success/12 text-success",
  cooldown: "bg-warning/15 text-warning",
  expired: "bg-danger/15 text-danger",
};

/** An account's windows; for the chat's own account, merged with what its
 * engine reported live (whichever is newer per window). */
function windowsFor(a: Account, mine: boolean, live?: PlanUsage): PlanWindows {
  const base = fromAccount(a);
  return mine && live ? mergeWindows(fromLive(live), base) : base;
}

function AccountsPanel({
  sid,
  provider,
  current,
  live,
}: {
  sid: string;
  provider: string;
  current: AccountRef | null;
  live?: PlanUsage;
}) {
  const pool = useUsageStore((s) => s.accounts[provider]);
  const loadAccounts = useUsageStore((s) => s.loadAccounts);
  const update = useSessionStore((s) => s.update);
  const pinned = useSessionStore((s) => s.sessions.find((x) => x.id === sid)?.accounts?.[provider]);
  const label = useConfigStore((s) => s.catalog[provider]?.label) || provider;
  const [switching, setSwitching] = useState("");
  const [error, setError] = useState("");
  const list = pool?.list || [];
  const balancing = !!pool?.pool?.enabled;

  const switchTo = async (a: Account) => {
    setSwitching(a.id);
    setError("");
    try {
      await update(sid, { account_id: a.id });
      await loadAccounts(provider, 0);
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setSwitching("");
    }
  };
  const known = list.some((a) => a.id === current?.account_id);
  const ago = pool ? Math.max(0, Math.round((Date.now() - pool.at) / 1000)) : null;

  return (
    <div className="w-[340px] p-3 text-[12px]">
      <div className="flex items-center gap-2">
        <Icon name="cpu" size={13} className="text-accent" />
        <span className="font-medium text-content">{label} accounts</span>
        {!pool && <Icon name="spinner" size={12} spin className="ml-auto text-content-faint" />}
      </div>
      <p className="mt-1 text-[11px] text-content-faint">
        {current?.account
          ? <>This chat runs on <span className="text-content-dim">{current.account}</span>{current.live === false ? " (its last turn)" : ""}.</>
          : "This chat's engine picks an account when it starts."}
        {pool?.pool && !pool.pool.enabled && " Load balancing is off: chats use the primary account."}
        {balancing &&
          " A chat stays on its account (its prompt cache lives there) and moves only when that account is unavailable or near its limit."}
      </p>

      <div className="mt-2.5 space-y-2">
        {list.map((a) => {
          const mine = a.id === current?.account_id;
          return (
            <div
              key={a.id}
              className={`rounded-lg border p-2.5 ${mine ? "border-accent/50 bg-accent-soft/40" : "border-border bg-surface/50"}`}
            >
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="truncate font-medium text-content max-w-[11rem]">{a.label}</span>
                {mine && <span className="pill bg-accent-soft text-accent">this chat</span>}
                <span className={`pill ${STATUS_STYLE[a.status] || "bg-surface-3 text-content-faint"}`}>{a.status}</span>
                {!a.enabled && <span className="pill bg-surface-3 text-content-faint">disabled</span>}
                {a.in_flight > 0 && <span className="ml-auto text-[10.5px] text-accent">{a.in_flight} active</span>}
              </div>
              <div className="mt-2">
                {!a.usable ? (
                  <p className="text-[11px] text-danger/80">No credentials — sign in on the Providers page.</p>
                ) : a.auth_mode === "api_key" ? (
                  <p className="text-[11px] text-content-faint">API key — no plan limits.</p>
                ) : (
                  <PlanWindowBars windows={windowsFor(a, mine, live)} />
                )}
                {a.plan_error && a.usable && (
                  <p className="mt-1 truncate text-[10.5px] text-warning/90" title={a.plan_error}>
                    Couldn't refresh: {a.plan_error}
                  </p>
                )}
                {a.status === "cooldown" && a.cooldown_until && (
                  <p className="mt-1 text-[10.5px] text-warning/90">
                    {a.limit ? "Hit its limit — " : ""}cooling down until{" "}
                    {new Date(a.cooldown_until).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                  </p>
                )}
                {a.primary && balancing && a.primary_mode && a.primary_mode !== "normal" && (
                  <p className="mt-1 text-[10.5px] text-content-faint">
                    {a.primary_mode === "off" ? "Excluded from load balancing." : "Used only when no other account is available."}
                  </p>
                )}
                {balancing && !mine && a.usable && a.eligible && (
                  <button
                    onClick={() => switchTo(a)}
                    disabled={!!switching}
                    className="btn-ghost mt-1.5 py-0.5 px-1.5 text-[11px]"
                    title="Run this chat on this account from the next message (its engine restarts there)"
                  >
                    {switching === a.id ? <Icon name="spinner" size={11} spin /> : <Icon name="refresh" size={11} />}
                    {pinned?.manual && pinned.id === a.id ? "Switching at the next message" : "Use for this chat"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {error && <p className="text-[11px] text-danger">{error}</p>}
        {pool && !list.length && <p className="text-[11px] text-content-faint">No accounts connected.</p>}
        {current?.account && pool && !known && (
          <p className="text-[11px] text-content-faint">
            {current.account} isn't in the account list (API key or a removed account).
          </p>
        )}
      </div>
      <p className="mt-2.5 text-[10.5px] text-content-faint">
        Plan usage from the provider, cached about a minute
        {ago !== null ? ` · updated ${ago < 5 ? "just now" : `${ago}s ago`}` : ""}
        {pool?.error ? ` · ${pool.error}` : ""}.
      </p>
    </div>
  );
}

function CostPanel({ cost, turns, tokens }: { cost: number; turns: number; tokens: ReturnType<typeof sumTokens> }) {
  return (
    <div className="w-[300px] p-3 text-[12px]">
      <div className="font-medium text-content">≈ {fmtUsd(cost)} API-equivalent (this chat)</div>
      <p className="mt-1 text-[11px] text-content-faint">{API_COST_HINT}</p>
      {tokens.total > 0 && (
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px]">
          <dt className="text-content-faint">Input</dt>
          <dd className="text-right text-content-dim">{fmtTokens(tokens.input)}</dd>
          <dt className="text-content-faint">Cache read</dt>
          <dd className="text-right text-content-dim">{fmtTokens(tokens.cacheRead)}</dd>
          <dt className="text-content-faint">Cache write</dt>
          <dd className="text-right text-content-dim">{fmtTokens(tokens.cacheWrite)}</dd>
          <dt className="text-content-faint">Output</dt>
          <dd className="text-right text-content-dim">{fmtTokens(tokens.output)}</dd>
        </dl>
      )}
      <p className="mt-2 text-[10.5px] text-content-faint">
        {turns} turn{turns === 1 ? "" : "s"} with a reported cost · per-turn amounts are on each reply.
      </p>
    </div>
  );
}

function sumTokens(usages: (Record<string, any> | undefined)[]) {
  const t = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
  for (const u of usages) {
    const b = tokenBreakdown(u);
    if (!b) continue;
    t.input += b.input;
    t.cacheRead += b.cacheRead;
    t.cacheWrite += b.cacheWrite;
    t.output += b.output;
    t.total += b.total;
  }
  return t;
}

/** Composer footer, right side: which account this chat runs on with its
 * 5-hour / 7-day usage (popover: every account), and the chat's
 * API-equivalent cost. */
export default function UsageFooter({ session }: { session: Session }) {
  const sid = session.id;
  const provider = session.provider;
  const current = useUsageStore((s) => s.account[sid] ?? null);
  const live = useUsageStore((s) => s.live[sid]);
  const pool = useUsageStore((s) => s.accounts[provider]);
  const loadAccounts = useUsageStore((s) => s.loadAccounts);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const cost = useChatStore((s) => s.runningCostUsd);
  const turns = useChatStore((s) => s.turns);

  // Server-cached ~60s; also refreshed when a turn ends (Codex reports no
  // live usage) and whenever the popover opens.
  useEffect(() => {
    loadAccounts(provider).catch(() => {});
  }, [provider, isStreaming, loadAccounts]);

  // Live numbers only when they're this chat's account's.
  const liveMine = live && (!current?.account_id || live.account_id === current.account_id) ? live : undefined;
  const row = current?.account_id ? pool?.list.find((a) => a.id === current.account_id) : undefined;
  const windows = mergeWindows(liveMine ? fromLive(liveMine) : undefined, row ? fromAccount(row) : undefined);
  const wl = windowsLabel(windows);
  const worst = Math.max(windows.five?.percent ?? -1, windows.seven?.percent ?? -1);

  // (+ the part of the chat not loaded yet: the server's sums)
  const older = useChatStore((s) => s.older);
  const costed = useMemo(() => turns.filter((t) => t.costUsd !== undefined), [turns]);
  const costedCount = costed.length + (older?.costed_turns || 0);
  const tokens = useMemo(() => sumTokens([...costed.map((t) => t.usage), older?.usage]), [costed, older]);

  return (
    <span className="flex shrink-0 items-center gap-2 font-mono">
      <HoverPopover
        label="Plan usage by account"
        onOpen={() => loadAccounts(provider, 0).catch(() => {})}
        triggerClassName="inline-flex min-w-0 items-center gap-1 rounded px-1 -mx-1 py-0.5 text-content-dim hover:bg-surface-3 hover:text-content transition"
        trigger={
          <>
            <Icon name="cpu" size={10} className="shrink-0 text-content-faint" />
            <span className="truncate max-w-[6.5rem] sm:max-w-[10rem]">{current?.account || "plan"}</span>
            {wl && <span className={worst >= 70 ? pctTone(worst) : ""}>· {wl}</span>}
          </>
        }
      >
        {() => <AccountsPanel sid={sid} provider={provider} current={current} live={liveMine} />}
      </HoverPopover>
      {costedCount > 0 && (
        <HoverPopover
          label="API-equivalent cost of this chat"
          triggerClassName="rounded px-1 -mx-1 py-0.5 text-content-faint hover:bg-surface-3 hover:text-content-dim transition"
          trigger={
            <>
              ≈ {fmtUsd(cost)} API<span className="hidden sm:inline"> (this chat)</span>
            </>
          }
        >
          <CostPanel cost={cost} turns={costedCount} tokens={tokens} />
        </HoverPopover>
      )}
    </span>
  );
}
