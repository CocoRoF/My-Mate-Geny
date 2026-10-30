import { useEffect, useState } from "react";
import { getUsage, type UsageSummary } from "../../api/usage";
import { useProviderStore } from "../../stores/providerStore";
import Icon from "../ui/Icon";
import SubscriptionUsage from "./SubscriptionUsage";

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export default function UsageView() {
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <div className="flex items-center gap-2.5 mb-6">
          <Icon name="cpu" size={20} className="text-accent" />
          <h1 className="text-lg font-semibold">Account &amp; Usage</h1>
        </div>

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

        {tab && (
          <div className="card p-5">
            <SubscriptionUsage provider={tab} />
          </div>
        )}
        {connected.length === 0 && (
          <p className="text-sm text-content-faint">Connect a provider to see plan usage.</p>
        )}

        {/* secondary: local token activity */}
        <button
          onClick={() => setShowLocal((v) => !v)}
          className="mt-6 flex items-center gap-1.5 text-[11px] text-content-faint hover:text-content-dim"
        >
          <Icon name={showLocal ? "chevron-down" : "chevron"} size={12} />
          Local token activity (this machine)
        </button>
        {showLocal && local && (
          <div className="card p-4 mt-2">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="text-lg font-semibold tabular-nums">{local.total.turns}</div>
                <div className="text-[11px] text-content-faint">turns</div>
              </div>
              <div>
                <div className="text-lg font-semibold tabular-nums">{fmtNum(local.total.output)}</div>
                <div className="text-[11px] text-content-faint">output tokens</div>
              </div>
              <div>
                <div className="text-lg font-semibold tabular-nums">{fmtNum(local.total.input + local.total.cache_read)}</div>
                <div className="text-[11px] text-content-faint">input (incl. cache)</div>
              </div>
            </div>
            <p className="mt-3 text-[11px] text-content-faint text-center">
              Local token counts only — not your plan limits (shown above). $ cost applies to API-key use.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
