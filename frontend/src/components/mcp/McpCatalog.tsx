import { useEffect, useRef, useState } from "react";
import {
  cancelMcpDownload,
  discardMcpTest,
  downloadMcpRecipe,
  listMcpRecipes,
  mcpDownloadState,
  mcpRecipeDefaults,
  registerMcpTest,
  testMcpRecipe,
  type McpEntry,
  type McpInstallation,
  type McpRecipe,
  type McpTest,
  type McpText,
} from "../../api/mcp";
import { useLang, useT } from "../../i18n";
import { folderBridge } from "../../lib/localFolder";
import { useConfigStore } from "../../stores/configStore";
import Icon from "../ui/Icon";
import McpIssue from "./McpIssue";

export default function McpCatalog({
  initial,
  onRegistered,
}: {
  initial: { recipe: string; existing?: McpEntry } | null;
  onRegistered: () => void;
}) {
  const t = useT(),
    lang = useLang(),
    local = useConfigStore((s) => s.executionMode) === "local";
  const tr = (value: McpText) => value[lang] ?? value.en;
  const [items, setItems] = useState<McpRecipe[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(initial?.recipe ?? ""),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState("all");
  const load = async () => {
    setLoading(true);
    try {
      setItems((await listMcpRecipes()).items);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const recipe = items.find((r) => r.id === selected);
  if (recipe)
    return (
      <Wizard
        key={recipe.id + ":" + (initial?.existing?.id ?? "")}
        recipe={recipe}
        existing={initial?.existing}
        onClose={() => {
          setSelected("");
          void load();
        }}
        onRegistered={onRegistered}
      />
    );
  const shown = items.filter(
    (r) =>
      (category === "all" || r.category === category) &&
      [r.name, r.publisher, tr(r.summary)]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="space-y-4" data-testid="mcp-discovery">
      <p className="text-sm text-content-dim">{t("mcp.catalogHint")}</p>
      <div className="flex flex-wrap gap-2">
        <input
          className="field min-w-0 flex-1"
          type="search"
          aria-label={t("mcp.searchCatalog")}
          placeholder={t("mcp.searchCatalog")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="field"
          aria-label={t("mcp.category")}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="all">{t("mcp.categoryAll")}</option>
          <option value="work">{t("mcp.categoryWork")}</option>
          <option value="development">{t("mcp.categoryDevelopment")}</option>
          <option value="files">{t("mcp.categoryFiles")}</option>
        </select>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
          <button className="btn-ghost" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm text-content-faint">
          {t("mcp.catalogLoading")}
        </p>
      )}
      {!loading && !shown.length && (
        <p className="py-6 text-center text-content-faint">
          {t("mcp.noCatalogMatches")}
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {shown.map((r) => (
          <section
            className="card flex flex-col p-4"
            key={r.id}
            data-testid={`mcp-recipe-${r.id}`}
          >
            <div className="flex items-start gap-2">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                <Icon
                  name={r.kind === "remote" ? "server" : "plug"}
                  size={18}
                />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold">{r.name}</h3>
                <p className="mt-1 text-[11px] text-content-faint">
                  {r.publisher} ·{" "}
                  {t(r.official ? "mcp.official" : "mcp.community")}
                </p>
              </div>
              {r.installation.installed && r.kind !== "remote" && (
                <span className="pill bg-success/10 text-success">
                  {t("mcp.downloaded")}
                </span>
              )}
            </div>
            <p className="my-3 flex-1 text-xs leading-relaxed text-content-dim">
              {tr(r.summary)}
            </p>
            <p className="mb-3 text-[11px] text-content-faint">
              {t(
                r.kind === "remote"
                  ? "mcp.noDownload"
                  : local
                    ? "mcp.installOnDevice"
                    : "mcp.installOnServer",
              )}
            </p>
            <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-3">
              <a
                className="text-xs text-accent hover:underline"
                href={r.docs}
                target="_blank"
                rel="noreferrer"
              >
                {t("mcp.downloadMethod")} ↗
              </a>
              <button
                className="btn-soft ml-auto !py-1.5 text-xs"
                onClick={() => setSelected(r.id)}
              >
                {t("mcp.startSetup")}
                <Icon name="chevron" size={12} />
              </button>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function Wizard({
  recipe,
  existing,
  onClose,
  onRegistered,
}: {
  recipe: McpRecipe;
  existing?: McpEntry;
  onClose: () => void;
  onRegistered: () => void;
}) {
  const t = useT(),
    lang = useLang(),
    local = useConfigStore((s) => s.executionMode) === "local";
  const tr = (value: McpText) => value[lang] ?? value.en;
  const explain = (message: string) => {
    if (message.startsWith("required_field:")) {
      const key = message.split(":")[1],
        field = recipe.fields.find((f) => f.key === key);
      return t("mcp.requiredCatalogField", {
        field: field ? tr(field.label) : key,
      });
    }
    if (message === "invalid_allowed_folder") return t("mcp.issueFolder");
    if (message === "mcp_installation_busy") return t("mcp.downloadBusy");
    if (message === "mcp_test_expired" || message === "mcp_test_disconnected")
      return t("mcp.testExpired");
    if (message === "mcp_config_changed") return t("mcp.setupChanged");
    return message;
  };

  const [step, setStep] = useState(0),
    [job, setJob] = useState<McpInstallation>(recipe.installation),
    [name, setName] = useState(existing?.name ?? recipe.name);
  const [values, setValues] = useState<Record<string, string | boolean>>({}),
    [saved, setSaved] = useState<string[]>([]),
    [loaded, setLoaded] = useState(false);
  const [test, setTest] = useState<McpTest | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const proof = useRef<string | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let active = true;
    mcpRecipeDefaults(recipe.id, existing?.id)
      .then((r) => {
        if (active) {
          setValues(r.values);
          setSaved(r.saved_fields);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (active) setError(explain(e.message));
      });
    return () => {
      active = false;
      alive.current = false;
      if (proof.current) void discardMcpTest(proof.current);
    };
  }, [recipe.id, existing?.id]);
  useEffect(() => {
    if (job.phase !== "installing") return;
    let active = true;
    const timer = setInterval(() => {
      mcpDownloadState(recipe.id)
        .then((state) => {
          if (!active) return;
          setJob(state);
          if (state.phase === "ready") setStep(1);
        })
        .catch((e) => {
          if (active) setError(explain(e.message));
        });
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [recipe.id, job.phase]);
  useEffect(() => {
    if (!test?.test_id) return;
    const timer = setTimeout(
      () => {
        proof.current = null;
        setTest(null);
        setStep(1);
        setError(t("mcp.testExpired"));
      },
      (test.expires_in ?? 300) * 1000,
    );
    return () => clearTimeout(timer);
  }, [test, t]);
  const invalidate = () => {
    if (proof.current) void discardMcpTest(proof.current);
    proof.current = null;
    setTest(null);
    setError("");
  };
  const change = (key: string, value: string | boolean) => {
    invalidate();
    setValues((v) => ({ ...v, [key]: value }));
  };
  const prepare = async () => {
    setError("");
    if (job.installed) {
      setStep(1);
      return;
    }
    try {
      const state = await downloadMcpRecipe(recipe.id);
      setJob(state);
      if (state.installed) setStep(1);
    } catch (e) {
      setError(explain((e as Error).message));
    }
  };
  const check = async () => {
    setBusy(true);
    setError("");
    invalidate();
    try {
      const checked = await testMcpRecipe(
        recipe.id,
        values,
        name,
        existing?.id,
      );
      if (!alive.current) {
        if (checked.test_id) void discardMcpTest(checked.test_id);
        return;
      }
      setTest(checked);
      if (checked.ok && checked.test_id) {
        proof.current = checked.test_id;
        setStep(2);
      }
    } catch (e) {
      if (alive.current) setError(explain((e as Error).message));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const register = async () => {
    if (!proof.current) return;
    setBusy(true);
    setError("");
    try {
      await registerMcpTest(proof.current);
      proof.current = null;
      onRegistered();
    } catch (e) {
      setError(explain((e as Error).message));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const visible = recipe.fields.filter((f) => {
    if (
      recipe.id === "atlassian" &&
      (f.key.startsWith("jira_") || f.key.startsWith("confluence_"))
    ) {
      if (
        values.service !== "both" &&
        !f.key.startsWith(String(values.service) + "_")
      )
        return false;
      if (f.key.endsWith("_email") && values.deployment === "server")
        return false;
    }
    if (
      recipe.id === "atlassian-cloud" &&
      f.key === "email" &&
      values.auth === "bearer"
    )
      return false;
    return true;
  });
  const chooseFolder = async () => {
    try {
      const bridge = folderBridge();
      if (!bridge) return;
      const result = await bridge.pick();
      if (result) {
        try {
          change(
            "folders",
            [values.folders, result.path].filter(Boolean).join("\n"),
          );
        } finally {
          await bridge.release(result.path);
        }
      }
    } catch (e) {
      setError(explain((e as Error).message));
    }
  };
  return (
    <section
      className="card space-y-4 p-4 sm:p-5"
      data-testid="mcp-setup-wizard"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{recipe.name}</h3>
          <p className="mt-1 text-xs text-content-faint">
            {existing ? t("mcp.replaceExisting") : t("mcp.newRegistration")}
          </p>
        </div>
        <button
          className="btn-ghost !px-2"
          aria-label={t("common.close")}
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <ol className="grid grid-cols-3 gap-2 text-[11px] sm:text-xs">
        {[
          t(
            recipe.kind === "remote" ? "mcp.prepareConnection" : "mcp.download",
          ),
          t("mcp.configureTest"),
          t("mcp.registerSuccess"),
        ].map((label, index) => (
          <li
            key={index}
            aria-current={step === index ? "step" : undefined}
            className={`rounded-lg border p-2 ${step === index ? "border-accent bg-accent-soft text-accent" : step > index ? "border-success/30 text-success" : "border-border text-content-faint"}`}
          >
            <span className="mr-1">{index + 1}.</span>
            {label}
          </li>
        ))}
      </ol>
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-danger/5 p-3 text-xs text-danger"
        >
          {error}
        </p>
      )}
      {step === 0 && (
        <>
          <p className="text-sm text-content-dim">{tr(recipe.summary)}</p>
          <p className="text-xs text-content-faint">
            {t(
              recipe.kind === "remote"
                ? "mcp.remotePreparation"
                : local
                  ? "mcp.installOnDevice"
                  : "mcp.installOnServer",
            )}
          </p>
          <details className="rounded-lg border border-border p-3 text-xs" open>
            <summary className="cursor-pointer font-medium">
              {t("mcp.downloadMethod")}
            </summary>
            <p className="mt-2 text-content-faint">
              {t(
                recipe.kind === "remote"
                  ? "mcp.noDownload"
                  : "mcp.isolatedInstallHint",
              )}
            </p>
            <code className="my-2 block break-all rounded bg-surface-2 p-2">
              {recipe.method}
            </code>
            <a
              className="text-accent hover:underline"
              href={recipe.docs}
              target="_blank"
              rel="noreferrer"
            >
              {t("mcp.publisherDocs")} ↗
            </a>
            <span className="mx-2 text-content-faint">·</span>
            <a
              className="text-accent hover:underline"
              href={recipe.source}
              target="_blank"
              rel="noreferrer"
            >
              {t("mcp.sourceCode")} ↗
            </a>
          </details>
          {job.phase === "installing" && (
            <div
              role="status"
              className="rounded-lg bg-accent-soft p-3 text-sm text-accent"
            >
              <Icon name="spinner" size={14} spin className="mr-2 inline" />
              {t("mcp.downloading")}
            </div>
          )}
          {job.error && (
            <p role="alert" className="text-xs text-danger">
              {job.error}
            </p>
          )}
          {!!job.log?.length && (
            <details
              className="text-xs text-content-faint"
              open={job.phase === "error"}
            >
              <summary className="cursor-pointer">
                {t("mcp.downloadLog")}
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-2">
                {job.log.join("\n")}
              </pre>
            </details>
          )}
          <div className="flex justify-end gap-2">
            {job.phase === "installing" ? (
              <button
                className="btn-ghost"
                onClick={() =>
                  void cancelMcpDownload(recipe.id)
                    .then(setJob)
                    .catch((e) => setError(explain(e.message)))
                }
              >
                {t("mcp.cancelDownload")}
              </button>
            ) : (
              <button
                className="btn-primary"
                data-testid="mcp-download-next"
                onClick={() => void prepare()}
              >
                {t(
                  job.installed
                    ? "mcp.configureTest"
                    : recipe.kind === "remote"
                      ? "mcp.prepareConnection"
                      : "mcp.download",
                )}
              </button>
            )}
          </div>
        </>
      )}
      {step === 1 && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void check();
          }}
        >
          <p className="text-xs leading-relaxed text-content-dim">
            {tr(recipe.help)}
          </p>
          <label className="block text-xs text-content-dim">
            {t("mcp.name")}
            <input
              className="field mt-1 w-full"
              value={name}
              maxLength={80}
              disabled={busy}
              onChange={(e) => {
                invalidate();
                setName(e.target.value);
              }}
              required
            />
          </label>
          {visible.map((f) => (
            <label key={f.key} className="block text-xs text-content-dim">
              {f.kind === "boolean" ? (
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={values[f.key] === true}
                    disabled={busy}
                    onChange={(e) => change(f.key, e.target.checked)}
                  />
                  {tr(f.label)}
                </span>
              ) : (
                <>
                  {tr(f.label)}
                  {f.kind === "select" ? (
                    <select
                      className="field mt-1 w-full"
                      value={String(values[f.key] ?? "")}
                      disabled={busy}
                      data-testid={`mcp-field-${f.key}`}
                      onChange={(e) => change(f.key, e.target.value)}
                    >
                      {f.choices.map((c) => (
                        <option key={c.value} value={c.value}>
                          {tr(c.label)}
                        </option>
                      ))}
                    </select>
                  ) : f.kind === "multiline" ? (
                    <textarea
                      className="field mt-1 min-h-24 w-full font-mono text-xs"
                      value={String(values[f.key] ?? "")}
                      disabled={busy}
                      required={f.required}
                      data-testid={`mcp-field-${f.key}`}
                      onChange={(e) => change(f.key, e.target.value)}
                    />
                  ) : (
                    <input
                      className="field mt-1 w-full"
                      type={
                        ["url", "email", "password"].includes(f.kind)
                          ? f.kind
                          : "text"
                      }
                      value={String(values[f.key] ?? "")}
                      disabled={busy}
                      required={f.required && !saved.includes(f.key)}
                      autoComplete={
                        f.kind === "password" ? "new-password" : "off"
                      }
                      placeholder={
                        saved.includes(f.key) ? t("mcp.keepSecret") : undefined
                      }
                      data-testid={`mcp-field-${f.key}`}
                      onChange={(e) => change(f.key, e.target.value)}
                    />
                  )}
                </>
              )}
            </label>
          ))}
          {recipe.id === "filesystem" && local && folderBridge() && (
            <button
              type="button"
              className="btn-soft"
              disabled={busy}
              onClick={() => void chooseFolder()}
            >
              <Icon name="folder-open" size={15} />
              {t("setup.pickFolder")}
            </button>
          )}
          <p className="text-xs text-content-faint">{t("mcp.testScope")}</p>
          {test && !test.ok && (
            <McpIssue code={test.error_code} fallback={test.error} />
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => setStep(0)}
            >
              {t("mcp.previousStep")}
            </button>
            <button
              className="btn-primary"
              disabled={!loaded || busy}
              data-testid="mcp-run-test"
            >
              {busy && <Icon name="spinner" spin size={14} />}{" "}
              {t(busy ? "mcp.testing" : "mcp.testConnection")}
            </button>
          </div>
        </form>
      )}
      {step === 2 && test?.ok && (
        <>
          <div
            role="status"
            className="rounded-xl border border-success/30 bg-success/5 p-4"
          >
            <p className="text-sm font-medium text-success">
              <Icon name="check" size={16} className="mr-1 inline" />
              {t("mcp.testPassed")}
            </p>
            <p className="mt-2 break-words text-sm">{name}</p>
            <p className="mt-1 text-xs text-content-faint">
              {t("mcp.toolsCount", { count: test.tool_count })}
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {test.tools?.map((tool) => (
                <span
                  key={tool.name}
                  className="pill bg-surface-2 font-mono text-[10px]"
                >
                  {tool.name}
                </span>
              ))}
            </div>
          </div>
          <p className="text-xs text-content-faint">
            {t("mcp.registrationHint")}
          </p>
          <div className="flex justify-end gap-2">
            <button
              className="btn-ghost"
              disabled={busy}
              onClick={() => {
                invalidate();
                setStep(1);
              }}
            >
              {t("mcp.edit")}
            </button>
            <button
              className="btn-primary"
              disabled={busy}
              data-testid="mcp-register-tested"
              onClick={() => void register()}
            >
              {busy && <Icon name="spinner" spin size={14} />}{" "}
              {t("mcp.registerMcp")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
