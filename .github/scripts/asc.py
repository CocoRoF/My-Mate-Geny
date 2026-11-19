#!/usr/bin/env python3
"""App Store Connect API from the release workflow (the team's API key: APPLE_API_KEY_B64 / _ID / APPLE_API_ISSUER — the
same key that notarizes the macOS app). No secret is ever printed.

    asc.py probe                 what the account has for the app (read only): its App Store Connect record, the bundle
                                 ID, iOS distribution certificates and profiles, TestFlight groups
"""

from __future__ import annotations

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


def need(name: str) -> str:
    v = os.environ.get(name, "")
    if not v:
        raise SystemExit(f"{name} is not set")
    return v


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def token() -> str:
    key = serialization.load_pem_private_key(base64.b64decode(need("APPLE_API_KEY_B64")), password=None)
    now = int(time.time())
    head = {"alg": "ES256", "kid": need("APPLE_API_KEY_ID"), "typ": "JWT"}
    body = {"iss": need("APPLE_API_ISSUER"), "iat": now, "exp": now + 15 * 60, "aud": "appstoreconnect-v1"}
    signing = f"{b64url(json.dumps(head).encode())}.{b64url(json.dumps(body).encode())}"
    r, s = decode_dss_signature(key.sign(signing.encode(), ec.ECDSA(hashes.SHA256())))
    return f"{signing}.{b64url(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


def call(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def errors(doc: dict) -> str:
    return "; ".join(f"{e.get('code')}: {e.get('title')}" for e in doc.get("errors", [])) or "-"


def probe() -> None:
    q = urllib.parse.quote
    st, apps = call("GET", f"/v1/apps?filter[bundleId]={q(BUNDLE_ID)}&fields[apps]=name,bundleId,sku")
    print(f"app record ({BUNDLE_ID}): HTTP {st}", [a["attributes"]["name"] for a in apps.get("data", [])] or errors(apps))
    st, ids = call("GET", f"/v1/bundleIds?filter[identifier]={q(BUNDLE_ID)}&fields[bundleIds]=identifier,platform,name")
    print(f"bundle id: HTTP {st}", [(b["attributes"]["identifier"], b["attributes"]["platform"]) for b in ids.get("data", [])] or errors(ids))
    st, certs = call("GET", "/v1/certificates?limit=50&fields[certificates]=certificateType,displayName,expirationDate")
    print(f"certificates: HTTP {st}", sorted({c["attributes"]["certificateType"] for c in certs.get("data", [])}) or errors(certs))
    st, profs = call("GET", "/v1/profiles?limit=50&fields[profiles]=name,profileType,profileState")
    print(f"profiles: HTTP {st}", [(p["attributes"]["name"], p["attributes"]["profileType"]) for p in profs.get("data", [])] or errors(profs))
    st, users = call("GET", "/v1/users?limit=1")
    print(f"users (Admin / App Manager only): HTTP {st}", errors(users) if st >= 400 else "readable")
    for a in apps.get("data", []):
        st, groups = call("GET", f"/v1/apps/{a['id']}/betaGroups?fields[betaGroups]=name,isInternalGroup,publicLinkEnabled,publicLink")
        print(f"beta groups: HTTP {st}", [(g["attributes"]["name"], g["attributes"]["isInternalGroup"], g["attributes"].get("publicLink")) for g in groups.get("data", [])] or errors(groups))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "probe"
    {"probe": probe}[cmd]()
