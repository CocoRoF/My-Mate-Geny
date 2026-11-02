// Light / dark (src/lib/themeCore.ts): how a mode resolves, where it is kept, what the account's choice does here,
// and that index.html's pre-paint script and index.css agree with it.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  accountMode,
  barStyle,
  hasStoredMode,
  isThemeMode,
  modeFromStorageEvent,
  readDeviceOnly,
  readMode,
  resolveTheme,
  THEME_BG,
  THEME_DEVICE_KEY,
  THEME_KEY,
  themeCookie,
  writeDeviceOnly,
  writeMode,
} from "../src/lib/themeCore.ts";

function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

test("a mode resolves to what is drawn; system follows the OS", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.ok(isThemeMode("system") && isThemeMode("light") && isThemeMode("dark"));
  assert.ok(!isThemeMode("auto") && !isThemeMode(null) && !isThemeMode(""));
});

test("the saved mode: system until one is picked; junk and blocked storage read as system", () => {
  const s = memory();
  assert.equal(readMode(s), "system");
  assert.equal(hasStoredMode(s), false);
  writeMode(s, "light");
  assert.equal(s.map.get(THEME_KEY), "light");
  assert.equal(readMode(s), "light");
  assert.equal(hasStoredMode(s), true);
  assert.equal(readMode(memory({ [THEME_KEY]: "purple" })), "system");
  const blocked = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } };
  assert.equal(readMode(blocked), "system");
  assert.doesNotThrow(() => writeMode(blocked, "dark"));
  assert.equal(readMode(null), "system");
});

test("this device only: stored here, cleared when off", () => {
  const s = memory();
  assert.equal(readDeviceOnly(s), false);
  writeDeviceOnly(s, true);
  assert.equal(s.map.get(THEME_DEVICE_KEY), "1");
  assert.equal(readDeviceOnly(s), true);
  writeDeviceOnly(s, false);
  assert.equal(s.map.has(THEME_DEVICE_KEY), false);
});

test("the account's choice is followed unless this device keeps its own", () => {
  assert.equal(accountMode("light", "dark", false), "light");
  assert.equal(accountMode("system", "dark", false), "system");
  assert.equal(accountMode("light", "light", false), null); // already
  assert.equal(accountMode("light", "dark", true), null); // this device only
  assert.equal(accountMode(null, "dark", false), null); // the account never chose
  assert.equal(accountMode(undefined, "dark", false), null); // an older server
  assert.equal(accountMode("sepia", "dark", false), null);
});

test("another window's change is followed; other keys are not", () => {
  assert.equal(modeFromStorageEvent(THEME_KEY, "light", "dark"), "light");
  assert.equal(modeFromStorageEvent(THEME_KEY, "light", "light"), null);
  assert.equal(modeFromStorageEvent(THEME_KEY, null, "dark"), "system"); // removed
  assert.equal(modeFromStorageEvent("hrh_lang", "ko", "dark"), null);
  assert.equal(modeFromStorageEvent(null, null, "light"), "system"); // storage cleared
  assert.equal(modeFromStorageEvent(null, null, "system"), null);
});

test("cookie for the login page; Android bar styles; page colours match index.css", () => {
  assert.match(themeCookie("dark"), /^hrh_theme=dark; path=\/; max-age=31536000; SameSite=Lax$/);
  assert.equal(barStyle("dark"), "DARK");
  assert.equal(barStyle("light"), "LIGHT");
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");
  assert.ok(css.includes(`--c-bg: ${rgb(THEME_BG.dark)};`), "dark --c-bg");
  assert.ok(css.includes("html.light,\n.theme-light {") && css.includes(`--c-bg: ${rgb(THEME_BG.light)};`), "light --c-bg");
});

test("index.html draws the saved theme before the app loads, by the same rules", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf('localStorage.getItem("hrh_theme")');
  assert.ok(start > 0, "reads hrh_theme");
  assert.ok(start < html.indexOf("<style>"), "before any style is drawn");
  assert.ok(start < html.indexOf('src="/src/main.tsx"'));
  // run it against a fake document for each case
  const script = html.slice(html.lastIndexOf("<script>", start) + 8, html.indexOf("</script>", start));
  const run = (stored: string | null, prefersLight: boolean) => {
    const classes = new Set(["dark"]);
    const attrs: Record<string, string> = {};
    let meta = "";
    const document = {
      documentElement: {
        classList: { remove: (...c: string[]) => c.forEach((x) => classes.delete(x)), add: (c: string) => classes.add(c) },
        setAttribute: (k: string, v: string) => (attrs[k] = v),
        style: {} as Record<string, string>,
      },
      querySelector: () => ({ setAttribute: (_k: string, v: string) => (meta = v) }),
    };
    const window = { matchMedia: (q: string) => ({ matches: q.includes("light") ? prefersLight : !prefersLight }) };
    const localStorage = { getItem: () => stored };
    new Function("document", "window", "localStorage", script)(document, window, localStorage);
    return { classes: [...classes].join(" "), theme: attrs["data-theme"], mode: attrs["data-theme-mode"], meta };
  };
  for (const [stored, light, want] of [
    [null, true, "light"], [null, false, "dark"], ["system", true, "light"], ["light", false, "light"], ["dark", true, "dark"], ["junk", true, "light"],
  ] as const) {
    const r = run(stored, light);
    assert.equal(r.classes, want, `${stored} / prefers light ${light}`);
    assert.equal(r.theme, want);
    assert.equal(r.meta, THEME_BG[want]);
    assert.equal(r.mode, stored === "light" || stored === "dark" ? stored : "system");
  }
});
