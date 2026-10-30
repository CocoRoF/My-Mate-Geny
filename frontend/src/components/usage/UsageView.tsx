import { useEffect, useState } from "react";
import { getUsage, type UsageSummary } from "../../api/usage";
import Icon from "../ui/Icon";

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] uppercase tracking-wider text-content-faint">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-content-faint mt-0.5">{sub}</div>}
    </div>
  );
}

export default function UsageView() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getUsage(14)
      .then(setData)
      .catch((e) => setError(String(e.message || e)));
  }, []);

  if (error) return <div className="p-6 text-sm text-danger">{error}</div>;
  if (!data) return <div className="p-6 text-sm text-content-faint">Loading…</div>;

  const maxCost = Math.max(...data.series.map((s) => s.cost_usd), 0.0001);
  const t = data.total;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="flex items-center gap-2.5 mb-6">
          <Icon name="cpu" size={20} className="text-accent" />
          <h1 className="text-lg font-semibold">Usage</h1>
          <span className="text-xs text-content-faint">last 14 days</span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Stat label="Total cost" value={`$${t.cost_usd.toFixed(4)}`} sub={`${t.turns} turns`} />
          <Stat label="Output tokens" value={fmtNum(t.output)} />
          <Stat label="Input tokens" value={fmtNum(t.input)} sub={`+${fmtNum(t.cache_read)} cached`} />
          <Stat label="Cache writes" value={fmtNum(t.cache_write)} />
        </div>

        {/* Daily cost chart */}
        <div className="card p-4 mb-6">
          <div className="text-[11px] uppercase tracking-wider text-content-faint mb-3">Daily cost</div>
          <div className="flex items-end gap-1.5 h-32">
            {data.series.map((s) => (
              <div key={s.day} className="group flex-1 flex flex-col items-center justify-end gap-1">
                <div
                  className="w-full rounded-t bg-gradient-to-t from-accent to-cyan min-h-[2px] transition-all group-hover:opacity-80"
                  style={{ height: `${(s.cost_usd / maxCost) * 100}%` }}
                  title={`${s.day}: $${s.cost_usd.toFixed(4)} · ${s.turns} turns`}
                />
                <span className="text-[9px] text-content-faint">{s.day.slice(5)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-3 mb-6">
          {/* By provider */}
          <div className="card p-4">
            <div className="text-[11px] uppercase tracking-wider text-content-faint mb-3">By provider</div>
            <div className="space-y-2">
              {Object.entries(data.by_provider).map(([p, v]) => (
                <div key={p} className="flex items-center justify-between text-sm">
                  <span className="capitalize flex items-center gap-2">
                    <Icon name="cpu" size={14} className="text-accent" /> {p}
                  </span>
                  <span className="text-content-dim tabular-nums">
                    ${v.cost_usd.toFixed(4)} <span className="text-content-faint">· {v.turns} turns</span>
                  </span>
                </div>
              ))}
              {Object.keys(data.by_provider).length === 0 && (
                <p className="text-xs text-content-faint">No usage yet.</p>
              )}
            </div>
          </div>

          {/* By model */}
          <div className="card p-4">
            <div className="text-[11px] uppercase tracking-wider text-content-faint mb-3">By model</div>
            <div className="space-y-2">
              {Object.entries(data.by_model).map(([m, v]) => (
                <div key={m} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-[12px]">{m}</span>
                  <span className="text-content-dim tabular-nums">
                    ${v.cost_usd.toFixed(4)} <span className="text-content-faint">· {fmtNum(v.tokens)} tok</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Recent turns */}
        <div className="card p-4">
          <div className="text-[11px] uppercase tracking-wider text-content-faint mb-3">Recent turns</div>
          <div className="space-y-1">
            {data.recent.map((r, i) => (
              <div key={i} className="flex items-center gap-3 py-1.5 text-sm border-b border-border/50 last:border-0">
                <span className="truncate flex-1">{r.title}</span>
                <span className="pill bg-surface-3 text-content-faint">{r.provider}</span>
                <span className="font-mono text-[11px] text-content-faint hidden sm:inline">{r.model}</span>
                <span className="tabular-nums text-content-dim w-20 text-right">${r.cost_usd.toFixed(4)}</span>
                <span className="tabular-nums text-content-faint w-16 text-right text-[11px]">{fmtNum(r.tokens)}</span>
              </div>
            ))}
            {data.recent.length === 0 && <p className="text-xs text-content-faint">No turns yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
