#!/usr/bin/env node
// WCAG contrast of the theme's main token pairs, both themes (src/index.css is the source: `--c-<name>: r g b;`
// in the dark block `:root { … }` and the light block `html.light { … }`). Prints a table; with --strict it exits 1
// when a pair under its floor fails (dark-only failures that predate the light theme are listed, not failed: dark
// mode keeps its look).
//   node scripts/theme-contrast.mjs [--strict] [--markdown]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "src", "index.css"), "utf8");

function block(marker) {
  const at = css.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker} block in index.css`);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed ${marker}`);
}
function vars(text) {
  const out = {};
  for (const m of text.matchAll(/--c-([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) out[m[1]] = [+m[2], +m[3], +m[4]];
  for (const m of text.matchAll(/--hl-([\w-]+):\s*#([0-9a-fA-F]{6})\s*;/g)) out[`hl-${m[1]}`] = hex(m[2]);
  for (const m of text.matchAll(/--accent-soft-a:\s*([\d.]+)\s*;/g)) out["accent-soft-a"] = +m[1];
  return out;
}
const hex = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));

const THEMES = {
  dark: vars(block("/* theme: dark */")),
  light: { ...vars(block("/* theme: dark */")), ...vars(block("/* theme: light */")) },
};

const lin = (c) => {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** `fg` at `alpha` over `bg` */
const over = (fg, alpha, bg) => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));

// [label, fg, bg, floor] — fg/bg: token names, "white", or [token, alpha, baseToken] for a tint
const WHITE = [255, 255, 255];
const PAIRS = [];
for (const fg of ["content", "content-dim", "content-faint"]) {
  for (const bg of ["bg", "surface", "surface-2", "surface-3"]) PAIRS.push([`${fg} on ${bg}`, fg, bg, 4.5]);
}
for (const bg of ["surface", "surface-2", "surface-3"]) PAIRS.push([`accent (link/text) on ${bg}`, "accent", bg, 4.5]);
PAIRS.push(["accent text on accent-soft (over surface-2)", "accent", ["accent", "soft", "surface-2"], 4.5]);
PAIRS.push(["content on accent-soft (selected row)", "content", ["accent", "soft", "surface-2"], 4.5]);
PAIRS.push(["white on accent (solid button)", "white", "accent", 4.5]);
PAIRS.push(["white on accent-grad end (send button)", "white", "accent-grad-to", 4.5]);
PAIRS.push(["white on accent-grad start (send button)", "white", "accent-grad-from", 4.5]);
for (const s of ["success", "warning", "danger", "violet", "cyan"]) {
  PAIRS.push([`${s} text on surface-2`, s, "surface-2", 4.5]);
  PAIRS.push([`${s} text on ${s}/15 badge`, s, [s, 0.15, "surface-2"], 4.5]);
}
PAIRS.push(["white on danger (solid)", "white", "danger", 4.5]);
PAIRS.push(["white on success (solid)", "white", "success", 3]);
for (const st of ["new", "familiar", "trusted", "companion"]) {
  PAIRS.push([`stage ${st} text on surface-2`, `stage-${st}`, "surface-2", 4.5]);
  PAIRS.push([`stage-ink on the ${st} pill`, "stage-ink", `stage-${st}`, 4.5]);
}
PAIRS.push(["file-blue icon on surface", "file-blue", "surface", 3]);
PAIRS.push(["file-orange icon on surface", "file-orange", "surface", 3]);
PAIRS.push(["border-strong vs surface-2 (UI edge)", "border-strong", "surface-2", 1.5]);
PAIRS.push(["accent focus ring vs surface-2", "accent", "surface-2", 3]);
PAIRS.push(["content-faint icon vs surface-3 (UI)", "content-faint", "surface-3", 3]);
for (const k of ["text", "keyword", "entity", "constant", "string", "variable", "comment", "tag", "heading", "bullet"]) {
  PAIRS.push([`code ${k} on code-bg`, `hl-${k}`, "code-bg", 4.5]);
}
PAIRS.push(["code addition on its bg", "hl-addition", "hl-addition-bg", 4.5]);
PAIRS.push(["code deletion on its bg", "hl-deletion", "hl-deletion-bg", 4.5]);

function color(t, spec) {
  if (spec === "white") return WHITE;
  if (Array.isArray(spec) && typeof spec[1] !== "number" && spec[1] !== "soft") return spec;
  if (Array.isArray(spec)) {
    const a = spec[1] === "soft" ? t["accent-soft-a"] : spec[1];
    return over(t[spec[0]], a, t[spec[2]]);
  }
  const c = t[spec];
  if (!c) throw new Error(`no token ${spec}`);
  return c;
}

const strict = process.argv.includes("--strict");
const md = process.argv.includes("--markdown");
const rows = [];
let failures = 0;
for (const [label, fg, bg, floor] of PAIRS) {
  const r = {};
  for (const name of ["dark", "light"]) r[name] = ratio(color(THEMES[name], fg), color(THEMES[name], bg));
  const lightFail = r.light < floor;
  if (lightFail) failures++;
  rows.push([label, floor, r.dark, r.light]);
}
const mark = (v, floor) => `${v.toFixed(2)}${v < floor ? " ✗" : ""}`;
if (md) {
  console.log("| pair | floor | dark | light |\n|---|---|---|---|");
  for (const [l, f, d, li] of rows) console.log(`| ${l} | ${f} | ${mark(d, f)} | ${mark(li, f)} |`);
} else {
  const w = Math.max(...rows.map((r) => r[0].length));
  console.log(`${"pair".padEnd(w)}  floor   dark     light`);
  for (const [l, f, d, li] of rows) console.log(`${l.padEnd(w)}  ${String(f).padEnd(5)}  ${mark(d, f).padEnd(7)}  ${mark(li, f)}`);
}
console.log(`\nlight-theme pairs under their floor: ${failures}`);
if (strict && failures) process.exit(1);
