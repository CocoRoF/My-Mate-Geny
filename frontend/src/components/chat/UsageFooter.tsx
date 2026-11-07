import { useEffect, useMemo, useState } from "react";
import type { Account } from "../../api/accounts";
import {
  apiCostHint,
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
import { useT, type MsgKey } from "../../i18n";
import { fmtTime, relTime } from "../../i18n/format";

const STATUS_STYLE: Record<string, string> = {
  ready: "bg-success/12 text-success",
  cooldown: "bg-warning/15 text-warning",
  expired: "bg-danger/15 text-danger",
};
const STATUS_LABEL: Record<string, MsgKey> = { ready: "chat.stReady", cooldown: "chat.stCooldown", expired: "chat.stExpired" };

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
  const t = useT();
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
        <span className="font-medium text-content">{t("chat.accountsOf", { label })}</span>
        {!pool && <Icon name="spinner" size={12} spin className="ml-auto text-content-faint" />}
      </div>
      <p className="mt-1 text-[11px] text-content-faint">
        {current?.account
          ? t.rich(current.live === false ? "chat.runsOnLast" : "chat.runsOn", { account: <span className="text-content-dim">{current.account}</span> })
          : t("chat.picksAccount")}
        {pool?.pool && !pool.pool.enabled && ` ${t("chat.balancingOff")}`}
        {balancing && ` ${t("chat.balancingOn")}`}
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
                {mine && <span className="pill bg-accent-soft text-accent">{t("chat.thisChat")}</span>}
                <span className={`pill ${STATUS_STYLE[a.status] || "bg-surface-3 text-content-faint"}`}>{STATUS_LABEL[a.status] ? t(STATUS_LABEL[a.status]) : a.status}</span>
                {!a.enabled && <span className="pill bg-surface-3 text-content-faint">{t("chat.disabled")}</span>}
                {a.in_flight > 0 && <span className="ml-auto text-[10.5px] text-accent">{t("chat.activeN", { n: a.in_flight })}</span>}
              </div>
              <div className="mt-2">
                {!a.usable ? (
                  <p className="text-[11px] text-danger/80 light:text-danger">{t("chat.noCredentials")}</p>
                ) : a.auth_mode === "api_key" ? (
                  <p className="text-[11px] text-content-faint">{t("chat.apiKeyNoLimits")}</p>
                ) : (
                  <PlanWindowBars windows={windowsFor(a, mine, live)} />
                )}
                {a.plan_error && a.usable && (
                  <p className="mt-1 truncate text-[10.5px] text-warning/90 light:text-warning" title={a.plan_error}>
                    {t("chat.couldntRefresh", { error: a.plan_error })}
                  </p>
                )}
                {a.status === "cooldown" && a.cooldown_until && (
                  <p className="mt-1 text-[10.5px] text-warning/90 light:text-warning">
                    {t(a.limit ? "chat.limitCoolingUntil" : "chat.coolingUntil", { time: fmtTime(a.cooldown_until) })}
                  </p>
                )}
                {a.primary && balancing && a.primary_mode && a.primary_mode !== "normal" && (
                  <p className="mt-1 text-[10.5px] text-content-faint">
                    {a.primary_mode === "off" ? t("chat.primaryOff") : t("chat.primaryFallback")}
                  </p>
                )}
                {balancing && !mine && a.usable && a.eligible && (
                  <button
                    onClick={() => switchTo(a)}
                    disabled={!!switching}
                    className="btn-ghost mt-1.5 py-0.5 px-1.5 text-[11px]"
                    title={t("chat.useForChatTitle")}
                  >
                    {switching === a.id ? <Icon name="spinner" size={11} spin /> : <Icon name="refresh" size={11} />}
                    {pinned?.manual && pinned.id === a.id ? t("chat.switchingNext") : t("chat.useForChat")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {error && <p className="text-[11px] text-danger">{error}</p>}
        {pool && !list.length && <p className="text-[11px] text-content-faint">{t("chat.noAccounts")}</p>}
        {current?.account && pool && !known && (
          <p className="text-[11px] text-content-faint">
            {t("chat.notInList", { account: current.account })}
          </p>
        )}
      </div>
      <p className="mt-2.5 text-[10.5px] text-content-faint">
        {t("chat.planUsageFrom")}
        {ago !== null && pool ? ` · ${t("chat.updated", { when: relTime(pool.at) })}` : ""}
        {pool?.error ? ` · ${pool.error}` : ""}.
      </p>
    </div>
  );
}

function CostPanel({ cost, turns, tokens }: { cost: number; turns: number; tokens: ReturnType<typeof sumTokens> }) {
  const t = useT();
  return (
    <div className="w-[300px] p-3 text-[12px]">
      <div className="font-medium text-content">{t("chat.apiEquivalentChat", { cost: fmtUsd(cost) })}</div>
      <p className="mt-1 text-[11px] text-content-faint">{apiCostHint()}</p>
      {tokens.total > 0 && (
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px]">
          <dt className="text-content-faint">{t("chat.tokInput")}</dt>
          <dd className="text-right text-content-dim">{fmtTokens(tokens.input)}</dd>
          <dt className="text-content-faint">{t("chat.tokCacheRead")}</dt>
          <dd className="text-right text-content-dim">{fmtTokens(tokens.cacheRead)}</dd>
          <dt className="text-content-faint">{t("chat.tokCacheWrite")}</dt>
          <dd className="text-right text-content-dim">{fmtTokens(tokens.cacheWrite)}</dd>
          <dt className="text-content-faint">{t("chat.tokOutput")}</dt>
          <dd className="text-right text-content-dim">{fmtTokens(tokens.output)}</dd>
        </dl>
      )}
      <p className="mt-2 text-[10.5px] text-content-faint">
        {t("chat.costedTurns", { count: turns })}
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
  const t = useT();
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
  const costed = useMemo(() => turns.filter((x) => x.costUsd !== undefined), [turns]);
  const costedCount = costed.length + (older?.costed_turns || 0);
  const tokens = useMemo(() => sumTokens([...costed.map((x) => x.usage), older?.usage]), [costed, older]);

  return (
    <span className="contents font-mono sm:flex sm:shrink-0 sm:items-center sm:gap-2">
      <HoverPopover
        label={t("chat.planByAccount")}
        onOpen={() => loadAccounts(provider, 0).catch(() => {})}
        triggerClassName="inline-flex min-w-0 items-center gap-1 rounded px-1 -mx-1 py-0.5 text-content-dim hover:bg-surface-3 hover:text-content transition"
        trigger={
          <>
            <Icon name="cpu" size={10} className="shrink-0 text-content-faint" />
            <span className="min-w-0 max-w-[6.5rem] truncate sm:max-w-[10rem]">{current?.account || t("chat.planFallback")}</span>
            {wl && <span className={`shrink-0 whitespace-nowrap ${worst >= 70 ? pctTone(worst) : ""}`}>· {wl}</span>}
          </>
        }
      >
        {() => <AccountsPanel sid={sid} provider={provider} current={current} live={liveMine} />}
      </HoverPopover>
      {costedCount > 0 && (
        <HoverPopover
          label={t("chat.chatCostLabel")}
          triggerClassName="shrink-0 whitespace-nowrap rounded px-1 -mx-1 py-0.5 text-content-faint hover:bg-surface-3 hover:text-content-dim transition"
          trigger={
            <>
              ≈ {fmtUsd(cost)}
              <span className="hidden sm:inline">
                {" API "}({t("chat.thisChat")})
              </span>
            </>
          }
        >
          <CostPanel cost={cost} turns={costedCount} tokens={tokens} />
        </HoverPopover>
      )}
    </span>
  );
}
