#!/usr/bin/env python3
"""App Store Connect from the apps workflow (.github/workflows/apps.yml "ios", "testflight"; docs/apps.md "iOS"). The team's
App Store Connect API key — ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 (mobile/tools/appstore.py secrets). No secret is printed.

    asc.py app                     the app's App Store Connect record (GITHUB_OUTPUT app=<id>, empty when there is none:
                                   it is made once by hand — My Apps → + → New App)
    asc.py testflight --version V --build N [--public] [--wait-review MIN] [--notes FILE] [--out ios.json]
                                   after an upload: waits for Apple to process build N of V, says what to test, and with
                                   --public puts it in the public link's group (홈페이지) and submits it to beta review;
                                   --out: the newest build that public link gives now (ios.json, the Download page's iOS
                                   card) — none while no build of the group has passed review
    asc.py link --out ios.json     that file alone (a run without an iOS build: one may have passed review since)
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

API = "https://api.appstoreconnect.apple.com"
BUNDLE_ID = os.environ.get("IOS_BUNDLE_ID", "me.hrletsgo.harnessor")
INTERNAL_GROUP = "내부 테스트"
PUBLIC_GROUP = "홈페이지"
LOCALES = ("ko", "en-US")
DESCRIPTION = {
    "ko": "My Mate Geny — 내 서버의 에이전트 콘솔(Claude Code · Codex)과 메이트를 iPhone · iPad 에서. 앱을 열면 서버를 찾아 로그인해요.",
    "en-US": "My Mate Geny — your own server's agent console (Claude Code · Codex) and your Mate on iPhone and iPad. "
             "Open the app, find your server and sign in.",
}


def need(name: str) -> str:
    v = os.environ.get(name, "")
    if not v:
        raise SystemExit(f"{name} is not set")
    return v


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


_token: tuple[float, str] | None = None


def token() -> str:
    global _token
    if _token and _token[0] > time.time() + 60:
        return _token[1]
    key = serialization.load_pem_private_key(need("ASC_KEY_P8").strip().encode() + b"\n", password=None)
    now = int(time.time())
    head = {"alg": "ES256", "kid": need("ASC_KEY_ID"), "typ": "JWT"}
    body = {"iss": need("ASC_ISSUER_ID"), "iat": now, "exp": now + 15 * 60, "aud": "appstoreconnect-v1"}
    signing = f"{b64url(json.dumps(head).encode())}.{b64url(json.dumps(body).encode())}"
    r, s = decode_dss_signature(key.sign(signing.encode(), ec.ECDSA(hashes.SHA256())))
    _token = (now + 15 * 60, f"{signing}.{b64url(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}")
    return _token[1]


def call(method: str, path: str, body: dict | None = None, ok: tuple[int, ...] = ()) -> dict:
    for attempt in range(1, 5):
        req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                doc = json.loads(raw or b"{}")
            except ValueError:
                doc = {}
            if e.code in ok:
                return {"_status": e.code, **doc}
            if e.code >= 500 or e.code == 429:
                time.sleep(attempt * 10)
                continue
            detail = "; ".join(f"{x.get('code')}: {x.get('detail') or x.get('title')}" for x in doc.get("errors", [])) or "-"
            raise SystemExit(f"{method} {path.split('?')[0]} → HTTP {e.code}: {detail}")
        except (urllib.error.URLError, TimeoutError):
            time.sleep(attempt * 10)
    raise SystemExit(f"{method} {path.split('?')[0]}: App Store Connect kept failing")


def q(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def output(**kv: str) -> None:
    with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a", encoding="utf-8") as f:
        for k, v in kv.items():
            f.write(f"{k}={v}\n")


def app_id() -> str:
    rows = call("GET", f"/v1/apps?filter[bundleId]={q(BUNDLE_ID)}&fields[apps]=bundleId")["data"]
    rows = [a for a in rows if a["attributes"]["bundleId"] == BUNDLE_ID]
    return rows[0]["id"] if rows else ""


def cmd_app(_a) -> None:
    aid = app_id()
    output(app=aid)
    if aid:
        print(f"App Store Connect: {BUNDLE_ID} is app {aid}")
    else:
        print(f"::warning::No App Store Connect record for {BUNDLE_ID} yet — the IPA is built and signed but not uploaded. "
              "Make it once: App Store Connect → My Apps → + → New App (iOS, this bundle ID, SKU mymategeny).")


def find_build(aid: str, version: str, number: str) -> dict | None:
    rows = call("GET", f"/v1/builds?filter[app]={aid}&filter[version]={q(number)}&filter[preReleaseVersion.version]={q(version)}"
                       "&include=buildBetaDetail&limit=5")
    return rows["data"][0] if rows.get("data") else None


def wait_processed(aid: str, version: str, number: str, minutes: int = 50) -> dict:
    deadline = time.time() + minutes * 60
    while time.time() < deadline:
        b = find_build(aid, version, number)
        state = b["attributes"]["processingState"] if b else "not there yet"
        if state == "VALID":
            print(f"build {version} ({number}): processed")
            return b
        if state in ("FAILED", "INVALID"):
            raise SystemExit(f"build {version} ({number}): Apple says {state} (App Store Connect → TestFlight shows why)")
        print(f"build {version} ({number}): {state} …", flush=True)
        time.sleep(30)
    raise SystemExit(f"build {version} ({number}) was not processed in {minutes} minutes")


def groups(aid: str) -> dict[str, dict]:
    have = {g["attributes"]["name"]: g for g in call("GET", f"/v1/apps/{aid}/betaGroups?limit=50")["data"]}
    if INTERNAL_GROUP not in have:
        have[INTERNAL_GROUP] = call("POST", "/v1/betaGroups", {"data": {"type": "betaGroups", "attributes": {
            "name": INTERNAL_GROUP, "isInternalGroup": True, "hasAccessToAllBuilds": True},
            "relationships": {"app": {"data": {"type": "apps", "id": aid}}}}})["data"]
        print(f"group {INTERNAL_GROUP}: made (every build, the team's own testers)")
    g = have.get(PUBLIC_GROUP)
    if not g:
        have[PUBLIC_GROUP] = call("POST", "/v1/betaGroups", {"data": {"type": "betaGroups", "attributes": {
            "name": PUBLIC_GROUP, "publicLinkEnabled": True, "publicLinkLimitEnabled": False},
            "relationships": {"app": {"data": {"type": "apps", "id": aid}}}}})["data"]
        print(f"group {PUBLIC_GROUP}: made (the public link the Download page's QR opens)")
    elif not g["attributes"].get("publicLinkEnabled"):
        have[PUBLIC_GROUP] = call("PATCH", f"/v1/betaGroups/{g['id']}", {"data": {"type": "betaGroups", "id": g["id"],
                                                                                    "attributes": {"publicLinkEnabled": True}}})["data"]
    return have


def beta_info(aid: str) -> None:
    """the test information's description (contacts, feedback e-mail and privacy policy are the owner's: see review_missing)"""
    have = {x["attributes"]["locale"]: x for x in call("GET", f"/v1/apps/{aid}/betaAppLocalizations")["data"]}
    for loc in LOCALES:
        at = {"description": DESCRIPTION[loc]}
        if loc in have:
            if not have[loc]["attributes"].get("description"):
                call("PATCH", f"/v1/betaAppLocalizations/{have[loc]['id']}", {"data": {"type": "betaAppLocalizations", "id": have[loc]["id"], "attributes": at}})
        else:
            call("POST", "/v1/betaAppLocalizations", {"data": {"type": "betaAppLocalizations", "attributes": {"locale": loc, **at},
                                                               "relationships": {"app": {"data": {"type": "apps", "id": aid}}}}}, ok=(409,))


def what_to_test(build: str, text: str) -> None:
    text = text.strip()[:3900] or "-"
    have = {x["attributes"]["locale"]: x for x in call("GET", f"/v1/builds/{build}/betaBuildLocalizations")["data"]}
    for loc in LOCALES:
        if loc in have:
            call("PATCH", f"/v1/betaBuildLocalizations/{have[loc]['id']}", {"data": {"type": "betaBuildLocalizations", "id": have[loc]["id"], "attributes": {"whatsNew": text}}})
        else:
            call("POST", "/v1/betaBuildLocalizations", {"data": {"type": "betaBuildLocalizations", "attributes": {"locale": loc, "whatsNew": text},
                                                                 "relationships": {"build": {"data": {"type": "builds", "id": build}}}}}, ok=(409,))


def review_missing(aid: str) -> list[str]:
    """what the owner fills in once before beta review (App Store Connect → TestFlight → Test Information); read, not printed"""
    miss = []
    d = call("GET", f"/v1/apps/{aid}/betaAppReviewDetail")["data"]["attributes"]
    for k, name in (("contactFirstName", "contact first name"), ("contactLastName", "contact last name"),
                    ("contactPhone", "contact phone"), ("contactEmail", "contact e-mail")):
        if not d.get(k):
            miss.append(name)
    locs = call("GET", f"/v1/apps/{aid}/betaAppLocalizations")["data"]
    if not any(x["attributes"].get("feedbackEmail") for x in locs):
        miss.append("feedback e-mail")
    if not any(x["attributes"].get("privacyPolicyUrl") for x in locs):
        miss.append("privacy policy URL")
    return miss


def review_state(build: str) -> str:
    rows = call("GET", f"/v1/betaAppReviewSubmissions?filter[build]={build}")["data"]
    return rows[0]["attributes"]["betaReviewState"] if rows else ""


def live_build(group: dict) -> dict | None:
    """the newest build the public link gives now: in the group, passed review"""
    res = call("GET", f"/v1/betaGroups/{group['id']}/builds?limit=50&include=preReleaseVersion,buildBetaDetail")
    pre = {x["id"]: x["attributes"]["version"] for x in res.get("included", []) if x["type"] == "preReleaseVersions"}
    beta = {x["id"]: x["attributes"] for x in res.get("included", []) if x["type"] == "buildBetaDetails"}
    live = []
    for b in res.get("data", []):
        rel = b.get("relationships", {})
        bd = beta.get(((rel.get("buildBetaDetail") or {}).get("data") or {}).get("id"), {})
        if bd.get("externalBuildState") == "IN_BETA_TESTING" and not b["attributes"].get("expired"):
            live.append({"version": pre.get(((rel.get("preReleaseVersion") or {}).get("data") or {}).get("id"), ""),
                         "build": b["attributes"]["version"], "uploaded": b["attributes"].get("uploadedDate", "")})
    return max(live, key=lambda x: x["uploaded"]) if live else None


def cmd_testflight(a) -> None:
    aid = app_id()
    if not aid:
        raise SystemExit(f"no App Store Connect record for {BUNDLE_ID}")
    b = wait_processed(aid, a.version, a.build)
    notes = open(a.notes, encoding="utf-8").read() if a.notes and os.path.exists(a.notes) else ""
    what_to_test(b["id"], notes)
    have = groups(aid)
    if a.public:
        beta_info(aid)
        g = have[PUBLIC_GROUP]
        call("POST", f"/v1/betaGroups/{g['id']}/relationships/builds", {"data": [{"type": "builds", "id": b["id"]}]})
        print(f"build {a.version} ({a.build}) → {PUBLIC_GROUP}")
        miss = review_missing(aid)
        if miss:
            print(f"::warning::Beta review needs, once (App Store Connect → TestFlight → Test Information): {', '.join(miss)}. "
                  "Until a build has passed it, the public link gives nothing and the Download page shows no iOS card.")
        elif not review_state(b["id"]):
            r = call("POST", "/v1/betaAppReviewSubmissions", {"data": {"type": "betaAppReviewSubmissions",
                                                                       "relationships": {"build": {"data": {"type": "builds", "id": b["id"]}}}}}, ok=(409, 422))
            print(f"build {a.version} ({a.build}): submitted to beta review" + (f" (HTTP {r['_status']}: already)" if "_status" in r else ""))
        deadline = time.time() + a.wait_review * 60
        while not miss and time.time() < deadline:
            state = review_state(b["id"])
            if state in ("APPROVED", "REJECTED"):
                print(f"beta review: {state}")
                break
            print(f"beta review: {state or 'not submitted'} …", flush=True)
            time.sleep(60)
        if a.out:
            write_link(aid, a.out)


def write_link(aid: str, out: str) -> None:
    group = next((g for g in call("GET", f"/v1/apps/{aid}/betaGroups?limit=50")["data"] if g["attributes"]["name"] == PUBLIC_GROUP), None)
    link = (group or {}).get("attributes", {}).get("publicLink") or ""
    live = live_build(group) if group and link.startswith("https://testflight.apple.com/") else None
    if not live:
        print("the public link gives no build yet (beta review): no iOS card on the Download page for now")
        return
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"version": live["version"], "build": live["build"], "testflight": link,
                   "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, f)
    print(f"the public link gives {live['version']} ({live['build']}) → {out}")
    output(ios_json=out, ios_version=live["version"])


def cmd_link(a) -> None:
    aid = app_id()
    if aid:
        write_link(aid, a.out)
    else:
        print(f"no App Store Connect record for {BUNDLE_ID} yet")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # (Windows: cp1252 otherwise)
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("app")
    t = sub.add_parser("testflight")
    t.add_argument("--version", required=True)
    t.add_argument("--build", required=True)
    t.add_argument("--public", action="store_true")
    t.add_argument("--wait-review", type=int, default=0)
    t.add_argument("--notes")
    t.add_argument("--out")
    lk = sub.add_parser("link")
    lk.add_argument("--out", required=True)
    a = ap.parse_args()
    {"app": cmd_app, "testflight": cmd_testflight, "link": cmd_link}[a.cmd](a)
