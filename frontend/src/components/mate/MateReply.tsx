/**
 * A mate's reply as bubbles (docs/mate.md §3 "Replies"): mate/markdown.ts segmentReply cuts it into blocks — one bubble
 * per conversational line (inline markdown: bold, italic, code, links), one per block construct (code with its
 * language and a copy button, lists, tables, quotes, headings, images) rendered as markdown. Keys follow the block's
 * first line, so bubbles never remount while the reply streams in. Links open outside (a new tab; the desktop app
 * hands target=_blank to the system browser); images from elsewhere load only when asked.
 */
import { memo, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { segmentReply, imageSource, type MateBlock } from "../../mate/markdown";
import CodeBlock from "../ui/CodeBlock";
import { rehypeCodeHighlight } from "../ui/codeHighlight";
import Icon from "../ui/Icon";
import { useT } from "../../i18n";
import { BLOCK_ELEMENTS, INLINE_ELEMENTS, mateUrlTransform, REMARK_PLUGINS } from "./mateMarkdown";

const REHYPE_PLUGINS = [rehypeCodeHighlight];

function MateImage({ src, alt }: { src?: string; alt?: string }) {
  const t = useT();
  const img = src ? imageSource(src, window.location.origin) : null;
  const [show, setShow] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = alt?.trim() || t("mate.mdImage");
  if (!img || failed) {
    return (
      <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface/60 px-1.5 py-0.5 align-middle text-[0.85em] text-content-dim" data-testid="mate-md-image-alt" title={failed ? t("mate.mdImageFailed") : undefined}>
        <Icon name="image" size={11} className="shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    );
  }
  if (img.ask && !show) {
    return (
      <button
        type="button"
        onClick={() => setShow(true)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface/60 px-2 py-1 align-middle text-[0.85em] text-content-dim transition hover:border-border-strong hover:text-content"
        title={t("mate.mdImageFrom", { host: img.host })}
        data-testid="mate-md-image-hidden"
      >
        <Icon name="image" size={12} className="shrink-0" />
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-content-faint">· {t("mate.mdShowImage")}</span>
      </button>
    );
  }
  return (
    <img
      src={img.src}
      alt={label}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="my-1 block max-h-72 max-w-full rounded-lg border border-border object-contain"
      data-testid="mate-md-image"
    />
  );
}

const COMPONENTS = (compact: boolean): Components => ({
  a: ({ node: _n, href, children, title: _t, ...props }) =>
    href ? (
      <a {...props} href={href} title={href} target="_blank" rel="noopener noreferrer" className="mate-md-link">
        {children}
      </a>
    ) : (
      // an unsafe / unusable link: its label, no link
      <span data-testid="mate-md-unlinked">{children}</span>
    ),
  img: ({ src, alt }) => <MateImage src={src} alt={alt} />,
  pre: ({ children }) => {
    const child: any = Array.isArray(children) ? children[0] : children;
    const cls: string = child?.props?.className || "";
    const lang = /language-([\w+#.-]+)/.exec(cls)?.[1];
    return (
      <CodeBlock lang={lang} compact={compact}>
        {children}
      </CodeBlock>
    );
  },
  table: ({ node: _n, ...props }) => (
    <div className="mate-md-table" data-testid="mate-md-table">
      <table {...props} />
    </div>
  ),
  input: ({ node: _n, type, checked }) =>
    type === "checkbox" ? <input type="checkbox" checked={!!checked} readOnly disabled className="mate-md-check" /> : null,
});
const FULL = COMPONENTS(false);
const COMPACT = COMPONENTS(true);

function Markdown({ md, inline, compact }: { md: string; inline: boolean; compact: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={inline ? undefined : REHYPE_PLUGINS}
      urlTransform={(url, key) => mateUrlTransform(url, key)}
      allowedElements={inline ? INLINE_ELEMENTS : BLOCK_ELEMENTS}
      unwrapDisallowed
      components={compact ? COMPACT : FULL}
    >
      {md}
    </ReactMarkdown>
  );
}

const shell = (compact: boolean, wide: boolean) =>
  `md mate-md ${compact ? "mate-md-compact" : ""} min-w-0 max-w-[88%] ${wide ? "w-full" : "w-fit"} rounded-2xl rounded-bl-md border border-border/80 bg-surface-2 text-content shadow-bubble ${
    compact ? "px-3 py-[7px] text-[13px] leading-[1.55]" : "px-3.5 py-2 text-sm leading-relaxed"
  }`;

/** one block: a bubble (or, `bare`, the block without the bubble's chrome — the quick card's reply box) */
export const ReplyBlock = memo(
  function ReplyBlock({ block, compact = false, bare = false }: { block: MateBlock; compact?: boolean; bare?: boolean }) {
    if (block.kind === "rule") return <div className={`w-[88%] border-t border-border/70 ${compact ? "my-0.5" : "my-1"}`} data-testid="mate-md-rule" role="separator" />;
    const inline = block.kind === "text";
    // code and tables take the bubble's full width (they scroll sideways inside it, the page never widens)
    const wide = block.type === "code" || block.type === "table";
    const body: ReactNode = <Markdown md={block.md} inline={inline} compact={compact} />;
    return (
      <div
        className={bare ? `md mate-md ${compact ? "mate-md-compact" : ""} min-w-0 max-w-full` : shell(compact, wide)}
        data-testid="mate-bubble"
        data-block={block.type ?? block.kind}
        data-open={block.open ? "true" : undefined}
      >
        {body}
      </div>
    );
  },
  (a, b) =>
    a.compact === b.compact && a.bare === b.bare && a.block.md === b.block.md && a.block.kind === b.block.kind && a.block.type === b.block.type && a.block.open === b.block.open,
);

/** a reply's text as blocks */
export default function MateReply({
  text,
  streaming = false,
  compact = false,
  bare = false,
  keyPrefix = "",
}: {
  text: string;
  streaming?: boolean;
  compact?: boolean;
  bare?: boolean;
  keyPrefix?: string;
}) {
  const blocks = useMemo(() => segmentReply(text, { streaming }), [text, streaming]);
  return (
    <>
      {blocks.map((b) => (
        <ReplyBlock key={keyPrefix + b.key} block={b} compact={compact} bare={bare} />
      ))}
    </>
  );
}
