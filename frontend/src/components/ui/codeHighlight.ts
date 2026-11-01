/**
 * Syntax highlighting for markdown code blocks (the agent chat's Markdown and the mate's bubbles): lowlight with only
 * the languages an agent console actually shows (rehype-highlight would bundle its ~37-language default set).
 */
import type { ReactNode } from "react";
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

/** the text of rendered children (a code block's copy button) */
export function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in (node as any)) return textOf((node as any).props.children);
  return "";
}

const LANGUAGES = {
  bash, c, cpp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin,
  markdown, python, rust, shell, sql, typescript, xml, yaml,
};
const ALIASES = { bash: ["sh", "zsh", "console"], javascript: ["js", "jsx"], typescript: ["ts", "tsx"],
  python: ["py"], xml: ["html", "svg"], yaml: ["yml"], ini: ["toml", "env"], dockerfile: ["docker"] };

const lowlight = createLowlight(LANGUAGES);
lowlight.registerAlias(ALIASES);

/** Highlight ```lang blocks with only the registered languages. Unknown languages stay plain.
 * Inline code is marked (`data-inline`) so a path in it can become a link. */
export function rehypeCodeHighlight() {
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
