/**
 * Settings → Providers → Anthropic / OpenAI / Google: a provider used with API keys, driven by the app's own agent
 * engine (backend app/harness, docs/api-engines.md).
 *
 * - Keys: as many as you like, each tested when added (the vendor accepts it, and it can generate) and on demand. A
 *   chat runs on one key (load balancing picks it) and moves to another within the turn when that key is rate limited,
 *   out of credit or refused.
 * - Models: the vendor's own list, fetched with a key; switch on the ones chats may use (New chat and the composer
 *   offer only those). Each model's price (for the cost shown per turn) and context window can be corrected.
 */
import { useEffect, useMemo, useState } from "react";
import { getPool, setPool, updateAccount, deleteAccount, clearCooldown, type Account, type PoolConfig } from "../../api/accounts";
import {
  KEY_HINTS,
  addKey,
  addModel,
  bulkModels,
  deleteModel,
  fmtPrice,
  listModels,
  refreshModels,
  testKey,
  updateModel,
  type ApiModel,
  type CatalogState,
  type KeyCheck,
  type ModelPrice,
} from "../../api/apiProviders";
import { useConfigStore } from "../../stores/configStore";
import { useProviderStore } from "../../stores/providerStore";
import { fmtWindow } from "../../lib/context";
import { relTime } from "../../i18n/format";
import { useT, type MsgKey } from "../../i18n";
import Icon from "../ui/Icon";

const STRATEGIES: { id: string; label: MsgKey }[] = [
  { id: "least_busy", label: "providers.stratLeastBusy" },
  { id: "round_robin", label: "providers.stratRoundRobin" },
  { id: "weighted", label: "providers.stratWeighted" },
  { id: "least_recently_used", label: "providers.stratLeastRecent" },
];

const STATUS_STYLE: Record<string, string> = {
  ready: "bg-success/15 text-success",
  cooldown: "bg-warning/15 text-warning",
  expired: "bg-danger/15 text-danger",
  unknown: "bg-surface-3 text-content-faint",
};

const STATUS_LABEL: Record<string, MsgKey> = {
  ready: "providers.statusReady",
  cooldown: "providers.statusCooldown",
  expired: "providers.statusExpired",
  unknown: "providers.statusUnknown",
};

/** The New chat menu, the composer and the provider dots follow a change at once. */
function refreshEverywhere() {
  useConfigStore.getState().load().catch(() => {});
  useProviderStore.getState().load().catch(() => {});
}

function errorText(e: unknown): string {
  return String((e as Error)?.message || e);
}

export default function ApiProviderPanel({ provider, label }: { provider: string; label: string }) {
  const [pool, setPoolData] = useState<PoolConfig | null>(null);
  const [models, setModels] = useState<ApiModel[]>([]);
  const [state, setState] = useState<CatalogState | null>(null);

  const loadPool = () => getPool(provider).then(setPoolData).catch(() => {});
  const loadModels = () =>
    listModels(provider)
      .then((r) => {
        setModels(r.models);
        setState(r.state);
      })
      .catch(() => {});
  useEffect(() => {
    loadPool();
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const changed = () => {
    loadPool();
    loadModels();
    refreshEverywhere();
  };

  return (
    <div className="space-y-4" data-testid={`api-provider-${provider}`}>
      <KeysCard provider={provider} label={label} pool={pool} onChanged={changed} />
      {pool && (pool.accounts.length > 1 || pool.pool.strategy !== "least_busy") && (
        <BalancingCard provider={provider} pool={pool} onChanged={loadPool} />
      )}
      <ModelsCard provider={provider} models={models} state={state} hasKey={!!pool?.accounts.length} onModels={setModels}
                  onState={setState} />
      {pool && (
        <ApiContextCard value={pool.pool.auto_compact_window} onSave={(v) => setPool(provider, { auto_compact_window: v }).then(loadPool)} />
      )}
    </div>
  );
}

// ---- keys ----

function CheckLine({ check }: { check: KeyCheck }) {
  const t = useT();
  if (check.ok) {
    return (
      <p className="mt-1.5 text-[11.5px] text-success" data-testid="key-check-ok">
        <Icon name="check" size={12} className="inline -mt-0.5" />{" "}
        {t("providers.apiCheckOk", { models: check.models ?? 0, ms: check.latency_ms ?? 0 })}
        {check.generation?.ok && ` · ${t("providers.apiCheckGenerated", { model: check.generation.model })}`}
      </p>
    );
  }
  const why: Record<string, MsgKey> = {
    auth: "providers.apiCheckAuth",
    quota: "providers.apiCheckQuota",
    rate_limit: "providers.apiCheckRate",
    network: "providers.apiCheckNetwork",
  };
  return (
    <p className="mt-1.5 text-[11.5px] text-danger" data-testid="key-check-error">
      {why[check.kind || ""] ? t(why[check.kind || ""]) : t("providers.apiCheckFailed")}
      {check.error && <span className="block font-mono text-[11px] text-danger/80 break-all">{check.error}</span>}
    </p>
  );
}

function KeysCard({ provider, label, pool, onChanged }: { provider: string; label: string; pool: PoolConfig | null; onChanged: () => void }) {
  const t = useT();
  const hint = KEY_HINTS[provider];
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState("");
  const [checks, setChecks] = useState<Record<string, KeyCheck>>({});
  const [addResult, setAddResult] = useState<KeyCheck | null>(null);
  const [error, setError] = useState("");
  const accounts = pool?.accounts || [];
  const weighted = pool?.pool.strategy === "weighted";

  const add = async () => {
    if (!secret.trim()) return;
    setBusy("add");
    setError("");
    try {
      const r = await addKey(provider, { label: name.trim(), api_key: secret.trim() });
      setAddResult(r.check);
      if (r.account) setChecks((c) => ({ ...c, [r.account!.id]: r.check }));
      setSecret("");
      setName("");
      setShow(false);
      if (r.check.ok) setAdding(false);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const test = async (a: Account) => {
    setBusy(a.id);
    try {
      const r = await testKey(provider, a.id);
      setChecks((c) => ({ ...c, [a.id]: r }));
      onChanged();
    } catch (e) {
      setChecks((c) => ({ ...c, [a.id]: { ok: false, error: errorText(e) } }));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <div className="grid place-items-center w-9 h-9 rounded-lg bg-accent-soft shrink-0">
          <Icon name="key" size={17} className="text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="font-medium">{t("providers.apiKeys")}</div>
            {!adding && (
              <button onClick={() => { setAdding(true); setAddResult(null); }} className="btn-soft py-1.5" data-testid="api-key-add">
                <Icon name="plus" size={14} /> {t("providers.apiAddKey")}
              </button>
            )}
          </div>
          <p className="text-xs text-content-faint mt-0.5">
            {t("providers.apiKeysHint", { vendor: label })}{" "}
            <a href={hint?.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              {t("providers.apiGetKey", { vendor: label })} <Icon name="external" size={11} className="inline -mt-0.5" />
            </a>
          </p>
        </div>
      </div>

      {adding && (
        <div className="mt-3 rounded-lg border border-border bg-surface/50 p-3 space-y-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("providers.apiKeyLabel")} className="field w-full text-sm" maxLength={80} />
          <div className="flex gap-2">
            <input
              type={show ? "text" : "password"}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()}
              placeholder={hint?.placeholder}
              className="field flex-1 font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
              data-testid="api-key-input"
            />
            <button type="button" onClick={() => setShow((v) => !v)} className="btn-ghost py-1 px-2" aria-label={t("providers.apiShowKey")}>
              <Icon name={show ? "eye-off" : "eye"} size={14} />
            </button>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setAdding(false); setSecret(""); }} className="btn-ghost">{t("common.cancel")}</button>
            <button onClick={add} disabled={!secret.trim() || busy === "add"} className="btn-primary" data-testid="api-key-save">
              {busy === "add" ? <Icon name="spinner" size={14} spin /> : <Icon name="check" size={14} />} {t("providers.apiAddAndTest")}
            </button>
          </div>
          {addResult && !addResult.ok && <CheckLine check={addResult} />}
          {error && <p className="text-[11.5px] text-danger">{error}</p>}
        </div>
      )}

      <div className="space-y-2 mt-3">
        {accounts.map((a) => (
          <div key={a.id} className="rounded-lg border border-border bg-surface/50 p-3" data-testid="api-key-row">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`pill ${STATUS_STYLE[a.status] || STATUS_STYLE.unknown}`}>
                {STATUS_LABEL[a.status] ? t(STATUS_LABEL[a.status]) : a.status}
              </span>
              <span className="text-sm font-medium">{a.label}</span>
              {!a.enabled && <span className="pill bg-surface-3 text-content-faint">{t("providers.disabled")}</span>}
              {a.in_flight > 0 && <span className="ml-auto text-[11px] text-accent">{t("providers.activeCount", { n: a.in_flight })}</span>}
            </div>
            <div className="mt-1 text-[11px] text-content-faint flex flex-wrap gap-x-3">
              <span>{a.last_ok_at ? t("providers.apiLastWorked", { ago: relTime(a.last_ok_at) }) : t("providers.apiNotUsedYet")}</span>
              {a.total_leases > 0 && <span>{t("providers.apiTurns", { n: a.total_leases })}</span>}
              {a.status === "cooldown" && a.cooldown_until && <span className="text-warning">{t("providers.apiCoolingUntil", { ago: relTime(a.cooldown_until) })}</span>}
            </div>
            {checks[a.id] && <CheckLine check={checks[a.id]} />}
            {!checks[a.id] && a.last_error && a.status !== "ready" && (
              <p className="mt-1.5 text-[11px] text-danger/80 light:text-danger font-mono truncate">{a.last_error}</p>
            )}
            <div className="flex items-center gap-2 mt-2.5 flex-wrap text-[12px]">
              <button onClick={() => test(a)} disabled={busy === a.id} className="btn-soft py-1" data-testid="api-key-test">
                {busy === a.id ? <Icon name="spinner" size={13} spin /> : <Icon name="activity" size={13} />} {t("providers.apiTest")}
              </button>
              <button
                onClick={() => updateAccount(provider, a.id, { enabled: !a.enabled }).then(onChanged)}
                className={`pill ${a.enabled ? "bg-accent-soft text-accent" : "bg-surface-3 text-content-faint"}`}
              >
                {a.enabled ? t("providers.enabled") : t("providers.disabled")}
              </button>
              {a.status === "cooldown" && (
                <button onClick={() => clearCooldown(provider, a.id).then(onChanged)} className="btn-ghost py-1">
                  {t("providers.clearCooldown")}
                </button>
              )}
              {weighted && (
                <label className="inline-flex items-center gap-1 text-[11px] text-content-faint">
                  {t("providers.apiWeight")}
                  <NumberInput value={a.weight} min={1} max={100} onSave={(v) => updateAccount(provider, a.id, { weight: v }).then(onChanged)} />
                </label>
              )}
              <label className="inline-flex items-center gap-1 text-[11px] text-content-faint" title={t("providers.apiConcurrencyHint")}>
                {t("providers.apiConcurrency")}
                <NumberInput value={a.max_concurrency} min={1} max={64} onSave={(v) => updateAccount(provider, a.id, { max_concurrency: v }).then(onChanged)} />
              </label>
              <button
                onClick={() => window.confirm(t("providers.apiRemoveConfirm", { label: a.label })) && deleteAccount(provider, a.id).then(onChanged)}
                className="btn-ghost py-1 text-danger hover:text-danger ml-auto"
                title={t("providers.apiRemoveKey")}
                aria-label={t("providers.apiRemoveKey")}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        ))}
        {!accounts.length && !adding && <p className="text-sm text-content-faint py-1">{t("providers.apiNoKeys", { vendor: label })}</p>}
      </div>
    </div>
  );
}

function NumberInput({ value, min, max, onSave }: { value: number; min: number; max: number; onSave: (v: number) => Promise<unknown> }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const save = () => {
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n !== value) onSave(Math.min(max, Math.max(min, n))).catch(() => setV(String(value)));
    else setV(String(value));
  };
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      inputMode="numeric"
      className="field w-11 py-0.5 px-1 text-center text-[11px]"
    />
  );
}

// ---- balancing ----

function BalancingCard({ provider, pool, onChanged }: { provider: string; pool: PoolConfig; onChanged: () => void }) {
  const t = useT();
  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <div className="grid place-items-center w-9 h-9 rounded-lg bg-accent-soft shrink-0">
          <Icon name="server" size={17} className="text-accent" />
        </div>
        <div className="flex-1">
          <div className="font-medium">{t("providers.loadBalancing")}</div>
          <p className="text-xs text-content-faint mt-0.5">{t("providers.apiBalancingHint")}</p>
          <div className="mt-2.5 flex items-center gap-2">
            <span className="text-[11px] text-content-faint w-16">{t("providers.strategy")}</span>
            <select
              value={pool.pool.strategy}
              onChange={(e) => setPool(provider, { strategy: e.target.value }).then(onChanged)}
              className="field py-1 text-xs w-44"
              data-testid="api-strategy"
            >
              {STRATEGIES.map((s) => (
                <option key={s.id} value={s.id}>{t(s.label)}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- models ----

function ModelsCard({ provider, models, state, hasKey, onModels, onState }: {
  provider: string;
  models: ApiModel[];
  state: CatalogState | null;
  hasKey: boolean;
  onModels: (m: ApiModel[]) => void;
  onState: (s: CatalogState) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [onlyOn, setOnlyOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter((m) => (!onlyOn || m.enabled) && (!q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)));
  }, [models, query, onlyOn]);
  const on = models.filter((m) => m.enabled).length;

  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await refreshModels(provider);
      onModels(r.models);
      onState(r.state);
      refreshEverywhere();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const patch = async (m: ApiModel, p: Parameters<typeof updateModel>[2]) => {
    try {
      const updated = await updateModel(provider, m.id, p);
      onModels(models.map((x) => (x.id === m.id ? updated : x)));
      refreshEverywhere();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const bulk = async (enabled: boolean) => {
    const r = await bulkModels(provider, enabled, shown.map((m) => m.id));
    onModels(r.models);
    refreshEverywhere();
  };

  const add = async () => {
    if (!newId.trim()) return;
    try {
      const m = await addModel(provider, newId.trim());
      onModels([...models.filter((x) => x.id !== m.id), m]);
      setNewId("");
      refreshEverywhere();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="card p-4" data-testid="api-models">
      <div className="flex items-start gap-3">
        <div className="grid place-items-center w-9 h-9 rounded-lg bg-accent-soft shrink-0">
          <Icon name="cpu" size={17} className="text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="font-medium">
              {t("providers.apiModels")}
              {models.length > 0 && <span className="ml-2 text-[12px] font-normal text-content-faint">{t("providers.apiModelsOn", { on, total: models.length })}</span>}
            </div>
            <button onClick={refresh} disabled={busy || !hasKey} className="btn-soft py-1.5" data-testid="api-models-refresh" title={hasKey ? "" : t("providers.apiModelsNeedKey")}>
              {busy ? <Icon name="spinner" size={14} spin /> : <Icon name="refresh" size={14} />} {t("providers.apiModelsRefresh")}
            </button>
          </div>
          <p className="text-xs text-content-faint mt-0.5">
            {t("providers.apiModelsHint")}
            {state?.fetched_at && ` ${t("providers.apiModelsFetched", { ago: relTime(state.fetched_at) })}`}
          </p>
          {(error || state?.error) && <p className="mt-1 text-[11.5px] text-danger break-all">{error || state?.error}</p>}
        </div>
      </div>

      {models.length > 0 ? (
        <>
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[10rem]">
              <Icon name="search" size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-content-faint" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("providers.apiModelsSearch")} className="field w-full pl-7 py-1 text-xs" />
            </div>
            <button onClick={() => setOnlyOn((v) => !v)} className={`pill ${onlyOn ? "bg-accent-soft text-accent" : "bg-surface-3 text-content-dim"}`}>
              {t("providers.apiModelsOnlyOn")}
            </button>
            <button onClick={() => bulk(true)} className="btn-ghost py-0.5 text-[11.5px]">{t("providers.apiModelsAllOn")}</button>
            <button onClick={() => bulk(false)} className="btn-ghost py-0.5 text-[11.5px]">{t("providers.apiModelsAllOff")}</button>
          </div>
          <ul className="mt-2 divide-y divide-border/60 rounded-lg border border-border">
            {shown.map((m) => (
              <li key={m.id} className="px-3 py-2" data-testid="api-model-row">
                <div className="flex items-center gap-2.5">
                  <button
                    onClick={() => patch(m, { enabled: !m.enabled })}
                    aria-pressed={m.enabled}
                    aria-label={t("providers.apiModelToggle", { model: m.label })}
                    className={`relative w-8 h-4 rounded-full transition shrink-0 ${m.enabled ? "bg-accent" : "bg-surface-3 light:bg-border-strong"}`}
                    data-testid="api-model-toggle"
                  >
                    <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white light:shadow transition-all ${m.enabled ? "left-[18px]" : "left-0.5"}`} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[13px] font-medium truncate">{m.label}</span>
                      {m.label !== m.id && <span className="font-mono text-[10.5px] text-content-faint truncate">{m.id}</span>}
                      {!m.listed && !m.manual && <span className="pill bg-warning/10 text-warning text-[10px]">{t("providers.apiModelUnlisted")}</span>}
                      {m.manual && <span className="pill bg-surface-3 text-content-faint text-[10px]">{t("providers.apiModelManual")}</span>}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 flex-wrap text-[10.5px] text-content-faint">
                      {m.context_window ? <span>{t("providers.apiModelContext", { n: fmtWindow(m.context_window) })}</span> : null}
                      {m.thinking && <span>{t("providers.apiModelThinking")}</span>}
                      {m.vision && <span>{t("providers.apiModelVision")}</span>}
                      <span className={m.price ? "" : "text-warning"}>
                        {m.price ? t("providers.apiModelPrice", { price: fmtPrice(m.price) }) : t("providers.apiModelNoPrice")}
                        {m.price_source === "custom" && ` · ${t("providers.apiModelCustom")}`}
                      </span>
                    </div>
                  </div>
                  <button onClick={() => setEditing(editing === m.id ? null : m.id)} className="btn-ghost py-0.5 px-1.5" aria-label={t("providers.apiModelEdit")} title={t("providers.apiModelEdit")}>
                    <Icon name="pencil" size={12} />
                  </button>
                  {m.manual && (
                    <button onClick={() => deleteModel(provider, m.id).then(() => onModels(models.filter((x) => x.id !== m.id)))} className="btn-ghost py-0.5 px-1.5 text-danger" aria-label={t("providers.apiModelRemove")}>
                      <Icon name="trash" size={12} />
                    </button>
                  )}
                </div>
                {editing === m.id && <ModelEditor model={m} onSave={(p) => patch(m, p).then(() => setEditing(null))} />}
              </li>
            ))}
            {!shown.length && <li className="px-3 py-3 text-[12px] text-content-faint">{t("providers.apiModelsNone")}</li>}
          </ul>
          <div className="mt-2 flex gap-2">
            <input value={newId} onChange={(e) => setNewId(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder={t("providers.apiModelAddPlaceholder")} className="field flex-1 font-mono text-[11.5px] py-1" />
            <button onClick={add} disabled={!newId.trim()} className="btn-ghost py-1 text-[12px]"><Icon name="plus" size={13} /> {t("providers.apiModelAdd")}</button>
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm text-content-faint">{hasKey ? t("providers.apiModelsEmpty") : t("providers.apiModelsNeedKey")}</p>
      )}
    </div>
  );
}

function ModelEditor({ model, onSave }: { model: ApiModel; onSave: (p: Parameters<typeof updateModel>[2]) => Promise<unknown> }) {
  const t = useT();
  const p = model.price;
  const [label, setLabel] = useState(model.label);
  const [input, setInput] = useState(p ? String(p.input) : "");
  const [output, setOutput] = useState(p ? String(p.output) : "");
  const [cacheRead, setCacheRead] = useState(p?.cache_read !== undefined ? String(p.cache_read) : "");
  const [window, setWindow] = useState(model.context_window ? String(model.context_window) : "");
  const [error, setError] = useState("");
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  const save = () => {
    const patch: Parameters<typeof updateModel>[2] = {};
    if (label.trim() && label.trim() !== model.label) patch.label = label.trim();
    if (input.trim() || output.trim()) {
      const price: ModelPrice = { ...(model.price || {}), input: num(input) as number, output: num(output) as number };
      const cr = num(cacheRead);
      if (cr === undefined) delete price.cache_read;
      else price.cache_read = cr;
      if (!Number.isFinite(price.input) || !Number.isFinite(price.output)) return setError(t("providers.apiPriceInvalid"));
      patch.price = price;
    }
    const w = num(window);
    if (w !== undefined && w !== model.context_window) patch.context_window = w;
    onSave(patch).catch((e) => setError(errorText(e)));
  };
  return (
    <div className="mt-2 ml-10 grid gap-2 text-[11.5px]">
      <label className="grid gap-0.5">
        <span className="text-content-faint">{t("providers.apiModelName")}</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} className="field py-1 text-xs" />
      </label>
      <div className="grid grid-cols-3 gap-2">
        <label className="grid gap-0.5">
          <span className="text-content-faint">{t("providers.apiPriceInput")}</span>
          <input value={input} onChange={(e) => setInput(e.target.value)} inputMode="decimal" className="field py-1 text-xs" />
        </label>
        <label className="grid gap-0.5">
          <span className="text-content-faint">{t("providers.apiPriceOutput")}</span>
          <input value={output} onChange={(e) => setOutput(e.target.value)} inputMode="decimal" className="field py-1 text-xs" />
        </label>
        <label className="grid gap-0.5">
          <span className="text-content-faint">{t("providers.apiPriceCacheRead")}</span>
          <input value={cacheRead} onChange={(e) => setCacheRead(e.target.value)} inputMode="decimal" className="field py-1 text-xs" />
        </label>
      </div>
      <p className="text-content-faint">{t("providers.apiPriceUnit")}</p>
      <label className="grid gap-0.5">
        <span className="text-content-faint">{t("providers.apiModelWindow")}</span>
        <input value={window} onChange={(e) => setWindow(e.target.value)} inputMode="numeric" className="field py-1 text-xs" />
      </label>
      {error && <p className="text-danger">{error}</p>}
      <div className="flex gap-2 justify-end">
        {model.price_source === "custom" && (
          <button onClick={() => onSave({ clear_price: true })} className="btn-ghost py-1 text-[11.5px]">{t("providers.apiPriceReset")}</button>
        )}
        {model.context_window_set && (
          <button onClick={() => onSave({ clear_context_window: true })} className="btn-ghost py-1 text-[11.5px]">{t("providers.apiWindowReset")}</button>
        )}
        <button onClick={save} className="btn-primary py-1 text-[11.5px]">{t("common.save")}</button>
      </div>
    </div>
  );
}

// ---- context ----

function ApiContextCard({ value, onSave }: { value: number; onSave: (v: number) => Promise<unknown> }) {
  const t = useT();
  const presets = [0, 200_000, 400_000, 600_000];
  const [error, setError] = useState("");
  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <div className="grid place-items-center w-9 h-9 rounded-lg bg-accent-soft shrink-0">
          <Icon name="activity" size={17} className="text-accent" />
        </div>
        <div className="flex-1">
          <div className="font-medium">{t("providers.contextTitle")}</div>
          <p className="text-xs text-content-faint mt-0.5">{t("providers.apiContextHint")}</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p}
                onClick={() => onSave(p).then(() => setError("")).catch((e) => setError(errorText(e)))}
                className={`pill ${value === p ? "bg-accent-soft text-accent" : "bg-surface-3 text-content-dim hover:text-content"}`}
              >
                {p === 0 ? t("providers.apiFullWindow") : fmtWindow(p)}
              </button>
            ))}
          </div>
          {error && <p className="mt-1.5 text-[11px] text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}
