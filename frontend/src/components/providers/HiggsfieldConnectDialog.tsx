/**
 * Connect a Higgsfield account (docs/higgsfield.md). Higgsfield signs in only its own CLI's OAuth client, whose
 * callback is http://localhost:8765/callback — a page this server can't receive. So:
 *   1. the sign-in link opens in a new tab; after signing in, the browser lands on that (unopened) localhost address,
 *      which the user copies back here — or the desktop app catches it on localhost:8765 itself;
 *   2. or the CLI's credentials.json is pasted.
 */
import { useEffect, useRef, useState } from "react";
import {
  completeHiggsfieldLogin,
  importHiggsfieldCredentials,
  startHiggsfieldLogin,
  type HiggsfieldAccount,
} from "../../api/higgsfield";
import { useT } from "../../i18n";
import Icon from "../ui/Icon";
import { hfErrorText } from "./higgsfieldText";

/** the desktop app's catcher for the localhost callback (desktop/src/oauth-catch.js), when present */
interface CatchBridge {
  catchCallback: (o: { port: number; path: string; timeoutMs?: number }) => Promise<{ url?: string; error?: string }>;
  cancelCatch: () => Promise<void>;
}
const catcher = (): CatchBridge | null => {
  const h = (window.hrhNative as unknown as { higgsfield?: CatchBridge } | undefined)?.higgsfield;
  return h && typeof h.catchCallback === "function" ? h : null;
};

type Tab = "link" | "file";

// (the shapes of what is pasted, not words to translate)
const CREDS_EXAMPLE = '{"auth_version": 2, "access_token": "…", "refresh_token": "…", …}'; // i18n-ignore
const CALLBACK_EXAMPLE = "http://localhost:8765/callback?code=…";

export default function HiggsfieldConnectDialog({
  accountId,
  onClose,
  onConnected,
}: {
  /** sign this account in again (else: a new one, or the same email's) */
  accountId?: string;
  onClose: () => void;
  onConnected: (acc: HiggsfieldAccount) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("link");
  const [url, setUrl] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [creds, setCreds] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; detail: string | null } | null>(null);
  const [done, setDone] = useState<HiggsfieldAccount | null>(null);
  const [waiting, setWaiting] = useState<"idle" | "waiting" | "busy-port">("idle");
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    startHiggsfieldLogin(accountId)
      .then((d) => alive.current && setUrl(d.authorize_url))
      .catch((e) => alive.current && setStartError(hfErrorText(e).text));
    return () => {
      alive.current = false;
      void catcher()?.cancelCatch().catch(() => {});
    };
  }, [accountId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const finish = (acc: HiggsfieldAccount) => {
    setDone(acc);
    setTimeout(() => {
      onConnected(acc);
      onClose();
    }, 1100);
  };

  const submitCallback = async (value: string) => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      finish(await completeHiggsfieldLogin(value.trim()));
    } catch (e) {
      if (alive.current) setError(hfErrorText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const submitCreds = async () => {
    if (!creds.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      finish(await importHiggsfieldCredentials(creds.trim()));
    } catch (e) {
      if (alive.current) setError(hfErrorText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const open = () => {
    if (!url) return;
    if (window.hrhNative?.openExternal) window.hrhNative.openExternal(url);
    else window.open(url, "_blank", "noopener,noreferrer");
    const c = catcher();
    if (!c || waiting === "waiting") return;
    setWaiting("waiting");
    c.catchCallback({ port: 8765, path: "/callback", timeoutMs: 15 * 60 * 1000 })
      .then((r) => {
        if (!alive.current) return;
        if (r.url) {
          setWaiting("idle");
          setPasted(r.url);
          void submitCallback(r.url);
        } else setWaiting(r.error === "busy" ? "busy-port" : "idle");
      })
      .catch(() => alive.current && setWaiting("idle"));
  };

  const readFile = (f: File | undefined) => {
    if (!f) return;
    f.text().then(setCreds).catch(() => {});
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg card p-6 animate-fade-in"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hf-connect-title"
        data-testid="higgsfield-connect"
      >
        <div className="flex items-center gap-2.5 mb-4">
          <div className="grid place-items-center w-9 h-9 rounded-lg bg-gradient-to-br from-accent to-cyan shadow-glow">
            <Icon name="sparkles" size={17} className="text-white" />
          </div>
          <div className="flex-1">
            <h3 id="hf-connect-title" className="text-base font-semibold">
              {accountId ? t("higgsfield.signInAgainTitle") : t("higgsfield.connectTitle")}
            </h3>
            <p className="text-[11px] text-content-faint">{t("higgsfield.connectSub")}</p>
          </div>
          <button onClick={onClose} className="text-content-faint hover:text-content" aria-label={t("common.close")}>
            <Icon name="x" size={18} />
          </button>
        </div>

        {done ? (
          <div className="flex items-center gap-2 text-sm text-success py-6 justify-center" data-testid="higgsfield-connected">
            <Icon name="check" size={18} /> {t("higgsfield.connectedAs", { email: done.email || done.label })}
          </div>
        ) : (
          <>
            <div className="flex gap-1 mb-4 rounded-lg bg-surface-3/60 p-1" role="tablist">
              {(["link", "file"] as const).map((id) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => {
                    setTab(id);
                    setError(null);
                  }}
                  className={`flex-1 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition ${
                    tab === id ? "bg-surface text-content light:shadow" : "text-content-dim hover:text-content"
                  }`}
                >
                  {id === "link" ? t("higgsfield.tabLink") : t("higgsfield.tabFile")}
                </button>
              ))}
            </div>

            {tab === "link" && (
              <div className="space-y-4">
                <Step n={1} text={t("higgsfield.stepOpen")} />
                {startError ? (
                  <p className="text-[12px] text-danger">{startError}</p>
                ) : (
                  <div className="flex items-center gap-2">
                    <button onClick={open} disabled={!url} className="btn-primary flex-1" data-testid="higgsfield-open-link">
                      {url ? <Icon name="external" size={14} /> : <Icon name="spinner" size={14} spin />}
                      {t("higgsfield.openSignIn")}
                    </button>
                    <button
                      onClick={() => {
                        navigator.clipboard?.writeText(url);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }}
                      disabled={!url}
                      className="btn-ghost"
                      title={t("higgsfield.copyLink")}
                      aria-label={t("higgsfield.copyLink")}
                    >
                      <Icon name={copied ? "check" : "copy"} size={15} />
                    </button>
                  </div>
                )}
                {waiting === "waiting" && (
                  <div className="flex items-center gap-2 text-xs text-content-dim">
                    <Icon name="spinner" size={13} spin className="text-accent" /> {t("higgsfield.waitingBrowser")}
                  </div>
                )}
                {waiting === "busy-port" && <p className="text-[11.5px] text-warning">{t("higgsfield.portBusy")}</p>}
                <Step n={2} text={t("higgsfield.stepPaste")} />
                <p className="-mt-2 pl-7 text-[11.5px] text-content-faint">
                  {t.rich("higgsfield.stepPasteHint", { code: (x) => <code className="font-mono text-content-dim">{x}</code> })}
                </p>
                <div className="flex items-center gap-2">
                  <input
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && submitCallback(pasted)}
                    placeholder={CALLBACK_EXAMPLE}
                    disabled={busy}
                    className="field font-mono text-xs"
                    aria-label={t("higgsfield.pasteLabel")}
                    data-testid="higgsfield-callback"
                  />
                  <button
                    onClick={() => submitCallback(pasted)}
                    disabled={busy || !pasted.trim()}
                    className="btn-primary shrink-0 whitespace-nowrap"
                    data-testid="higgsfield-callback-submit"
                  >
                    {busy ? <Icon name="spinner" size={15} spin /> : t("higgsfield.connect")}
                  </button>
                </div>
              </div>
            )}

            {tab === "file" && (
              <div className="space-y-3">
                <p className="text-[12px] text-content-dim">
                  {t.rich("higgsfield.fileHint", { code: (x) => <code className="font-mono text-content">{x}</code> })}
                </p>
                <textarea
                  value={creds}
                  onChange={(e) => setCreds(e.target.value)}
                  rows={5}
                  spellCheck={false}
                  placeholder={CREDS_EXAMPLE}
                  className="field w-full resize-none font-mono text-[11.5px]"
                  aria-label={t("higgsfield.fileLabel")}
                  data-testid="higgsfield-credentials"
                />
                <p className="text-[11px] text-warning/90 light:text-warning">{t("higgsfield.fileShared")}</p>
                <div className="flex items-center gap-2">
                  <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => readFile(e.target.files?.[0])} />
                  <button onClick={() => fileRef.current?.click()} className="btn-ghost">
                    <Icon name="upload" size={14} /> {t("higgsfield.chooseFile")}
                  </button>
                  <button
                    onClick={submitCreds}
                    disabled={busy || !creds.trim()}
                    className="btn-primary ml-auto shrink-0 whitespace-nowrap"
                    data-testid="higgsfield-credentials-submit"
                  >
                    {busy ? <Icon name="spinner" size={15} spin /> : t("higgsfield.import")}
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="mt-3 flex items-start gap-2 rounded-lg bg-danger/8 px-3 py-2 text-[12.5px] text-danger" role="alert" data-testid="higgsfield-error">
                <Icon name="alert-circle" size={14} className="mt-[2px] shrink-0" />
                <span className="min-w-0 break-words">
                  {error.text}
                  {error.detail && <span className="mt-0.5 block font-mono text-[10.5px] text-content-faint">{error.detail}</span>}
                </span>
              </div>
            )}
            <p className="mt-4 text-[11px] text-content-faint">{t("higgsfield.connectFoot")}</p>
          </>
        )}
      </div>
    </div>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-content-dim">
      <span className="grid place-items-center w-5 h-5 shrink-0 rounded-full bg-surface-3 text-[11px] font-semibold text-content">
        {n}
      </span>
      {text}
    </div>
  );
}
