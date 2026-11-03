import { useEffect, useMemo, useState } from "react";
import { useProviderStore } from "../../stores/providerStore";
import { useConfigStore } from "../../stores/configStore";
import {
  getPool,
  setPool,
  createAccount,
  updateAccount,
  deleteAccount,
  clearCooldown,
  accountOAuthStart,
  accountOAuthStatus,
  accountOAuthComplete,
  type Account,
  type PoolConfig,
  type PrimaryMode,
  type LimitPriority,
} from "../../api/accounts";
import { fromAccount } from "../../lib/usage";
import { COMPACT_BUFFER, DEFAULT_PRESETS, fmtWindow } from "../../lib/context";
import { useT, type MsgKey } from "../../i18n";
import Icon from "../ui/Icon";
import ProviderOAuthModal from "./ProviderOAuthModal";
import AccountSession, { PlanStaleNote } from "./AccountSession";
import CliVersionsSection from "./CliVersionsSection";
import PlanWindowBars from "../usage/PlanWindowBars";
import UsageModal from "../usage/UsageModal";
import HiggsfieldPanel, { HIGGSFIELD, HiggsfieldTab } from "./HiggsfieldPanel";

const STRATEGIES: { id: string; label: MsgKey }[] = [
  { id: "most_remaining", label: "providers.stratMostRemaining" },
  { id: "least_busy", label: "providers.stratLeastBusy" },
  { id: "round_robin", label: "providers.stratRoundRobin" },
  { id: "weighted", label: "providers.stratWeighted" },
  { id: "least_recently_used", label: "providers.stratLeastRecent" },
];

const STATUS_LABEL: Record<string, MsgKey> = {
  ready: "providers.statusReady",
  cooldown: "providers.statusCooldown",
  expired: "providers.statusExpired",
  unknown: "providers.statusUnknown",
};

// why an account can't take a turn now (backend accounts.ineligible_reason)
const INELIGIBLE_LABEL: Record<string, MsgKey> = {
  disabled: "providers.ineligible_disabled",
  no_credentials: "providers.ineligible_no_credentials",
  expired: "providers.ineligible_expired",
  session_expired: "providers.ineligible_session_expired",
  cooling_down: "providers.ineligible_cooling_down",
  at_capacity: "providers.ineligible_at_capacity",
  excluded: "providers.ineligible_excluded",
};

const STATUS_STYLE: Record<string, string> = {
  ready: "bg-success/15 text-success",
  cooldown: "bg-warning/15 text-warning",
  expired: "bg-danger/15 text-danger",
  unknown: "bg-surface-3 text-content-faint",
};

export default function ProvidersView() {
  const providers = useProviderStore((s) => s.providers);
  const catalog = useConfigStore((s) => s.catalog);
  const [tab, setTab] = useState("");
  const providerIds = useMemo(() => Object.keys(catalog), [catalog]);

  useEffect(() => {
    if (!tab && providerIds.length) setTab(providerIds[0]);
  }, [providerIds, tab]);

  return (
    // (Settings → Providers: the tab's title and intro are Settings' — settings/SettingsView.tsx)
    <div className="max-w-2xl">
      <div>
        {/* Provider tabs */}
        <div className="flex gap-1.5 mb-5 border-b border-border">
          {providerIds.map((id) => {
            const connected = providers.find((p) => p.provider === id)?.connected;
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`relative px-4 py-2 text-sm font-medium transition -mb-px border-b-2 ${
                  tab === id
                    ? "border-accent text-content"
                    : "border-transparent text-content-dim hover:text-content"
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  {catalog[id]?.label || id}
                  <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-success" : "bg-content-faint/50"}`} />
                </span>
              </button>
            );
          })}
          <HiggsfieldTab selected={tab === HIGGSFIELD} onPick={() => setTab(HIGGSFIELD)} />
        </div>

        {tab === HIGGSFIELD ? (
          <HiggsfieldPanel />
        ) : (
          tab && <ProviderPanel key={tab} provider={tab} label={catalog[tab]?.label || tab} />
        )}
      </div>
      {/* every CLI the chats run (Claude Code, Codex, Higgsfield): installed vs latest, upgrades */}
      <CliVersionsSection />
    </div>
  );
}

/** A percent threshold, saved on blur / Enter. */
function LimitInput({ value, onSave }: { value: number; onSave: (v: number) => Promise<unknown> }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const save = () => {
    const n = Number(v);
    if (Number.isFinite(n) && n !== value) onSave(Math.min(100, Math.max(50, n))).catch(() => setV(String(value)));
    else setV(String(value));
  };
  return (
    <span className="inline-flex items-center gap-0.5">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        inputMode="numeric"
        className="field w-12 py-0.5 px-1.5 text-center text-[11px]"
      />
      %
    </span>
  );
}

/** Claude: the default auto-compact window for chats without their own. */
function ContextCard({ value, onSave }: { value: number; onSave: (v: number) => Promise<unknown> }) {
  const t = useT();
  const presets = useConfigStore((s) => s.catalog.claude?.auto_compact_presets) || DEFAULT_PRESETS;
  const [error, setError] = useState("");
  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <div className="grid place-items-center w-9 h-9 rounded-lg bg-accent-soft shrink-0">
          <Icon name="activity" size={17} className="text-accent" />
        </div>
        <div className="flex-1">
          <div className="font-medium">{t("providers.contextTitle")}</div>
          <p className="text-xs text-content-faint mt-0.5">
            {t("providers.contextHint")}{" "}
            {t.rich("providers.contextFull", { b: (x) => <span className="text-content-dim">{x}</span> })}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p}
                onClick={() => onSave(p).then(() => setError("")).catch((e) => setError(String(e?.message || e)))}
                className={`pill ${value === p ? "bg-accent-soft text-accent" : "bg-surface-3 text-content-dim hover:text-content"}`}
              >
                {p === 0 ? t("providers.fullWindowDefault") : t("providers.presetCompactsAt", { window: fmtWindow(p), at: fmtWindow(p - COMPACT_BUFFER) })}
              </button>
            ))}
            {!presets.includes(value) && <span className="pill bg-accent-soft text-accent">{fmtWindow(value)}</span>}
          </div>
          {error && <p className="mt-1.5 text-[11px] text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function ProviderPanel({ provider, label }: { provider: string; label: string }) {
  const t = useT();
  const connect = useProviderStore((s) => s.connect);
  const reloadProviders = useProviderStore((s) => s.load);
  const [data, setData] = useState<PoolConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [oauthFor, setOauthFor] = useState<Account | null>(null);
  const [usageFor, setUsageFor] = useState<Account | null>(null);
  const [primaryLogin, setPrimaryLogin] = useState<Account | null>(null); // "Sign in again" for this machine's login

  // (the providers list too: it carries the Settings badge's login-session problems)
  const load = () =>
    getPool(provider)
      .then((d) => {
        setData(d);
        reloadProviders().catch(() => {});
      })
      .catch(() => {});
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const accounts = data?.accounts || [];
  const pool = data?.pool;

  const addAccount = async () => {
    const lbl = newLabel.trim() || t("providers.defaultAccountLabel", { n: String(accounts.filter((a) => !a.primary).length + 1) });
    const acc = await createAccount(provider, { label: lbl, auth_mode: "oauth" });
    setNewLabel("");
    setAdding(false);
    await load();
    setOauthFor(acc);
  };

  const saveKey = async () => {
    if (!apiKey) return;
    await connect(provider, "api_key", apiKey);
    setApiKey("");
    setShowKey(false);
    await load();
    reloadProviders();
  };

  return (
    <div className="space-y-4">
      {/* Load balancing — on top, defined separately */}
      <div className="card p-4">
        <div className="flex items-start gap-3">
          <div className="grid place-items-center w-9 h-9 rounded-lg bg-accent-soft shrink-0">
            <Icon name="server" size={17} className="text-accent" />
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <div className="font-medium">{t("providers.loadBalancing")}</div>
              <button
                onClick={() => pool && setPool(provider, { enabled: !pool.enabled }).then(load)}
                aria-label={t("providers.toggleLoadBalancing")}
                aria-pressed={!!pool?.enabled}
                className={`relative w-10 h-5 rounded-full transition ${pool?.enabled ? "bg-accent" : "bg-surface-3 light:bg-border-strong"}`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white light:shadow transition-all ${
                    pool?.enabled ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </button>
            </div>
            <p className="text-xs text-content-faint mt-0.5">
              {t.rich("providers.loadBalancingHint", { b: (x) => <span className="text-content-dim">{x}</span> })}
            </p>
            {pool?.enabled && (
              <div className="mt-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-content-faint w-16">{t("providers.strategy")}</span>
                  <select
                    value={pool.strategy}
                    onChange={(e) => setPool(provider, { strategy: e.target.value }).then(load)}
                    className="field py-1 text-xs w-44"
                  >
                    {STRATEGIES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {t(s.label)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] text-content-faint w-16">{t("providers.decideBy")}</span>
                  <select
                    value={pool.limit_priority || "balanced"}
                    onChange={(e) => setPool(provider, { limit_priority: e.target.value as LimitPriority }).then(load)}
                    className="field py-1 text-xs w-44"
                  >
                    <option value="balanced">{t("providers.prioBalanced")}</option>
                    <option value="seven_day">{t("providers.prioSevenDay")}</option>
                    <option value="five_hour">{t("providers.prioFiveHour")}</option>
                  </select>
                  <span className="text-[11px] text-content-faint basis-full sm:basis-auto">
                    {pool.limit_priority === "seven_day"
                      ? t("providers.prioSevenDayHint")
                      : pool.limit_priority === "five_hour"
                        ? t("providers.prioFiveHourHint")
                        : t("providers.prioBalancedHint")}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-wrap text-[11px] text-content-faint">
                  <span className="w-16">{t("providers.moveAt")}</span>
                  <LimitInput value={pool.near_5h} onSave={(v) => setPool(provider, { near_5h: v }).then(load)} /> {t("providers.fiveHour")}
                  <LimitInput value={pool.near_7d} onSave={(v) => setPool(provider, { near_7d: v }).then(load)} /> {t("providers.sevenDay")}
                  <span>{t("providers.moveAtTail")}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Accounts */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="font-medium">{t("providers.accounts")}</div>
          <button onClick={() => setAdding(true)} className="btn-soft py-1.5">
            <Icon name="plus" size={14} /> {t("providers.addAccount")}
          </button>
        </div>

        <div className="space-y-2">
          {accounts.map((a) => (
            <div key={a.id} className="rounded-lg border border-border bg-surface/50 p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`pill ${STATUS_STYLE[a.status] || STATUS_STYLE.unknown}`}>{STATUS_LABEL[a.status] ? t(STATUS_LABEL[a.status]) : a.status}</span>
                <span className="text-sm font-medium">{a.label}</span>
                {a.primary && <span className="pill bg-accent-soft text-accent">{t("providers.default")}</span>}
                {!a.usable && <span className="pill bg-danger/10 text-danger">{t("providers.noCredentials")}</span>}
                {a.usable && a.eligible && <span className="pill bg-success/10 text-success">{t("providers.eligible")}</span>}
                {a.usable && !a.eligible && (
                  <span className="pill bg-surface-3 text-content-faint" data-testid="ineligible-reason">
                    {INELIGIBLE_LABEL[a.ineligible_reason || ""] ? t(INELIGIBLE_LABEL[a.ineligible_reason || ""]) : a.ineligible_reason}
                  </span>
                )}
                {a.in_flight > 0 && (
                  <span className="ml-auto text-[11px] text-accent">{t("providers.activeCount", { n: a.in_flight })}</span>
                )}
              </div>

              {/* Plan usage: both windows with their reset times (one request per account per ~2 min; when the
                  latest one failed / was skipped: the last numbers, when they're from and when it asks again). */}
              {a.usable && a.auth_mode !== "api_key" && (
                <div className="mt-2.5">
                  <PlanWindowBars windows={fromAccount(a)} />
                  <PlanStaleNote account={a} />
                </div>
              )}

              {/* Login session: health, expiry, renew / sign in again (read from the CLI's credentials file) */}
              {a.session && (a.primary || a.usable) && (
                <AccountSession
                  provider={provider}
                  account={a}
                  onChanged={load}
                  onRelogin={() => (a.primary ? setPrimaryLogin(a) : setOauthFor(a))}
                />
              )}

              {a.primary && pool?.enabled && (
                <div className="mt-2.5 flex items-center gap-2 flex-wrap text-[11px] text-content-faint">
                  <span>{t("providers.inLoadBalancing")}</span>
                  <select
                    value={a.primary_mode || "normal"}
                    onChange={(e) => setPool(provider, { primary_mode: e.target.value as PrimaryMode }).then(load)}
                    className="field py-0.5 text-[11px] w-64"
                  >
                    <option value="normal">{t("providers.primaryNormal")}</option>
                    <option value="fallback">{t("providers.primaryFallback")}</option>
                    <option value="off">{t("providers.primaryOff")}</option>
                  </select>
                  <span className="basis-full">
                    {t("providers.primaryHint")}
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2 mt-2.5 flex-wrap text-[12px]">
                {a.usable && (
                  <button
                    onClick={() => setUsageFor(a)}
                    className="btn-ghost py-1"
                    title={t("providers.accountUsage")}
                  >
                    <Icon name="cpu" size={13} /> {t("providers.usage")}
                  </button>
                )}
                {!a.primary && (
                  <button
                    onClick={() => updateAccount(provider, a.id, { enabled: !a.enabled }).then(load)}
                    className={`pill ${a.enabled ? "bg-accent-soft text-accent" : "bg-surface-3 text-content-faint"}`}
                  >
                    {a.enabled ? t("providers.enabled") : t("providers.disabled")}
                  </button>
                )}
                {!a.usable && !a.primary && (
                  <button onClick={() => setOauthFor(a)} className="btn-soft py-1">
                    <Icon name="key" size={13} /> {t("common.signIn")}
                  </button>
                )}
                {a.status === "cooldown" && (
                  <button onClick={() => clearCooldown(provider, a.id).then(load)} className="btn-ghost py-1">
                    {t("providers.clearCooldown")}
                  </button>
                )}
                {!a.primary && (
                  <button
                    onClick={() => deleteAccount(provider, a.id).then(load)}
                    className="btn-ghost py-1 text-danger hover:text-danger ml-auto"
                    title={t("providers.removeAccount")}
                    aria-label={t("providers.removeAccount")}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                )}
              </div>
              {a.last_error && (
                <p className="mt-1.5 text-[11px] text-danger/80 light:text-danger font-mono truncate">{a.last_error}</p>
              )}
            </div>
          ))}
          {accounts.length === 0 && (
            <p className="text-sm text-content-faint py-2">
              {t("providers.noAccounts")}
            </p>
          )}
        </div>

        {adding && (
          <div className="flex gap-2 mt-3">
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && addAccount()}
              placeholder={t("providers.accountLabelPlaceholder")}
              className="field flex-1"
              autoFocus
            />
            <button onClick={addAccount} className="btn-primary">
              {t("providers.addAndSignIn")}
            </button>
            <button onClick={() => setAdding(false)} className="btn-ghost">
              {t("common.cancel")}
            </button>
          </div>
        )}
      </div>

      {provider === "claude" && pool && (
        <ContextCard value={pool.auto_compact_window} onSave={(v) => setPool(provider, { auto_compact_window: v }).then(load)} />
      )}

      {/* API key (secondary) */}
      <div className="card p-4">
        <button
          onClick={() => setShowKey((v) => !v)}
          className="flex items-center gap-1.5 text-[12px] text-content-dim hover:text-content"
        >
          <Icon name={showKey ? "chevron-down" : "chevron"} size={13} />
          {t("providers.useApiKey")}
        </button>
        {showKey && (
          <div className="flex gap-2 mt-2.5">
            <input
              type="password"
              placeholder={t("providers.apiKeyPlaceholder", { vendor: provider === "codex" ? "OpenAI" : "Anthropic" })}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="field flex-1 font-mono text-xs"
            />
            <button onClick={saveKey} className="btn-soft">
              {t("providers.saveKey")}
            </button>
          </div>
        )}
      </div>

      {oauthFor && (
        <ProviderOAuthModal
          provider={provider}
          title={t("providers.signInTitle", { label: oauthFor.label })}
          sub={provider === "codex" ? t("providers.subCodex") : t("providers.subClaude")}
          api={{
            start: () => accountOAuthStart(provider, oauthFor.id),
            status: () => accountOAuthStatus(provider, oauthFor.id),
            complete: (code: string) => accountOAuthComplete(provider, oauthFor.id, code),
          }}
          onClose={() => setOauthFor(null)}
          onConnected={load}
        />
      )}
      {primaryLogin && (
        <ProviderOAuthModal
          provider={provider}
          title={t("providers.signInTitle", { label: primaryLogin.label })}
          sub={provider === "codex" ? t("providers.subCodex") : t("providers.subClaude")}
          onClose={() => setPrimaryLogin(null)}
          onConnected={load}
        />
      )}
      {usageFor && (
        <UsageModal
          provider={provider}
          accountId={usageFor.primary ? undefined : usageFor.id}
          title={`${label} — ${usageFor.label}`}
          onClose={() => setUsageFor(null)}
        />
      )}
    </div>
  );
}
