import { useEffect, useState } from "react";
import { getUsage, type UsageSummary } from "../../api/usage";
import { getPool, type Account } from "../../api/accounts";
import { useProviderStore } from "../../stores/providerStore";
import { apiCostHint, fmtUsd } from "../../lib/usage";
import { useT, type MsgKey } from "../../i18n";
import Icon from "../ui/Icon";
import SubscriptionUsage from "./SubscriptionUsage";
import HiggsfieldUsage from "./HiggsfieldUsage";

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

const STATUS: Record<string, MsgKey> = {
  cooldown: "usage.status_cooldown",
  expired: "usage.status_expired",
  unknown: "usage.status_unknown",
};

export default function UsageView() {
  const t = useT();
  const providers = useProviderStore((s) => s.providers);
  const connected = providers.filter((p) => p.connected);
  const [tab, setTab] = useState<string>("");
  const [local, setLocal] = useState<UsageSummary | null>(null);
  const [showLocal, setShowLocal] = useState(false);

  useEffect(() => {
    if (!tab && connected.length) setTab(connected[0].provider);
  }, [connected, tab]);

  useEffect(() => {
    if (showLocal && !local) getUsage(14).then(setLocal).catch(() => {});
  }, [showLocal, local]);

  // Every connected account of the provider (the host login + added ones).
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  useEffect(() => {
    if (!tab) return;
    let alive = true;
    setAccounts(null);
    getPool(tab)
      .then((p) => alive && setAccounts(p.accounts.filter((a) => a.primary || a.usable)))
      .catch(() => alive && setAccounts([]));
    return () => {
      alive = false;
    };
  }, [tab]);

  return (
    // (Settings → Usage: the tab's title is Settings')
    <div className="max-w-2xl">
      <div>

        {/* provider tabs */}
        {connected.length > 1 && (
          <div className="flex gap-1.5 mb-5">
            {connected.map((p) => (
              <button
                key={p.provider}
                onClick={() => setTab(p.provider)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium capitalize transition ${
                  tab === p.provider ? "bg-surface-3 text-content" : "text-content-dim hover:text-content"
                }`}
              >
                {p.provider}
              </button>
            ))}
          </div>
        )}

        {tab && accounts === null && (
          <div className="card p-5 flex items-center justify-center gap-2 text-sm text-content-faint">
            <Icon name="spinner" size={15} spin /> {t("usage.loadingAccounts")}
          </div>
        )}
        {/* no account list (older server / error): the host login alone */}
        {tab && accounts !== null && accounts.length === 0 && (
          <div className="card p-5">
            <SubscriptionUsage provider={tab} />
          </div>
        )}
        {tab && accounts && accounts.length > 0 && (
          <div className="space-y-4">
            {accounts.map((a) => (
              <div key={a.id} className="card p-5">
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-sm font-semibold text-content">{a.label}</span>
                  {a.primary && <span className="pill bg-accent/15 text-accent">{t("usage.thisMachine")}</span>}
                  {!a.enabled && <span className="pill bg-surface-3 text-content-faint">{t("usage.disabled")}</span>}
                  {a.status && a.status !== "ready" && (
                    <span className="pill bg-warning/15 text-warning">{STATUS[a.status] ? t(STATUS[a.status]) : a.status.replace(/_/g, " ")}</span>
                  )}
                </div>
                {a.auth_mode === "api_key" ? (
                  <p className="text-sm text-content-faint">{t("usage.apiKeyBilled")}</p>
                ) : (
                  <SubscriptionUsage provider={tab} accountId={a.primary ? undefined : a.id} />
                )}
              </div>
            ))}
          </div>
        )}
        {connected.length === 0 && (
          <p className="text-sm text-content-faint">{t("usage.connectProvider")}</p>
        )}

        <HiggsfieldUsage />

        {/* secondary: local token activity */}
        <button
          onClick={() => setShowLocal((v) => !v)}
          className="mt-6 flex items-center gap-1.5 text-[11px] text-content-faint hover:text-content-dim"
        >
          <Icon name={showLocal ? "chevron-down" : "chevron"} size={12} />
          {t("usage.localActivity")}
        </button>
        {showLocal && local && (
          <div className="card p-4 mt-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
              <div>
                <div className="text-lg font-semibold tabular-nums">{local.total.turns}</div>
                <div className="text-[11px] text-content-faint">{t("usage.turns")}</div>
              </div>
              <div>
                <div className="text-lg font-semibold tabular-nums">{fmtNum(local.total.output)}</div>
                <div className="text-[11px] text-content-faint">{t("usage.outputTokens")}</div>
              </div>
              <div>
                <div className="text-lg font-semibold tabular-nums">{fmtNum(local.total.input + local.total.cache_read)}</div>
                <div className="text-[11px] text-content-faint">{t("usage.inputInclCache")}</div>
              </div>
              <div title={apiCostHint()}>
                <div className="text-lg font-semibold tabular-nums">≈ {fmtUsd(local.total.cost_usd)}</div>
                <div className="text-[11px] text-content-faint">{t("usage.apiEquivalent")}</div>
              </div>
            </div>
            <p className="mt-3 text-[11px] text-content-faint text-center">
              {t("usage.localNote")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
