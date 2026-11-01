import { useT } from "../../i18n";

/** One loading look everywhere (the same ring as index.html's boot screen), fading in after a beat so quick loads
 *  don't flash it. */
export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-block shrink-0 animate-spin rounded-full border-2 border-accent/25 border-t-accent ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

export default function PageLoading({ label, testId = "view-loading" }: { label?: string; testId?: string }) {
  const t = useT();
  return (
    <div className="grid h-full place-items-center" data-testid={testId} role="status" aria-live="polite">
      <div className="flex items-center gap-2.5 text-[13px] text-content-faint opacity-0 [animation:fade-in_.25s_ease-out_.15s_forwards]">
        <Spinner />
        {label ?? t("common.loading")}
      </div>
    </div>
  );
}
