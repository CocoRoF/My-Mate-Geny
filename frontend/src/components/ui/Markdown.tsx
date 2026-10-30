import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import "highlight.js/styles/github-dark.css";
import { fileUrl } from "../../api/sessions";
import { useSessionStore } from "../../stores/sessionStore";
import Icon from "./Icon";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in (node as any)) return textOf((node as any).props.children);
  return "";
}

function CodeBlock({ children, lang }: { children: ReactNode; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-border bg-bg/80">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-1 text-[10.5px] text-content-faint">
        <span className="font-mono">{lang || "text"}</span>
        <button
          onClick={() =>
            navigator.clipboard?.writeText(textOf(children)).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-3 hover:text-content-dim"
        >
          <Icon name={copied ? "check" : "copy"} size={11} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="!m-0 overflow-x-auto !rounded-none !border-0 !bg-transparent p-3 text-[12px] leading-relaxed">{children}</pre>
    </div>
  );
}

// Renders assistant text as GitHub-flavored markdown with highlighted code.
// Styling lives in the `.md` block in index.css. Links open in a new tab.
export default function Markdown({ children }: { children: string }) {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId));

  // Images the agent references by workspace path render through the
  // session's (confined) file preview endpoint.
  const imgSrc = (src?: string) => {
    if (!src || !session || /^(https?:|data:|blob:|\/api\/)/.test(src)) return src;
    return fileUrl(session.id, src.replace(/^file:\/\//, ""));
  };

  return (
    <div className="md text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          a: ({ node, ...props }) => <a target="_blank" rel="noreferrer" {...props} />,
          pre: ({ children }) => {
            const child: any = Array.isArray(children) ? children[0] : children;
            const cls: string = child?.props?.className || "";
            const lang = /language-([\w+-]+)/.exec(cls)?.[1];
            return <CodeBlock lang={lang}>{children}</CodeBlock>;
          },
          img: ({ node, src, alt, ...props }) => (
            <img
              {...props}
              src={imgSrc(src as string)}
              alt={alt}
              loading="lazy"
              className="my-2 max-h-[420px] max-w-full rounded-lg border border-border"
            />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
