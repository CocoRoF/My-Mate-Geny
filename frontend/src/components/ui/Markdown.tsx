import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { visit } from "unist-util-visit";
import remarkGfm from "remark-gfm";
import { fileUrl } from "../../api/sessions";
import { fsRawUrl } from "../../api/fs";
import { unqualify } from "../../lib/hosts";
import { BARE_PATH, isBarePathCandidate, looksLikePath, parsePathRef, resolvePath } from "../../lib/paths";
import { useSessionStore } from "../../stores/sessionStore";
import { openPath } from "../../stores/workbenchStore";
import CodeBlock from "./CodeBlock";
import { rehypeCodeHighlight, textOf } from "./codeHighlight";
import { useT } from "../../i18n";

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
    if (baseDir) {
      const b = unqualify(session, baseDir); // (a file on another host: its own host)
      return fsRawUrl(resolvePath(decodeURI(p), b.path), b.conn);
    }
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
