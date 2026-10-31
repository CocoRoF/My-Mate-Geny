// highlight.js core + the languages a workspace actually holds. Lives in the
// lazily loaded viewer chunk, so the chat bundle doesn't grow.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cmake from "highlight.js/lib/languages/cmake";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import dos from "highlight.js/lib/languages/dos";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import groovy from "highlight.js/lib/languages/groovy";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import latex from "highlight.js/lib/languages/latex";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import objectivec from "highlight.js/lib/languages/objectivec";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { escapeHtml, HIGHLIGHT_LIMIT, splitHighlightedLines } from "../../lib/fileView";

const LANGS = {
  bash, c, cmake, cpp, csharp, css, dart, diff, dockerfile, dos, go, graphql, groovy, ini, java, javascript,
  json, kotlin, latex, less, lua, makefile, markdown, objectivec, perl, php, plaintext, powershell, protobuf,
  python, r, ruby, rust, scala, scss, sql, swift, typescript, xml, yaml,
};
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);

/** One HTML string per line (spans closed/reopened at line breaks). Plain past the limit. */
export function highlightLines(code: string, lang: string): string[] {
  if (code.length <= HIGHLIGHT_LIMIT && lang !== "plaintext" && hljs.getLanguage(lang)) {
    try {
      return splitHighlightedLines(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value);
    } catch {
      /* fall through to plain */
    }
  }
  return code.split("\n").map(escapeHtml);
}
