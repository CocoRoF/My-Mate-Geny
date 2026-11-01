// The message catalogs (docs/i18n.md): ko has exactly en's keys, the same {placeholders} and <tags>, no empty
// message, and every key is used somewhere in src/.   Run: npm run test:i18n   (node --test, Node ≥ 22.18)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import en from "../src/i18n/en/index.ts";
import ko from "../src/i18n/ko/index.ts";

type Msg = string | { one: string; other: string };
type Cat = Record<string, Record<string, Msg>>;
const EN = en as unknown as Cat;
const KO = ko as unknown as Cat;

const forms = (m: Msg): string[] => (typeof m === "string" ? [m] : [m.one, m.other]);
const tokens = (m: Msg, re: RegExp) => new Set(forms(m).flatMap((s) => [...s.matchAll(re)].map((x) => x[1])));
const PLACE = /\{(\w+)\}/g;
const TAG = /<(\w+)>/g;

test("ko has the same namespaces and keys as en", () => {
  assert.deepEqual(Object.keys(KO).sort(), Object.keys(EN).sort());
  for (const ns of Object.keys(EN)) {
    const missing = Object.keys(EN[ns]).filter((k) => !(k in KO[ns]));
    const extra = Object.keys(KO[ns]).filter((k) => !(k in EN[ns]));
    assert.deepEqual(missing, [], `ko/${ns}.ts misses keys`);
    assert.deepEqual(extra, [], `ko/${ns}.ts has keys en doesn't`);
  }
});

test("every message is non-empty and plurals have both forms", () => {
  for (const [lang, cat] of [["en", EN], ["ko", KO]] as const) {
    for (const [ns, msgs] of Object.entries(cat)) {
      for (const [k, m] of Object.entries(msgs)) {
        if (typeof m === "string") assert.ok(m.trim() !== "", `${lang}: ${ns}.${k} is empty`);
        else {
          assert.equal(typeof m.one, "string", `${lang}: ${ns}.${k}.one`);
          assert.equal(typeof m.other, "string", `${lang}: ${ns}.${k}.other`);
          assert.ok(m.one.trim() && m.other.trim(), `${lang}: ${ns}.${k} has an empty plural form`);
        }
      }
    }
  }
});

test("ko uses the same {placeholders} and <tags> as en", () => {
  const bad: string[] = [];
  for (const ns of Object.keys(EN)) {
    for (const k of Object.keys(EN[ns])) {
      const e = EN[ns][k];
      const o = KO[ns][k];
      if (o === undefined) continue;
      for (const [re, what] of [[PLACE, "placeholders"], [TAG, "tags"]] as const) {
        const a = [...tokens(e, re)].sort().join(",");
        const b = [...tokens(o, re)].sort().join(",");
        if (a !== b) bad.push(`${ns}.${k}: ${what} en [${a}] ≠ ko [${b}]`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("every key is used in src/", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (p === path.join(root, "i18n", "en") || p === path.join(root, "i18n", "ko")) continue;
        walk(p);
      } else if (/\.(tsx?|mjs)$/.test(e.name)) files.push(p);
    }
  };
  walk(root);
  const src = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const literal = new Set([...src.matchAll(/["'`]([a-zA-Z]+\.[A-Za-z0-9_]+)["'`]/g)].map((m) => m[1]));
  // keys put together at run time: `ns.prefix${x}` / "ns.prefix" + x
  const prefixes = [
    ...[...src.matchAll(/`([a-zA-Z]+\.[A-Za-z0-9_]*)\$\{/g)].map((m) => m[1]),
    ...[...src.matchAll(/["']([a-zA-Z]+\.[A-Za-z0-9_]*)["']\s*\+/g)].map((m) => m[1]),
  ];
  const unused: string[] = [];
  for (const ns of Object.keys(EN)) {
    for (const k of Object.keys(EN[ns])) {
      const key = `${ns}.${k}`;
      if (literal.has(key) || prefixes.some((p) => key.startsWith(p))) continue;
      unused.push(key);
    }
  }
  assert.deepEqual(unused, [], "keys no code uses (delete them, or use them)");
});
