import { useEffect, useRef, useState } from "react";
import { oauthStart, oauthStatus, oauthComplete, type OAuthStart } from "../../api/providers";
import Icon from "../ui/Icon";

type Phase = "starting" | "device" | "paste" | "verifying" | "done" | "error";

export interface OAuthApi {
  start: () => Promise<OAuthStart>;
  status: () => Promise<{ status: string; error?: string }>;
  complete: (code: string) => Promise<{ ok: boolean; error?: string }>;
}

export default function ProviderOAuthModal({
  provider,
  title: titleProp,
  sub: subProp,
  api,
  onClose,
  onConnected,
}: {
  provider: string;
  title?: string;
  sub?: string;
  api?: OAuthApi;
  onClose: () => void;
  onConnected: () => void;
}) {
  const call: OAuthApi = api || {
    start: () => oauthStart(provider),
    status: () => oauthStatus(provider),
    complete: (code: string) => oauthComplete(provider, code),
  };
  const [phase, setPhase] = useState<Phase>("starting");
  const [data, setData] = useState<OAuthStart | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"url" | "code" | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    call.start()
      .then((d) => {
        if (!alive) return;
        if (d.error && !d.url) {
          setError(d.error);
          setPhase("error");
          return;
        }
        setData(d);
        setPhase(d.flow === "device" ? "device" : "paste");
        if (d.flow === "device") startPolling();
      })
      .catch((e) => {
        if (alive) {
          setError(String(e.message || e));
          setPhase("error");
        }
      });
    return () => {
      alive = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const startPolling = () => {
    pollRef.current = setInterval(async () => {
      try {
        const st = await call.status();
        if (st.status === "connected") {
          if (pollRef.current) clearInterval(pollRef.current);
          setPhase("done");
          setTimeout(() => {
            onConnected();
            onClose();
          }, 900);
        } else if (st.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setError(st.error || "login failed");
          setPhase("error");
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
  };

  const copy = (text: string, which: "url" | "code") => {
    navigator.clipboard?.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  };

  const submitCode = async () => {
    if (!code.trim()) return;
    setPhase("verifying");
    setError("");
    try {
      const r = await call.complete(code.trim());
      if (r.ok) {
        setPhase("done");
        setTimeout(() => {
          onConnected();
          onClose();
        }, 900);
      } else {
        setError(r.error || "verification failed");
        setPhase("paste");
      }
    } catch (e: any) {
      setError(String(e.message || e));
      setPhase("paste");
    }
  };

  const title = titleProp || (provider === "codex" ? "Connect Codex" : "Connect Claude");
  const sub = subProp || (provider === "codex" ? "ChatGPT account (device code)" : "Claude subscription (token)");

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md card p-6 animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 mb-5">
          <div className="grid place-items-center w-9 h-9 rounded-lg bg-gradient-to-br from-accent to-cyan shadow-glow">
            <Icon name="key" size={17} className="text-white" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold">{title}</h3>
            <p className="text-[11px] text-content-faint">{sub}</p>
          </div>
          <button onClick={onClose} className="text-content-faint hover:text-content">
            <Icon name="x" size={18} />
          </button>
        </div>

        {phase === "starting" && (
          <div className="flex items-center gap-2 text-sm text-content-dim py-6 justify-center">
            <Icon name="spinner" size={16} spin /> Preparing sign-in…
          </div>
        )}

        {phase === "device" && data && (
          <div className="space-y-4">
            <Step n={1} text="Open this link and sign in:" />
            <LinkRow url={data.url!} copied={copied === "url"} onCopy={() => copy(data.url!, "url")} />
            <Step n={2} text="Enter this one-time code:" />
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg border border-border bg-surface px-3 py-2.5 text-center text-lg font-mono tracking-[0.3em] text-accent">
                {data.user_code}
              </code>
              <button onClick={() => copy(data.user_code!, "code")} className="btn-ghost">
                <Icon name={copied === "code" ? "check" : "copy"} size={16} />
              </button>
            </div>
            <div className="flex items-center gap-2 text-xs text-content-dim pt-1">
              <Icon name="spinner" size={14} spin className="text-accent" />
              Waiting for authorization…
            </div>
          </div>
        )}

        {(phase === "paste" || phase === "verifying") && data && (
          <div className="space-y-4">
            <Step n={1} text="Open this link, sign in, and authorize:" />
            <LinkRow url={data.url!} copied={copied === "url"} onCopy={() => copy(data.url!, "url")} />
            <Step n={2} text="Paste the code you receive:" />
            <div className="flex items-center gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && submitCode()}
                placeholder="Paste code here"
                disabled={phase === "verifying"}
                className="field font-mono"
                autoFocus
              />
              <button onClick={submitCode} disabled={phase === "verifying" || !code.trim()} className="btn-primary">
                {phase === "verifying" ? <Icon name="spinner" size={15} spin /> : "Verify"}
              </button>
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="flex items-center gap-2 text-sm text-success py-6 justify-center">
            <Icon name="check" size={18} /> Connected!
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-3 py-2">
            <p className="text-sm text-danger flex items-start gap-2">
              <Icon name="x" size={16} className="mt-0.5 shrink-0" />
              <span className="break-words">{error}</span>
            </p>
            <button onClick={onClose} className="btn-ghost w-full">
              Close
            </button>
          </div>
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

function LinkRow({ url, copied, onCopy }: { url: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="flex-1 truncate text-[12px] text-accent hover:underline font-mono"
      >
        {url}
      </a>
      <a href={url} target="_blank" rel="noreferrer" className="text-content-faint hover:text-content" title="Open">
        <Icon name="external" size={15} />
      </a>
      <button onClick={onCopy} className="text-content-faint hover:text-content" title="Copy">
        <Icon name={copied ? "check" : "copy"} size={15} />
      </button>
    </div>
  );
}
