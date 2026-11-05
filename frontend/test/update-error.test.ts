// The desktop app's update errors in words (src/lib/updateError.ts): what was attempted and why, in the UI's language
// when the app says why with a code (desktop/src/updater.js); an older app's English text as it is.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import en from "../src/i18n/en/index.ts";
import ko from "../src/i18n/ko/index.ts";
import { updateErrorText } from "../src/lib/updateError.ts";

const tFor = (cat: any) => (key: string, vars: Record<string, unknown> = {}) => {
  const [ns, k] = key.split(".");
  const msg = cat[ns]?.[k];
  assert.equal(typeof msg, "string", `${key} exists`);
  return msg.replace(/\{(\w+)\}/g, (_: string, n: string) => String(vars[n] ?? ""));
};

test("a coded reason is worded in the UI's language, with what was attempted", () => {
  const s = { errorCode: "replaced" as const, error: "The server no longer has that build…", during: "download" as const };
  assert.equal(updateErrorText(tFor(en) as any, s), "The update could not be downloaded: The update file was replaced by a newer build. Check again.");
  assert.match(updateErrorText(tFor(ko) as any, s), /^업데이트를 다운로드하지 못했어요: 업데이트 파일이/);
  const i = updateErrorText(tFor(ko) as any, { errorCode: "unreachable", errorDetail: "net::ERR_CONNECTION_REFUSED", during: "check" });
  assert.equal(i, "업데이트를 확인하지 못했어요: 업데이트 소스에 연결할 수 없어요 (net::ERR_CONNECTION_REFUSED).");
});

test("install errors say 'installed'; an unknown code shows the app's own words", () => {
  assert.equal(updateErrorText(tFor(en) as any, { errorCode: "other", errorDetail: "EACCES: permission denied", during: "install" }), "The update could not be installed: EACCES: permission denied");
});

test("an older app (no code, English text only) is shown as before", () => {
  assert.equal(updateErrorText(tFor(en) as any, { error: "The server asked to sign in again.", during: "check" }), "The update could not be checked: The server asked to sign in again.");
});

test("every code the app sends has words in both languages", () => {
  for (const code of ["signIn", "replaced", "noUpdate", "server", "unreachable", "damaged", "cannotSelfUpdate", "sourceAccess", "sourceCredential", "sourceRateLimit", "sourceUnavailable", "sourceInvalid", "sourceChanged"] as const) {
    for (const cat of [en, ko]) {
      const text = updateErrorText(tFor(cat) as any, { errorCode: code, errorDetail: "x", during: "check" });
      assert.ok(text.length > 20, `${code}: ${text}`);
    }
  }
});
