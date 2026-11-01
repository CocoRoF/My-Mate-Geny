/**
 * Error boundaries: a render error or a code chunk that failed to load never leaves a blank (black) window.
 *   page  — the root: a full-page "Something went wrong · Reload" screen
 *   view  — one console view (sidebar stays): the same, inside the content area, with "Try again"
 *   card  — the desktop quick card: a one-line notice
 *   quiet — the transparent avatar window: nothing on the desktop; it reloads itself with backoff
 * A chunk failure (a deploy since the page loaded) reloads the page once by itself (lib/recover.ts).
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "../../api/admin";
import { canAutoReload, isChunkError, reloadNow, reloadOnce } from "../../lib/recover";
import Icon from "./Icon";
import { tr } from "../../i18n";

type Variant = "page" | "view" | "card" | "quiet";

interface Props {
  variant?: Variant;
  /** a change clears the error (e.g. the console view switched) */
  resetKey?: unknown;
  /** drawn above a full-page error screen (the desktop window's title bar) */
  chrome?: ReactNode;
  children: ReactNode;
}

interface State {
  error: unknown;
  reloading: boolean;
  key: unknown;
}

const QUIET_KEY = "hrh.recover.quiet";

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloading: false, key: this.props.resetKey };
  private timer: number | undefined;

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error, reloading: isChunkError(error) && canAutoReload() };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.key) return { key: props.resetKey, error: state.reloading ? state.error : null };
    return null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const chunk = isChunkError(error);
    if (chunk && this.state.reloading && reloadOnce("boundary")) return;
    if (chunk && this.state.reloading) this.setState({ reloading: false });
    reportClientError({
      kind: chunk ? "chunk" : "render",
      message: String((error as any)?.message || error),
      stack: `${(error as any)?.stack || ""}\n--- component stack ---${info.componentStack || ""}`.slice(0, 4000),
    });
    if (this.props.variant === "quiet") {
      // the avatar window: try again later, a little later each time (5 s, 15 s, 45 s … 5 min)
      let n = 0;
      try {
        n = Number(sessionStorage.getItem(QUIET_KEY)) || 0;
        sessionStorage.setItem(QUIET_KEY, String(n + 1));
      } catch {
        /* ignore */
      }
      this.timer = window.setTimeout(() => window.location.reload(), Math.min(300_000, 5000 * 3 ** n));
    }
  }

  componentWillUnmount() {
    window.clearTimeout(this.timer);
  }

  render() {
    const { error, reloading } = this.state;
    if (!error) return this.props.children;
    const variant = this.props.variant ?? "page";
    if (variant === "quiet") return null;
    const chunk = isChunkError(error);
    if (reloading) return <Updating variant={variant} />;
    if (variant === "card") {
      return (
        <div className="p-2" data-testid="error-card">
          <div className="flex items-center gap-2 rounded-2xl border border-border bg-[#11141b]/95 px-3 py-2.5 text-[13px] text-content shadow-float">
            <Icon name="warning" size={14} className="shrink-0 text-warning" />
            <span className="min-w-0 flex-1 truncate">{chunk ? tr("nav.errUpdatedCard") : tr("common.somethingWrong")}</span>
            <button className="btn-primary !px-3 !py-1 text-[12px]" onClick={reloadNow}>
              {tr("common.reload")}
            </button>
          </div>
        </div>
      );
    }
    return (
      <ErrorScreen
        variant={variant}
        chrome={variant === "page" ? this.props.chrome : undefined}
        title={chunk ? tr("nav.errPageUpdated") : tr("nav.errSomethingWrong")}
        message={
          chunk ? tr("nav.errPageUpdatedMsg") : tr("nav.errStoppedMsg")
        }
        detail={chunk ? undefined : String((error as any)?.message || error)}
        onRetry={variant === "view" && !chunk ? () => this.setState({ error: null }) : undefined}
      />
    );
  }
}

function Updating({ variant }: { variant: Variant }) {
  return (
    <div className={`grid place-items-center ${variant === "page" ? "h-full min-h-[100dvh]" : "h-full"} text-sm text-content-dim`} data-testid="error-reloading">
      <div className="flex items-center gap-2.5">
        <Icon name="spinner" size={16} spin className="text-accent" />
        {tr("nav.errUpdating")}
      </div>
    </div>
  );
}

export function ErrorScreen({
  variant = "page",
  title,
  message,
  detail,
  onRetry,
  chrome,
}: {
  variant?: Variant;
  title: string;
  message: string;
  detail?: string;
  onRetry?: () => void;
  chrome?: ReactNode;
}) {
  const page = variant === "page";
  return (
    <div className={`flex flex-col ${page ? "h-[100dvh]" : "h-full"}`} data-testid="error-screen">
      {chrome}
      <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto p-6">
        <div className="w-full max-w-[400px] rounded-2xl border border-border bg-surface-2/80 p-7 text-center shadow-card backdrop-blur animate-fade-in">
          {page ? (
            <img src="/logo.png" alt="" width={52} height={52} className="mx-auto mb-3 h-[52px] w-[52px] select-none" draggable={false} />
          ) : (
            <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-warning/10 text-warning">
              <Icon name="warning" size={20} />
            </div>
          )}
          <h1 className="text-[16px] font-semibold text-content">{title}</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-content-dim">{message}</p>
          {detail && (
            <details className="mt-3 text-left">
              <summary className="cursor-pointer text-[11.5px] text-content-faint hover:text-content-dim">{tr("common.details")}</summary>
              <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-bg/60 p-2 font-mono text-[11px] text-content-faint">
                {detail}
              </pre>
            </details>
          )}
          <div className="mt-5 flex justify-center gap-2">
            {onRetry && (
              <button className="btn-ghost" onClick={onRetry}>
                {tr("common.tryAgain")}
              </button>
            )}
            <button className="btn-primary" onClick={reloadNow} data-testid="error-reload">
              <Icon name="refresh" size={14} /> {tr("common.reload")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
