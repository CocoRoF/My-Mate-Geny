#!/usr/bin/env node
// Lists user-visible English still hard-coded in the frontend (docs/i18n.md):
//   JSX text, string attributes people see (title, placeholder, aria-label, alt, label, hint, …), string literals
//   put straight into JSX ({"…"}, {a ? "…" : "…"}), and `label:` / `title:` / `hint:` … in object literals.
// Uses the TypeScript parser, so code like `a < b && c > d` is not mistaken for text.
//
//   node scripts/i18n-scan.mjs                 every file under src/ except the ones listed in PENDING
//   node scripts/i18n-scan.mjs src/components/layout/Sidebar.tsx …
//   --strict   exit 1 when anything is found (CI / npm run test:i18n)
//   --all      include the PENDING files too
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const strict = args.includes("--strict");
const all = args.includes("--all");
const given = args.filter((a) => !a.startsWith("--"));

// Not translated yet (reworked in parallel; a follow-up translates them) — see docs/i18n.md.
const PENDING = [
  "src/components/chat/ChatView.tsx",
  "src/components/chat/GitContext.tsx",
  "src/components/chat/panel/",
  "src/components/workspaces/",
];
// Never UI text: the message catalogs themselves, dev-only surfaces, type declarations.
const SKIP = ["src/i18n/", "src/vite-env.d.ts", "src/mate/AvatarLab.tsx"];

const ATTRS = new Set(["title", "placeholder", "aria-label", "alt", "label", "hint", "tooltip", "description", "message", "text", "emptyText", "confirmText", "sub", "heading", "subtitle", "caption", "aria-description"]);
const PROPS = new Set(["label", "title", "hint", "placeholder", "description", "message", "text", "tooltip", "sub", "heading", "subtitle", "caption", "empty", "emptyText", "help", "note", "summary"]);

const CALLS = /^(set(Error|Err|Msg|Message|Ok|Done|Notice|Status|Hint|Info|Warning|Toast)\w*|notify|alert|confirm|prompt|toast|Error|fail)$/;

// Words that stay as they are in every language (product / model names, units, code).
const KEEP = [
  /^My Mate Geny$/, /^My Mate$/, /^Geny$/, /^Claude( Code)?$/, /^Codex$/, /^Live2D$/, /^GitHub$/, /^Git$/, /^OpenAI$/, /^Anthropic$/,
  /^API$/, /^CLI$/, /^MCP$/, /^URL$/, /^ID$/, /^OK$/, /^JSON$/, /^PDF$/, /^CSV$/, /^HTTP(S)?$/, /^SSH$/, /^IP$/, /^PID$/,
  /^(KB|MB|GB|TB|ms|s|px|%)$/, /^v\d/, /^[A-Z]{2,5}$/,
];

const englishRe = /[A-Za-z]{2,}/;

function looksEnglish(raw) {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s || !englishRe.test(s)) return false;
  if (KEEP.some((r) => r.test(s))) return false;
  // code-ish: no spaces and punctuation typical of identifiers, paths, URLs, CSS, keys
  if (!/\s/.test(s) && /[./_:#@=\\[\]{}()<>$-]|^[a-z][a-zA-Z0-9]*$/.test(s)) return false;
  if (/^(https?:|mailto:|\/|\.\/|data:)/.test(s)) return false;
  // CSS class lists / tailwind
  if (/^[a-z0-9:[\]/.!%_-]+( [a-z0-9:[\]/.!%_-]+)+$/.test(s) && /[-:]/.test(s)) return false;
  return true;
}

function walkDir(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(p, out);
    else if (/\.(tsx|ts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(root, p).split(path.sep).join("/");
let files = given.length ? given.map((f) => path.resolve(root, f)) : walkDir(path.join(root, "src"));
files = files.filter((f) => !SKIP.some((s) => rel(f).startsWith(s)));
if (!all && !given.length) files = files.filter((f) => !PENDING.some((s) => rel(f).startsWith(s)));

const hits = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const report = (node, s, why) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    // an explicit opt-out on the line: // i18n-ignore
    const lineText = text.split("\n")[line] || "";
    if (/i18n-ignore/.test(lineText)) return;
    hits.push(`${rel(file)}:${line + 1}: [${why}] ${s.replace(/\s+/g, " ").trim().slice(0, 100)}`);
  };
  const strOf = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((x) => x.literal.text).join(" ") : null);
  // string literals that end up as JSX children: "…", a ? "…" : "…", a && "…", `…${x}…`
  const childStrings = (e, out = []) => {
    if (!e) return out;
    const s = strOf(e);
    if (s !== null) out.push([e, s]);
    else if (ts.isConditionalExpression(e)) childStrings(e.whenTrue, out), childStrings(e.whenFalse, out);
    else if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) childStrings(e.right, out), e.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken && childStrings(e.left, out);
    else if (ts.isParenthesizedExpression(e)) childStrings(e.expression, out);
    return out;
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      if (looksEnglish(node.text)) report(node, node.text, "text");
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (ATTRS.has(name) && node.initializer) {
        const init = node.initializer;
        const list = ts.isStringLiteral(init) ? [[init, init.text]] : ts.isJsxExpression(init) ? childStrings(init.expression) : [];
        for (const [n, s] of list) if (looksEnglish(s)) report(n, s, name);
      }
    } else if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const [n, s] of childStrings(node.expression)) if (looksEnglish(s)) report(n, s, "jsx");
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      // messages handed to the user: setError("…"), notify("…"), window.confirm("…"), new Error("…") …
      const callee = node.expression.getText(sf).split(".").pop() || "";
      if (CALLS.test(callee)) for (const a of node.arguments || []) for (const [n, s] of childStrings(a)) if (looksEnglish(s)) report(n, s, `${callee}()`);
    } else if (ts.isPropertyAssignment(node) && PROPS.has(node.name.getText(sf).replace(/["']/g, ""))) {
      for (const [n, s] of childStrings(node.initializer)) if (looksEnglish(s)) report(n, s, `prop ${node.name.getText(sf)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

for (const h of hits) console.log(h);
console.error(`${hits.length} hard-coded English string(s) in ${files.length} file(s)`);
if (strict && hits.length) process.exit(1);
