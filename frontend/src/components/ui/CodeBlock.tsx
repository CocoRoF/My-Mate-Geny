import { useState, type ReactNode } from "react";
import "highlight.js/styles/github-dark.css";
import Icon from "./Icon";
import { textOf } from "./codeHighlight";
import { useT } from "../../i18n";

/** A fenced code block: language label, copy button, the (highlighted) code scrolling sideways inside its box. */
export default function CodeBlock({ children, lang, compact = false }: { children: ReactNode; lang?: string; compact?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-border bg-bg/80" data-testid="code-block">
      <div className={`flex items-center justify-between border-b border-border/70 text-[10.5px] text-content-faint ${compact ? "px-2.5 py-0.5" : "px-3 py-1"}`}>
        <span className="truncate font-mono" data-testid="code-lang">{lang || "text"}</span>
        <button
          onClick={() =>
            navigator.clipboard?.writeText(textOf(children)).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-3 hover:text-content-dim"
          data-testid="code-copy"
        >
          <Icon name={copied ? "check" : "copy"} size={11} /> {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <pre className={`!m-0 overflow-x-auto !rounded-none !border-0 !bg-transparent leading-relaxed ${compact ? "p-2.5 text-[11.5px]" : "p-3 text-[12px]"}`}>
        {children}
      </pre>
    </div>
  );
}
