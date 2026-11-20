// The frontend checks a change needs — what to run locally before a PR (CI runs them all on the PR).
//
//   cd frontend && node scripts/affected-tests.mjs          # changes since origin/main, committed or not
//
// Prints the commands, one per line: `npx tsc -p . --noEmit` when TypeScript changed; the unit tests (test/*.test.ts)
// that are changed or import a changed module of src/ (directly or through one module that does); `npm run test:i18n`
// when messages or components changed (every string in both languages, none hard-coded). Nothing changed: nothing.
// `--base <ref>` compares with another ref; file arguments (relative to frontend/) stand in for git's list.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FRONTEND = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const bi = args.indexOf("--base");
const base = bi >= 0 ? args.splice(bi, 2)[1] : "origin/main";

function changed() {
  const git = (...a) => execFileSync("git", a, { cwd: FRONTEND, encoding: "utf8" }).split("\n").filter(Boolean);
  const top = git("rev-parse", "--show-toplevel")[0];
  const names = new Set([...git("diff", "--name-only", `${base}...HEAD`), ...git("diff", "--name-only", "HEAD")]);
  for (const p of git("ls-files", "--others", "--exclude-standard")) names.add(path.relative(top, path.join(FRONTEND, p)));
  const prefix = path.relative(top, FRONTEND) + "/";
  return [...names].filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length));
}

const files = args.length ? args : changed();
if (!files.length) process.exit(0);
const src = files.filter((f) => /^src\/.*\.(ts|tsx)$/.test(f));
const out = [];
if (src.length || files.some((f) => /^test\/.*\.ts$|^tsconfig/.test(f))) out.push("npx tsc -p . --noEmit");

// src module → the src modules importing it (relative imports, resolved without extension as Vite does)
const resolve = (from, spec) => {
  const p = path.join(path.dirname(from), spec);
  for (const c of [p, `${p}.ts`, `${p}.tsx`, path.join(p, "index.ts"), path.join(p, "index.tsx")])
    if (fs.existsSync(path.join(FRONTEND, c)) && fs.statSync(path.join(FRONTEND, c)).isFile()) return c;
  return null;
};
const importsOf = (rel) => {
  const text = fs.readFileSync(path.join(FRONTEND, rel), "utf8");
  return [...text.matchAll(/(?:import|export)[^'"]*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)]
    .map((m) => resolve(rel, m[1] || m[2]))
    .filter(Boolean);
};
const walk = (dir) =>
  fs.readdirSync(path.join(FRONTEND, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : [],
  );
const usedBy = new Map();
for (const f of walk("src")) for (const d of importsOf(f)) usedBy.set(d, [...(usedBy.get(d) || []), f]);
const near = new Set(src);
for (const f of src) for (const u of usedBy.get(f) || []) if ((usedBy.get(u) || []).length <= 12) near.add(u); // (not a hub)
const tests = fs.readdirSync(path.join(FRONTEND, "test")).filter((n) => n.endsWith(".test.ts")).map((n) => `test/${n}`);
// (test/i18n.test.ts is test:i18n's, below)
const picked = tests.filter((t) => t !== "test/i18n.test.ts" && (files.includes(t) || importsOf(t).some((d) => near.has(d))));
if (picked.length) out.push(`node --import ./test/ts-resolve.mjs --test ${picked.join(" ")}`);
if (files.some((f) => /^src\/i18n\/|\.tsx$|^scripts\/i18n-scan/.test(f))) out.push("npm run -s test:i18n");
if (out.length) console.log(out.join("\n"));
