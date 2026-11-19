#!/usr/bin/env python3
"""The iOS app's Apple side (docs/apps.md "iOS"): the same Apple developer team, keys and Apple Distribution certificate as
the user's other apps (Tomorrow's Bell) — kept outside any repository, in ~/.local/share/tomorrows-bell/ (APPLE_HOME):

  appstore.env              APPLE_TEAM_ID, ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (the team's App Store Connect API key, admin)
  apple/distribution.*      the Apple Distribution certificate (.p12 and its password, .id = its id at Apple)

  python3 mobile/tools/appstore.py status        the app record, bundle ID, profile, TestFlight builds and groups
  python3 mobile/tools/appstore.py bundle        registers the bundle ID (me.hrletsgo.harnessor, iOS)
  python3 mobile/tools/appstore.py profile       an App Store profile for it with the Apple Distribution certificate
  python3 mobile/tools/appstore.py secrets       this repository's Actions secrets for signing and TestFlight (IOS_*, ASC_*)
  python3 mobile/tools/appstore.py testflight    the internal group (every build) and the public link's group (홈페이지)

The App Store Connect record of the app itself can't be made through the API: My Apps → + → New App (iOS, the bundle ID
above, SKU mymategeny). No secret is ever printed.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HOME = Path(os.environ.get("APPLE_HOME") or Path.home() / ".local/share/tomorrows-bell")
APPLE = HOME / "apple"
API = "https://api.appstoreconnect.apple.com"
BUNDLE = "me.hrletsgo.harnessor"
NAME = "My Mate Geny"
REPO = "CocoRoF/My-Mate-Geny"
PROFILE_NAME = "MyMateGeny AppStore"
PUBLIC_GROUP = "홈페이지"
INTERNAL_GROUP = "내부 테스트"


def env() -> dict[str, str]:
    out = {}
    for line in (HOME / "appstore.env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def token() -> str:
    import jwt  # pyjwt (ES256: cryptography)

    e = env()
    now = int(time.time())
    return jwt.encode({"iss": e["ASC_ISSUER_ID"], "iat": now, "exp": now + 1100, "aud": "appstoreconnect-v1"},
                      Path(e["ASC_KEY_PATH"]).read_text(), algorithm="ES256", headers={"kid": e["ASC_KEY_ID"], "typ": "JWT"})


def call(method: str, path: str, body: dict | None = None, *, ok_missing: bool = False) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")
        try:
            detail = "; ".join(f"{x.get('title')}: {x.get('detail')}" for x in json.loads(detail).get("errors", []))
        except ValueError:
            pass
        if ok_missing and err.code == 404:
            return {}
        raise SystemExit(f"{method} {path} -> {err.code} {detail}")


def q(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def app() -> dict | None:
    rows = call("GET", f"/v1/apps?filter[bundleId]={q(BUNDLE)}")["data"]
    return rows[0] if rows else None


def bundle() -> dict | None:
    rows = [x for x in call("GET", f"/v1/bundleIds?filter[identifier]={q(BUNDLE)}")["data"] if x["attributes"]["identifier"] == BUNDLE]
    return rows[0] if rows else None


def cmd_status(_a) -> None:
    a, b = app(), bundle()
    print(f"app      {a['id'] + ' ' + a['attributes']['name'] if a else '— none yet: My Apps → + → New App (iOS, ' + BUNDLE + ')'}")
    print(f"bundle   {b['id'] + ' ' + b['attributes']['platform'] if b else '— not registered (mobile/tools/appstore.py bundle)'}")
    for p in call("GET", f"/v1/profiles?filter[name]={q(PROFILE_NAME)}")["data"]:
        at = p["attributes"]
        print(f"profile  {at['name']} {at['profileType']} {at['profileState']} ~{at['expirationDate'][:10]}")
    if not a:
        return
    res = call("GET", f"/v1/builds?filter[app]={a['id']}&sort=-uploadedDate&limit=5&include=buildBetaDetail")
    beta = {x["id"]: x["attributes"] for x in res.get("included", []) if x["type"] == "buildBetaDetails"}
    for x in res["data"]:
        at = x["attributes"]
        bd = beta.get((x["relationships"].get("buildBetaDetail", {}).get("data") or {}).get("id"), {})
        print(f"build    {at['version']} {at['processingState']} {at['uploadedDate'][:16]} internal={bd.get('internalBuildState')} external={bd.get('externalBuildState')}")
    for g in call("GET", f"/v1/apps/{a['id']}/betaGroups")["data"]:
        at = g["attributes"]
        print(f"group    {at['name']} internal={at['isInternalGroup']} public={at.get('publicLinkEnabled')} {at.get('publicLink') or ''}")


def cmd_bundle(_a) -> None:
    b = bundle()
    if b:
        print(f"bundle {BUNDLE} is registered ({b['attributes']['platform']})")
        return
    res = call("POST", "/v1/bundleIds", {"data": {"type": "bundleIds", "attributes": {"identifier": BUNDLE, "name": NAME, "platform": "IOS"}}})
    print(f"bundle {BUNDLE} registered: {res['data']['id']}")


def cmd_profile(_a) -> None:
    b = bundle()
    if not b:
        raise SystemExit("register the bundle ID first (bundle)")
    cert_id = (APPLE / "distribution.id").read_text().strip()
    for p in call("GET", f"/v1/profiles?filter[name]={q(PROFILE_NAME)}")["data"]:  # (always a new one: the certificate may have changed)
        call("DELETE", f"/v1/profiles/{p['id']}")
    res = call("POST", "/v1/profiles", {"data": {"type": "profiles", "attributes": {"name": PROFILE_NAME, "profileType": "IOS_APP_STORE"},
                                                 "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": b["id"]}},
                                                                   "certificates": {"data": [{"type": "certificates", "id": cert_id}]}}}})
    at = res["data"]["attributes"]
    out = APPLE / "mymategeny.mobileprovision"
    out.write_bytes(base64.b64decode(at["profileContent"]))
    out.chmod(0o600)
    (APPLE / "mymategeny.uuid").write_text(at["uuid"])
    print(f"profile {at['name']} {at['uuid']} ~{at['expirationDate'][:10]}")


def cmd_secrets(_a) -> None:
    e = env()
    vals = {
        "IOS_TEAM_ID": e["APPLE_TEAM_ID"],
        "ASC_KEY_ID": e["ASC_KEY_ID"],
        "ASC_ISSUER_ID": e["ASC_ISSUER_ID"],
        "ASC_KEY_P8": Path(e["ASC_KEY_PATH"]).read_text(),
        "IOS_DIST_P12": base64.b64encode((APPLE / "distribution.p12").read_bytes()).decode(),
        "IOS_DIST_P12_PASSWORD": (APPLE / "distribution.p12.pass").read_text().strip(),
        "IOS_PROFILE": base64.b64encode((APPLE / "mymategeny.mobileprovision").read_bytes()).decode(),
        "IOS_PROFILE_UUID": (APPLE / "mymategeny.uuid").read_text().strip(),
    }
    for k, v in vals.items():
        subprocess.run(["gh", "secret", "set", k, "-R", REPO], input=v, text=True, check=True, capture_output=True)
        print(f"secret {k}")


def cmd_testflight(a) -> None:
    ap = app()
    if not ap:
        raise SystemExit(f"no App Store Connect record for {BUNDLE} yet: My Apps → + → New App")
    groups = {g["attributes"]["name"]: g for g in call("GET", f"/v1/apps/{ap['id']}/betaGroups")["data"]}
    if INTERNAL_GROUP not in groups:
        call("POST", "/v1/betaGroups", {"data": {"type": "betaGroups", "attributes": {"name": INTERNAL_GROUP, "isInternalGroup": True, "hasAccessToAllBuilds": True},
                                                 "relationships": {"app": {"data": {"type": "apps", "id": ap["id"]}}}}})
        print(f"group {INTERNAL_GROUP}: made (every build, the team's own testers)")
    if PUBLIC_GROUP not in groups:
        call("POST", "/v1/betaGroups", {"data": {"type": "betaGroups", "attributes": {"name": PUBLIC_GROUP, "publicLinkEnabled": True, "publicLinkLimitEnabled": False},
                                                 "relationships": {"app": {"data": {"type": "apps", "id": ap["id"]}}}}})
        print(f"group {PUBLIC_GROUP}: made (the public link the Download page's QR opens)")
    cmd_status(a)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=("status", "bundle", "profile", "secrets", "testflight"))
    args = p.parse_args()
    {"status": cmd_status, "bundle": cmd_bundle, "profile": cmd_profile, "secrets": cmd_secrets, "testflight": cmd_testflight}[args.cmd](args)
