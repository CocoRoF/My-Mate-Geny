import { useEffect, useState } from "react";
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
import Icon from "../ui/Icon";
import ProviderOAuthModal from "./ProviderOAuthModal";

const STRATEGIES = [
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

export default function AccountsPanel({ provider }: { provider: string }) {
  const [data, setData] = useState<PoolConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [oauthFor, setOauthFor] = useState<Account | null>(null);

  const load = () => getPool(provider).then(setData).catch(() => {});
  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const accounts = data?.accounts || [];

  const addAccount = async () => {
    const label = newLabel.trim() || `account ${accounts.length + 1}`;
    const acc = await createAccount(provider, { label, auth_mode: "oauth" });
    setNewLabel("");
    setAdding(false);
    await load();
    setOauthFor(acc); // immediately start sign-in
  };

  return (
    <div className="mt-3 border-t border-border pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] text-content-faint hover:text-content-dim"
      >
        <Icon name={open ? "chevron-down" : "chevron"} size={12} />
        Multiple accounts &amp; load balancing
        {data?.pool.enabled && <span className="pill bg-accent-soft text-accent">pool on · {accounts.length}</span>}
      </button>

      {open && data && (
        <div className="mt-3 space-y-3">
          {/* Pool controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-[13px]">
              <button
                onClick={() => setPool(provider, { enabled: !data.pool.enabled }).then(load)}
                className={`relative w-9 h-5 rounded-full transition ${data.pool.enabled ? "bg-accent" : "bg-surface-3"}`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                    data.pool.enabled ? "left-[18px]" : "left-0.5"
                  }`}
                />
              </button>
              Use pool (load balance)
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-content-faint">Strategy</span>
              <select
                value={data.pool.strategy}
                onChange={(e) => setPool(provider, { strategy: e.target.value }).then(load)}
                className="field py-1 text-xs w-36"
              >
                {STRATEGIES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Accounts list */}
          <div className="space-y-2">
            {accounts.map((a) => (
              <div key={a.id} className="rounded-lg border border-border bg-surface/50 p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`pill ${STATUS_STYLE[a.status] || STATUS_STYLE.unknown}`}>{a.status}</span>
                  <span className="text-sm font-medium">{a.label}</span>
                  {!a.usable && <span className="pill bg-danger/10 text-danger">no credentials</span>}
                  {a.eligible && a.usable && <span className="pill bg-success/10 text-success">eligible</span>}
                  {!a.eligible && a.usable && (
                    <span className="pill bg-surface-3 text-content-faint">{a.ineligible_reason}</span>
                  )}
                  <span className="ml-auto text-[11px] text-content-faint">
                    {a.in_flight}/{a.max_concurrency} busy · {a.total_leases} leases · {a.total_failures} fails
                  </span>
                </div>

                <div className="flex items-center gap-2 mt-2.5 flex-wrap text-[12px]">
                  <button
                    onClick={() => updateAccount(provider, a.id, { enabled: !a.enabled }).then(load)}
                    className={`pill ${a.enabled ? "bg-accent-soft text-accent" : "bg-surface-3 text-content-faint"}`}
                  >
                    {a.enabled ? "enabled" : "disabled"}
                  </button>
                  <label className="flex items-center gap-1 text-content-faint">
                    w
                    <input
                      type="number"
                      min={1}
                      defaultValue={a.weight}
                      onBlur={(e) => updateAccount(provider, a.id, { weight: Number(e.target.value) }).then(load)}
                      className="field w-12 py-0.5 text-center"
                    />
                  </label>
                  <label className="flex items-center gap-1 text-content-faint">
                    max
                    <input
                      type="number"
                      min={1}
                      defaultValue={a.max_concurrency}
                      onBlur={(e) =>
                        updateAccount(provider, a.id, { max_concurrency: Number(e.target.value) }).then(load)
                      }
                      className="field w-14 py-0.5 text-center"
                    />
                  </label>
                  {!a.usable && (
                    <button onClick={() => setOauthFor(a)} className="btn-soft py-1">
                      <Icon name="key" size={13} /> Sign in
                    </button>
                  )}
                  {a.status === "cooldown" && (
                    <button onClick={() => clearCooldown(provider, a.id).then(load)} className="btn-ghost py-1">
                      Clear cooldown
                    </button>
                  )}
                  <button
                    onClick={() => deleteAccount(provider, a.id).then(load)}
                    className="btn-ghost py-1 text-danger hover:text-danger ml-auto"
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
                {a.last_error && (
                  <p className="mt-1.5 text-[11px] text-danger/80 font-mono truncate">{a.last_error}</p>
                )}
              </div>
            ))}
            {accounts.length === 0 && (
              <p className="text-xs text-content-faint">
                No pooled accounts. Add multiple accounts to load-balance turns across them.
              </p>
            )}
          </div>

          {/* Add */}
          {adding ? (
            <div className="flex gap-2">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addAccount()}
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
          ) : (
            <button onClick={() => setAdding(true)} className="btn-soft">
              <Icon name="plus" size={14} /> Add account
            </button>
          )}
        </div>
      )}

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
    </div>
  );
}
