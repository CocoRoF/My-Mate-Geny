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
} from "../../api/accounts";
import { fromAccount } from "../../lib/usage";
import Icon from "../ui/Icon";
import ProviderOAuthModal from "./ProviderOAuthModal";
import PlanWindowBars from "../usage/PlanWindowBars";
import UsageModal from "../usage/UsageModal";

const STRATEGIES = [
  { id: "most_remaining", label: "Most remaining usage" },
  { id: "least_busy", label: "Least busy" },
  { id: "round_robin", label: "Round robin" },
  { id: "weighted", label: "Weighted" },
  { id: "least_recently_used", label: "Least recent" },
];

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
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 sm:px-6 py-5 sm:py-8">
        <div className="flex items-center gap-2.5 mb-1">
          <Icon name="plug" size={20} className="text-accent" />
          <h1 className="text-lg font-semibold">Providers</h1>
        </div>
        <p className="text-sm text-content-dim mb-5">
          Pick an engine, connect one or more accounts, and load-balance across them.
        </p>

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
        </div>

        {tab && <ProviderPanel key={tab} provider={tab} label={catalog[tab]?.label || tab} />}
      </div>
    </div>
  );
}

function ProviderPanel({ provider, label }: { provider: string; label: string }) {
  const connect = useProviderStore((s) => s.connect);
  const reloadProviders = useProviderStore((s) => s.load);
  const [data, setData] = useState<PoolConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [oauthFor, setOauthFor] = useState<Account | null>(null);
  const [usageFor, setUsageFor] = useState<Account | null>(null);

  const load = () => getPool(provider).then(setData).catch(() => {});
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const accounts = data?.accounts || [];
  const pool = data?.pool;

  const addAccount = async () => {
    const lbl = newLabel.trim() || `account ${accounts.filter((a) => !a.primary).length + 1}`;
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
              <div className="font-medium">Load balancing</div>
              <button
                onClick={() => pool && setPool(provider, { enabled: !pool.enabled }).then(load)}
                className={`relative w-10 h-5 rounded-full transition ${pool?.enabled ? "bg-accent" : "bg-surface-3"}`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                    pool?.enabled ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </button>
            </div>
            <p className="text-xs text-content-faint mt-0.5">
              When on, each turn is routed across your accounts by the chosen strategy — e.g.{" "}
              <span className="text-content-dim">Most remaining usage</span> sends it to the account
              with the most plan headroom. Rate-limited accounts cool down and fail over automatically.
            </p>
            {pool?.enabled && (
              <div className="flex items-center gap-2 mt-2.5">
                <span className="text-[11px] text-content-faint">Strategy</span>
                <select
                  value={pool.strategy}
                  onChange={(e) => setPool(provider, { strategy: e.target.value }).then(load)}
                  className="field py-1 text-xs w-40"
                >
                  {STRATEGIES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Accounts */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="font-medium">Accounts</div>
          <button onClick={() => setAdding(true)} className="btn-soft py-1.5">
            <Icon name="plus" size={14} /> Add account
          </button>
        </div>

        <div className="space-y-2">
          {accounts.map((a) => (
            <div key={a.id} className="rounded-lg border border-border bg-surface/50 p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`pill ${STATUS_STYLE[a.status] || STATUS_STYLE.unknown}`}>{a.status}</span>
                <span className="text-sm font-medium">{a.label}</span>
                {a.primary && <span className="pill bg-accent-soft text-accent">default</span>}
                {!a.usable && <span className="pill bg-danger/10 text-danger">no credentials</span>}
                {a.usable && a.eligible && <span className="pill bg-success/10 text-success">eligible</span>}
                {a.usable && !a.eligible && (
                  <span className="pill bg-surface-3 text-content-faint">{a.ineligible_reason}</span>
                )}
                {a.in_flight > 0 && (
                  <span className="ml-auto text-[11px] text-accent">{a.in_flight} active</span>
                )}
              </div>

              {/* Plan usage: both windows with their reset times (server-cached ~60s). */}
              {a.usable && a.auth_mode !== "api_key" && (
                <div className="mt-2.5">
                  <PlanWindowBars windows={fromAccount(a)} />
                  {a.plan_error && (
                    <p className="mt-1 truncate text-[11px] text-warning/90" title={a.plan_error}>
                      Couldn't refresh plan usage: {a.plan_error}
                    </p>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2 mt-2.5 flex-wrap text-[12px]">
                {a.usable && (
                  <button
                    onClick={() => setUsageFor(a)}
                    className="btn-ghost py-1"
                    title="Account usage"
                  >
                    <Icon name="cpu" size={13} /> Usage
                  </button>
                )}
                {!a.primary && (
                  <button
                    onClick={() => updateAccount(provider, a.id, { enabled: !a.enabled }).then(load)}
                    className={`pill ${a.enabled ? "bg-accent-soft text-accent" : "bg-surface-3 text-content-faint"}`}
                  >
                    {a.enabled ? "enabled" : "disabled"}
                  </button>
                )}
                {!a.usable && !a.primary && (
                  <button onClick={() => setOauthFor(a)} className="btn-soft py-1">
                    <Icon name="key" size={13} /> Sign in
                  </button>
                )}
                {a.status === "cooldown" && (
                  <button onClick={() => clearCooldown(provider, a.id).then(load)} className="btn-ghost py-1">
                    Clear cooldown
                  </button>
                )}
                {!a.primary && (
                  <button
                    onClick={() => deleteAccount(provider, a.id).then(load)}
                    className="btn-ghost py-1 text-danger hover:text-danger ml-auto"
                    title="Remove account"
                  >
                    <Icon name="trash" size={13} />
                  </button>
                )}
              </div>
              {a.last_error && (
                <p className="mt-1.5 text-[11px] text-danger/80 font-mono truncate">{a.last_error}</p>
              )}
            </div>
          ))}
          {accounts.length === 0 && (
            <p className="text-sm text-content-faint py-2">
              No accounts connected. Add one to start, or sign in from the chat.
            </p>
          )}
        </div>

        {adding && (
          <div className="flex gap-2 mt-3">
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && addAccount()}
              placeholder="Account label (e.g. work, personal)"
              className="field flex-1"
              autoFocus
            />
            <button onClick={addAccount} className="btn-primary">
              Add &amp; sign in
            </button>
            <button onClick={() => setAdding(false)} className="btn-ghost">
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* API key (secondary) */}
      <div className="card p-4">
        <button
          onClick={() => setShowKey((v) => !v)}
          className="flex items-center gap-1.5 text-[12px] text-content-dim hover:text-content"
        >
          <Icon name={showKey ? "chevron-down" : "chevron"} size={13} />
          Use an API key instead (for the default account)
        </button>
        {showKey && (
          <div className="flex gap-2 mt-2.5">
            <input
              type="password"
              placeholder={`${provider === "codex" ? "OpenAI" : "Anthropic"} API key`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="field flex-1 font-mono text-xs"
            />
            <button onClick={saveKey} className="btn-soft">
              Save key
            </button>
          </div>
        )}
      </div>

      {oauthFor && (
        <ProviderOAuthModal
          provider={provider}
          title={`Sign in — ${oauthFor.label}`}
          sub={provider === "codex" ? "ChatGPT account (device code)" : "Claude subscription (token)"}
          api={{
            start: () => accountOAuthStart(provider, oauthFor.id),
            status: () => accountOAuthStatus(provider, oauthFor.id),
            complete: (code: string) => accountOAuthComplete(provider, oauthFor.id, code),
          }}
          onClose={() => setOauthFor(null)}
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
