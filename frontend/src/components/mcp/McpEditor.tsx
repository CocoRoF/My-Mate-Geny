import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  importMcp,
  saveMcp,
  testMcp,
  registerMcpTest,
  discardMcpTest,
  type McpEntry,
  type McpInput,
} from "../../api/mcp";
import { useT } from "../../i18n";
import { mcpArguments, mcpSecrets, type SecretRow } from "../../lib/mcpForm";
import { issueText } from "./McpIssue";
import Icon from "../ui/Icon";

function Secrets({
  title,
  rows,
  setRows,
  headers = false,
}: {
  title: string;
  rows: SecretRow[];
  setRows: (v: SecretRow[]) => void;
  headers?: boolean;
}) {
  const t = useT(),
    [show, setShow] = useState(false);
  const placeholder = headers ? "Authorization" : "API_KEY"; // i18n-ignore (protocol identifiers)
  const change = (i: number, patch: Partial<SecretRow>) =>
    setRows(rows.map((row, n) => (i === n ? { ...row, ...patch } : row)));
  return (
    <fieldset className="rounded-xl border border-border p-3">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      <p className="mb-2 text-xs text-content-faint">{t("mcp.secretHint")}</p>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div className="flex flex-wrap gap-2 sm:flex-nowrap" key={i}>
            <input
              className="field min-w-0 flex-1 basis-36 font-mono text-xs"
              aria-label={t("mcp.keyName")}
              placeholder={placeholder}
              value={row.name}
              onChange={(e) => change(i, { name: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            <input
              className="field min-w-0 flex-1 basis-48 text-xs"
              aria-label={t("mcp.keyValue")}
              type={show ? "text" : "password"}
              value={row.value}
              placeholder={t(row.keep ? "mcp.keepSecret" : "mcp.enterValue")}
              onChange={(e) => change(i, { value: e.target.value })}
              autoComplete="new-password"
            />
            <button
              type="button"
              className="btn-ghost !px-2"
              aria-label={t("mcp.removeRow")}
              onClick={() => setRows(rows.filter((_, n) => n !== i))}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <button
          className="btn-ghost !py-1 text-xs"
          type="button"
          onClick={() =>
            setRows([...rows, { name: "", value: "", keep: false }])
          }
        >
          <Icon name="plus" size={12} />
          {t("mcp.addRow")}
        </button>
        <button
          className="btn-ghost ml-auto !py-1 text-xs"
          type="button"
          onClick={() => setShow(!show)}
        >
          <Icon name={show ? "eye-off" : "eye"} size={12} />
          {t(show ? "mcp.hideValues" : "mcp.showValues")}
        </button>
      </div>
    </fieldset>
  );
}

export function Editor({
  item,
  onDone,
  onCancel,
}: {
  item: McpEntry | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [name, setName] = useState(item?.name ?? ""),
    [transport, setTransport] = useState(item?.transport ?? "stdio");
  const [command, setCommand] = useState(item?.command ?? ""),
    [args, setArgs] = useState(JSON.stringify(item?.args ?? [], null, 2));
  const [cwd, setCwd] = useState(item?.cwd ?? ""),
    [url, setUrl] = useState(item?.url ?? "");
  const [env, setEnv] = useState<SecretRow[]>(
    Object.keys(item?.env ?? {}).map((name) => ({
      name,
      value: "",
      keep: true,
    })),
  );
  const [headers, setHeaders] = useState<SecretRow[]>(
    Object.keys(item?.headers ?? {}).map((name) => ({
      name,
      value: "",
      keep: true,
    })),
  );
  const [diagnostics, setDiagnostics] = useState(item?.log_stderr ?? false);
  const [timeout, setTimeout] = useState(item?.timeout_s ?? 120),
    [enabled, setEnabled] = useState(item?.enabled ?? true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body: McpInput = {
        name,
        catalog_id: item?.catalog_id ?? "",
        transport,
        command,
        args: mcpArguments(args),
        cwd,
        url,
        env: mcpSecrets(env),
        headers: mcpSecrets(headers, true),
        timeout_s: timeout,
        log_stderr: diagnostics,
        enabled,
      };
      if (enabled) {
        const checked = await testMcp(body, item?.id);
        if (!alive.current) {
          if (checked.test_id) void discardMcpTest(checked.test_id);
          return;
        }
        if (!checked.ok || !checked.test_id)
          throw new Error(
            issueText(t, checked.error_code) ||
              checked.error ||
              t("mcp.testFailed"),
          );
        await registerMcpTest(checked.test_id);
      } else await saveMcp(body, item?.id);
      if (alive.current) onDone();
    } catch (e) {
      setError(
        ["invalid_arguments", "duplicate_or_empty_key"].includes(
          (e as Error).message,
        ) || (e as Error).message.startsWith("invalid_config")
          ? t("mcp.invalidForm")
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="card space-y-4 p-4 sm:p-5"
      onSubmit={submit}
      data-testid="mcp-editor"
    >
      <fieldset disabled={busy} className="space-y-4">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 font-semibold">
            {t(item ? "mcp.edit" : "mcp.add")}
          </h3>
          <button
            type="button"
            className="btn-ghost !px-2"
            disabled={busy}
            onClick={onCancel}
            aria-label={t("common.close")}
          >
            <Icon name="x" size={15} />
          </button>
        </div>
        <label className="block text-xs text-content-dim">
          {t("mcp.name")}
          <input
            className="field mt-1 w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            autoFocus
            data-testid="mcp-name"
          />
        </label>
        <label className="block text-xs text-content-dim">
          {t("mcp.transport")}
          <select
            className="field mt-1 w-full"
            value={transport}
            onChange={(e) => setTransport(e.target.value as typeof transport)}
            data-testid="mcp-transport"
          >
            <option value="stdio">{t("mcp.stdio")}</option>
            <option value="http">{t("mcp.http")}</option>
            <option value="sse">{t("mcp.sse")}</option>
          </select>
        </label>
        {transport === "stdio" ? (
          <>
            <label className="block text-xs text-content-dim">
              {t("mcp.command")}
              <input
                className="field mt-1 w-full font-mono"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
                required
                data-testid="mcp-command"
              />
            </label>
            <label className="block text-xs text-content-dim">
              {t("mcp.arguments")}
              <textarea
                className="field mt-1 min-h-24 w-full font-mono text-xs"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                spellCheck={false}
                data-testid="mcp-args"
              />
            </label>
            {args.includes("null") && (
              <p className="text-xs text-content-faint">
                {t("mcp.secretArgHint")}
              </p>
            )}
            <label className="block text-xs text-content-dim">
              {t("mcp.cwd")}
              <input
                className="field mt-1 w-full font-mono text-xs"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
            </label>
            <Secrets title={t("mcp.environment")} rows={env} setRows={setEnv} />
          </>
        ) : (
          <>
            <label className="block text-xs text-content-dim">
              {t("mcp.url")}
              <input
                className="field mt-1 w-full font-mono text-xs"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
                required
                data-testid="mcp-url"
              />
            </label>
            <Secrets
              title={t("mcp.headers")}
              rows={headers}
              setRows={setHeaders}
              headers
            />
          </>
        )}
        <details>
          <summary className="cursor-pointer text-xs text-content-dim">
            {t("mcp.advanced")}
          </summary>
          <label className="mt-2 block text-xs text-content-dim">
            {t("mcp.timeout")}
            <input
              type="number"
              className="field ml-2 w-24"
              min={5}
              max={3600}
              value={timeout}
              onChange={(e) => setTimeout(Number(e.target.value))}
            />
          </label>
          <label className="mt-3 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={diagnostics}
              onChange={(e) => setDiagnostics(e.target.checked)}
            />
            {t("mcp.diagnostics")}
          </label>
          <p className="mt-1 text-xs text-content-faint">
            {t("mcp.diagnosticsHint")}
          </p>
        </details>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t("mcp.connectAfterSave")}
        </label>
        {error && (
          <p
            className="whitespace-pre-wrap break-words text-xs text-danger"
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <button
            className="btn-ghost"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
          <button
            className="btn-primary"
            disabled={busy}
            data-testid="mcp-save"
          >
            <Icon name={busy ? "spinner" : "check"} size={14} spin={busy} />
            {t(
              busy ? "mcp.saving" : enabled ? "mcp.saveConnect" : "common.save",
            )}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

export function ImportForm({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT(),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await importMcp(JSON.parse(text));
      setText("");
      onDone();
    } catch (e) {
      setError(
        e instanceof SyntaxError ? t("mcp.invalidJson") : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="card space-y-3 p-4"
      onSubmit={submit}
      data-testid="mcp-import"
    >
      <h3 className="font-semibold">{t("mcp.import")}</h3>
      <p className="text-xs text-content-faint">{t("mcp.importHint")}</p>
      <textarea
        className="field min-h-44 w-full font-mono text-xs"
        aria-label={t("mcp.jsonConfig")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          '{"mcpServers":{"my-tool":{"command":"npx","args":["-y","package"],"env":{"API_KEY":"..."}}}}'
        }
        spellCheck={false}
        required
      />
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn-ghost"
          onClick={onCancel}
          disabled={busy}
        >
          {t("common.cancel")}
        </button>
        <button className="btn-primary" disabled={busy}>
          {t(busy ? "mcp.saving" : "mcp.import")}
        </button>
      </div>
    </form>
  );
}
