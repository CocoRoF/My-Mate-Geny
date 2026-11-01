/**
 * How a mate bubble's markdown is parsed (MateReply.tsx renders it; test/mate-markdown.test.ts renders the same
 * options with react-dom/server): GFM without strikethrough, safe URLs only, a fixed set of elements. No raw HTML —
 * react-markdown turns it into text without rehype-raw, so `<script>` shows as the characters it is.
 */
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import { imageSource, safeHref } from "../../mate/markdown.ts";

/**
 * `~~` stays as written: Korean chat writes "좋아~~진짜~~", which GFM would strike through (and a single ~ too —
 * remark-gfm's singleTilde is off as well).
 */
export function remarkNoStrikethrough() {
  return (tree: any) => {
    visit(tree, "delete", (node: any, index: number | undefined, parent: any) => {
      if (!parent || index === undefined) return;
      parent.children.splice(index, 1, { type: "text", value: "~~" }, ...node.children, { type: "text", value: "~~" });
      return index;
    });
  };
}

export const REMARK_PLUGINS: any[] = [[remarkGfm, { singleTilde: false }], remarkNoStrikethrough];

/** what a conversational line may contain */
export const INLINE_ELEMENTS = ["p", "strong", "em", "code", "a", "img", "br", "span"];
/** what a block bubble may contain (no footnote sections, no raw HTML anyway) */
export const BLOCK_ELEMENTS = [
  ...INLINE_ELEMENTS,
  "pre", "ul", "ol", "li", "input", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "table", "thead", "tbody", "tr", "th", "td",
];

/** links: absolute http(s) / mailto only ("" = no link: the label shows as text); images: this server or http(s) */
export function mateUrlTransform(url: string, key: string, origin = typeof location !== "undefined" ? location.origin : "http://localhost"): string {
  if (key === "href") return safeHref(url) ?? "";
  if (key === "src") return imageSource(url, origin)?.src ?? "";
  return "";
}
