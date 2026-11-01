import { useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { createLowlight } from "lowlight";
import { toText } from "hast-util-to-text";
import { visit } from "unist-util-visit";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import remarkGfm from "remark-gfm";
import "highlight.js/styles/github-dark.css";
import { fileUrl } from "../../api/sessions";
import { fsRawUrl } from "../../api/fs";
import { BARE_PATH, isBarePathCandidate, looksLikePath, parsePathRef, resolvePath } from "../../lib/paths";
import { useSessionStore } from "../../stores/sessionStore";
import { openPath } from "../../stores/workbenchStore";
import Icon from "./Icon";
import { useT } from "../../i18n";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in (node as any)) return textOf((node as any).props.children);
  return "";
}

function CodeBlock({ children, lang }: { children: ReactNode; lang?: string }) {
  const t = useT();
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
          <Icon name={copied ? "check" : "copy"} size={11} /> {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <pre className="!m-0 overflow-x-auto !rounded-none !border-0 !bg-transparent p-3 text-[12px] leading-relaxed">{children}</pre>
    </div>
  );
}

// The languages an agent console actually shows (the default set is ~3x larger).
const LANGUAGES = {
  bash, c, cpp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin,
  markdown, python, rust, shell, sql, typescript, xml, yaml,
};
const ALIASES = { bash: ["sh", "zsh", "console"], javascript: ["js", "jsx"], typescript: ["ts", "tsx"],
  python: ["py"], xml: ["html", "svg"], yaml: ["yml"], ini: ["toml", "env"], dockerfile: ["docker"] };

const lowlight = createLowlight(LANGUAGES);
lowlight.registerAlias(ALIASES);

/** Highlight ```lang blocks with only the registered languages (rehype-highlight
 * would bundle its ~37-language default set on top). Unknown languages stay plain.
 * Inline code is marked so a path in it can become a link. */
function rehypeCodeHighlight() {
  return (tree: any) => {
    visit(tree, "element", (node: any, _i: number | undefined, parent: any) => {
      if (node.tagName !== "code") return;
      if (parent?.tagName !== "pre") {
        node.properties = { ...node.properties, dataInline: "1" };
        return;
      }
      const cls: string[] = node.properties?.className || [];
      const lang = cls.find((c) => String(c).startsWith("language-"))?.slice(9);
      if (!lang || !lowlight.registered(lang)) return;
      try {
        const result = lowlight.highlight(lang, toText(node, { whitespace: "pre" }));
        node.children = result.children;
        node.properties.className = [...cls, "hljs"];
      } catch {
        /* leave the block unhighlighted */
      }
    });
  };
}

/** Bare absolute paths in prose (`/home/x/y`, `~/proj`) become links. */
function remarkBarePaths() {
  return (tree: any) => {
    visit(tree, "text", (node: any, index: number | undefined, parent: any) => {
      if (index === undefined || !parent || parent.type === "link" || parent.type === "linkReference") return;
      const value: string = node.value;
      if (!value.includes("/")) return;
      const out: any[] = [];
      let last = 0;
      for (const m of value.matchAll(BARE_PATH)) {
        const path = m[2];
        if (!isBarePathCandidate(path)) continue;
        const start = (m.index ?? 0) + m[1].length;
        if (start > last) out.push({ type: "text", value: value.slice(last, start) });
        out.push({ type: "link", url: path, data: { hProperties: { dataPath: "1" } }, children: [{ type: "text", value: path }] });
        last = start + path.length;
      }
      if (!out.length) return;
      if (last < value.length) out.push({ type: "text", value: value.slice(last) });
      parent.children.splice(index, 1, ...out);
      return index + out.length;
    });
  };
}

const EXTERNAL = /^(https?:|mailto:|tel:|data:|blob:|#)/i;
const keepFileUrls = (url: string) => (url.startsWith("file:") ? url : defaultUrlTransform(url));

/**
 * Renders assistant text (or a markdown file) as GitHub-flavored markdown with
 * highlighted code. Styling lives in the `.md` block in index.css. Web links
 * open in a new tab; paths — links, `inline code`, bare absolute paths — open
 * in the workbench (file tab / explorer). `baseDir` = rendering a file: its
 * relative links and images resolve against its own folder.
 */
export default function Markdown({ children, baseDir, doc = false }: { children: string; baseDir?: string; doc?: boolean }) {
  const t = useT();
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId));

  // Images the agent references by workspace path render through the
  // session's (confined) file preview endpoint; a markdown file's own images
  // through the explorer's reader, relative to the file.
  const imgSrc = (src?: string) => {
    if (!src || !session || /^(https?:|data:|blob:|\/api\/)/.test(src)) return src;
    const p = src.replace(/^file:\/\//, "");
    if (baseDir) return fsRawUrl(resolvePath(decodeURI(p), baseDir), session.connection_id);
    return fileUrl(session.id, p);
  };
  const open = (raw: string) => session && openPath(session, raw, { base: baseDir });

  return (
    <div className={`md ${doc ? "md-doc" : "text-sm"} leading-relaxed`}>
      <ReactMarkdown
        remarkPlugins={baseDir ? [remarkGfm] : [remarkGfm, remarkBarePaths]}
        rehypePlugins={[rehypeCodeHighlight]}
        urlTransform={keepFileUrls}
        components={{
          a: ({ node, href, ...props }) => {
            if (!href || EXTERNAL.test(href) || !session) return <a target="_blank" rel="noreferrer" href={href} {...props} />;
            return (
              <a
                {...props}
                href={href}
                className="md-path"
                title={t("files.openName", { name: parsePathRef(href).path })}
                onClick={(e) => {
                  e.preventDefault();
                  open(href);
                }}
              />
            );
          },
          code: ({ node, className, children, ...props }) => {
            const inline = (node as any)?.properties?.dataInline;
            const text = typeof children === "string" ? children : textOf(children);
            if (inline && session && looksLikePath(text)) {
              return (
                <code
                  {...props}
                  role="link"
                  tabIndex={0}
                  className="md-path"
                  title={t("files.openName", { name: parsePathRef(text).path })}
                  onClick={() => open(text)}
                  onKeyDown={(e) => e.key === "Enter" && open(text)}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
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
