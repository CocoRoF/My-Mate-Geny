#!/usr/bin/env python3
"""The apps' releases, one platform at a time (.github/workflows/apps.yml; docs/apps.md "Releases").

    apps_publish.py begin <line> <channel> <platforms…>          this run's version and its (draft) release → GITHUB_OUTPUT
    apps_publish.py publish <platform> <version> <tag|-> [--latest] [--wait-verify] <file>…
    apps_publish.py mac-legacy <version>                          the macOS feed both architectures share (apps ≤ 1.1.0)
    apps_publish.py finalize <tag> <channel>                      an empty draft goes; old releases are pruned

Each platform (windows, linux, macos-arm64, macos-x64, android, ios) goes up on its own, the moment it is built: its files
into this run's versioned release <tag> (apps-v<version>; the first one to arrive makes the draft public), and — with
--latest — into the rolling `apps-latest` release the Download page and the desktop's own updater read:

  1. the installers first, the update feed (latest*.yml, ios.json) last: a feed never names a file that isn't there yet;
  2. never over a newer build of the same platform (an older run that finished late leaves apps-latest alone);
  3. then this platform's older files go (another platform's are never touched).

apps-latest's notes are the newest build's, and its hrh-meta never names a version: apps up to 1.1.0 pin their files to
the versioned release a version names, and one platform's release doesn't hold the others.

The macOS feed every architecture shares (latest-mac.yml, read by apps 1.1.0 and older) is written by mac-legacy once
both architectures of one version are up: until then those apps keep the last complete one, and its files stay.

--wait-verify: published only once this run's verify jobs (the backend's and the UI's tests) have passed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

LATEST = "apps-latest"
# what of the release belongs to each platform: its installers and its feed
PLATFORMS: dict[str, tuple[str, list[str]]] = {
    "windows": (r"-windows-x64-setup\.exe(\.blockmap)?$", ["latest.yml"]),
    "linux": (r"-linux-(x86_64\.AppImage|amd64\.deb)(\.blockmap)?$", ["latest-linux.yml"]),
    "macos-arm64": (r"-macos-arm64\.(zip|dmg)(\.blockmap)?$", ["latest-mac-arm64.yml"]),
    "macos-x64": (r"-macos-x64\.(zip|dmg)(\.blockmap)?$", ["latest-mac-x64.yml"]),
    "android": (r"-android\.apk$", []),
    "ios": (r"-ios\.ipa$", ["ios.json"]),
}
VERSION_IN_NAME = re.compile(r"-(\d+\.\d+\.\d+)-")
META = re.compile(r"<!--\s*hrh-meta\s*(\{.*?\})\s*-->", re.S)
KEEP = {"release": 5, "test": 2}  # versioned releases kept (+ each platform's newest)


def repo() -> str:
    return os.environ["GITHUB_REPOSITORY"]


def gh(*args: str, check: bool = True, stdin: str | None = None) -> subprocess.CompletedProcess:
    for attempt in range(1, 6):
        r = subprocess.run(["gh", *args], text=True, capture_output=True, input=stdin)
        if r.returncode == 0 or not check:
            return r
        print(f"gh {' '.join(args[:3])} failed (try {attempt}): {r.stderr.strip()[:300]}", file=sys.stderr)
        time.sleep(attempt * 3)
    raise SystemExit(f"gh {' '.join(args)} kept failing")


def vkey(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


def output(**kv: str) -> None:
    with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a", encoding="utf-8") as f:
        for k, v in kv.items():
            f.write(f"{k}={v}\n")


def release(tag: str) -> dict | None:
    r = gh("api", f"repos/{repo()}/releases/tags/{tag}", check=False)
    if r.returncode == 0 and r.stdout.strip():
        return json.loads(r.stdout)
    # (a draft has no tag yet: only the list knows it)
    r = gh("api", "--paginate", f"repos/{repo()}/releases?per_page=100", "--jq", f'.[] | select(.tag_name == "{tag}")', check=False)
    rows = [json.loads(x) for x in r.stdout.splitlines() if x.strip()]
    return rows[0] if rows else None


def assets(tag: str) -> list[dict]:
    rel = release(tag)
    return [{"name": a["name"], "id": a["id"], "updated_at": a["updated_at"]} for a in (rel or {}).get("assets", [])]


def meta_of(body: str) -> dict:
    m = META.search(body or "")
    try:
        return json.loads(m.group(1)) if m else {}
    except ValueError:
        return {}


def git(*args: str) -> str:
    return subprocess.run(["git", *args], text=True, capture_output=True, check=True).stdout.strip()


# ---- begin: this run's version and release


def cmd_begin(line: str, channel: str, platforms: list[str]) -> None:
    """<line>.<n>: n one past the highest release of the line, drafts too (a run still building holds its number)"""
    prefix = "apps-test-v" if channel == "test" else "apps-v"
    r = gh("api", "--paginate", f"repos/{repo()}/releases?per_page=100", "--jq", ".[] | [.tag_name, .draft] | @tsv")
    rx = re.compile(rf"^{re.escape(prefix)}{re.escape(line)}\.(\d+)$")
    taken = [int(m.group(1)) for row in r.stdout.splitlines() if (m := rx.match(row.split("\t")[0]))]
    version = f"{line}.{max(taken, default=-1) + 1}"
    tag = f"{prefix}{version}"
    sha = os.environ.get("GITHUB_SHA") or git("rev-parse", "HEAD")
    published = sorted((t for t in git("tag", "--list", f"{prefix}*").splitlines() if re.match(rf"^{re.escape(prefix)}\d+\.\d+\.\d+$", t)),
                       key=lambda t: vkey(t[len(prefix):]), reverse=True)
    prev = published[0] if published else ""
    meta = {"version": version, "commit": sha, "commit_message": git("log", "-1", "--format=%s", sha),
            "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    notes = [f"<!-- hrh-meta {json.dumps(meta, ensure_ascii=False)} -->",
             f"Built from {sha[:7]}: {meta['commit_message']}", "", f"Platforms: {', '.join(platforms) or '—'}"]
    if prev:
        log = git("log", "--no-merges", "--format=- %s (%h)", f"{prev}..{sha}").splitlines()
        notes += ["", f"Changes since {prev}:", *log[:40], *(["- …"] if len(log) > 40 else [])]
    title = f"Apps {'test ' if channel == 'test' else ''}{version}"
    test = ["--prerelease"] if channel == "test" else []  # (labelled so in the repository's releases)
    gh("release", "create", tag, "--draft", *test, "--title", title, "--notes-file", "-", "--target", sha, stdin="\n".join(notes) + "\n")
    print(f"{title} ({tag}) from {sha[:7]}; platforms: {', '.join(platforms)}")
    output(version=version, tag=tag)


# ---- publish: one platform


def wait_verified(limit_s: int = 40 * 60) -> None:
    """this run's verify jobs: all passed, or this platform isn't published"""
    run = os.environ["GITHUB_RUN_ID"]
    deadline = time.time() + limit_s
    while True:
        r = gh("api", f"repos/{repo()}/actions/runs/{run}/jobs?filter=latest&per_page=100",
               "--jq", '[.jobs[] | select(.name | startswith("verify")) | {name, status, conclusion}]')
        jobs = json.loads(r.stdout or "[]")
        if jobs and all(j["status"] == "completed" for j in jobs):
            bad = [j["name"] for j in jobs if j["conclusion"] != "success"]
            if bad:
                raise SystemExit(f"not published: {', '.join(bad)} did not pass")
            print(f"verified: {', '.join(j['name'] for j in jobs)}")
            return
        if time.time() > deadline:
            raise SystemExit("not published: the verify jobs did not finish in time")
        waiting = [j["name"] for j in jobs if j["status"] != "completed"] or ["(not started)"]
        print(f"waiting for {', '.join(waiting)} …", flush=True)
        time.sleep(20)


def published_version(platform: str, files: list[dict]) -> str | None:
    """the version of this platform on apps-latest now (from its installers' names, else its feed)"""
    rx = re.compile(PLATFORMS[platform][0])
    found = [m.group(1) for a in files if rx.search(a["name"]) and (m := VERSION_IN_NAME.search(a["name"]))]
    if platform == "ios" and any(a["name"] == "ios.json" for a in files):
        r = gh("release", "download", LATEST, "-p", "ios.json", "-O", "-", check=False)
        try:
            found.append(json.loads(r.stdout)["version"])
        except (ValueError, KeyError, TypeError):
            pass
    return max(found, key=vkey) if found else None


def upload(tag: str, paths: list[Path]) -> None:
    for p in paths:
        gh("release", "upload", tag, str(p), "--clobber")
        print(f"  {tag} ← {p.name}", flush=True)


def latest_notes(version: str, tag: str) -> None:
    """apps-latest says what its newest build is (never with a version in its hrh-meta: see above)"""
    rel = release(LATEST) or {}
    now = meta_of(rel.get("body", "")).get("latest")
    if now and vkey(now) > vkey(version):
        return
    src = release(tag) or {}
    m = meta_of(src.get("body", ""))
    meta = {"latest": version, "commit": m.get("commit", ""), "commit_message": m.get("commit_message", ""), "built_at": m.get("built_at", "")}
    body = META.sub("", src.get("body", "")).strip()
    text = f"<!-- hrh-meta {json.dumps(meta, ensure_ascii=False)} -->\nEach platform's newest build: each is put here the moment it is built.\n\n{body}\n"
    gh("release", "edit", LATEST, "--title", f"Apps {version} (latest)", "--notes-file", "-", stdin=text)


def cmd_publish(platform: str, version: str, tag: str, latest: bool, verify: bool, paths: list[Path]) -> None:
    rx, feeds = PLATFORMS[platform]
    pattern = re.compile(rx)
    foreign = [p.name for p in paths if p.name not in feeds and not pattern.search(p.name)]
    if foreign:
        raise SystemExit(f"not {platform}'s: {', '.join(foreign)}")
    missing = [str(p) for p in paths if not p.is_file()]
    if missing or not paths:
        raise SystemExit(f"nothing to publish / missing: {missing}")
    if verify:
        wait_verified()
    first = [p for p in paths if p.name not in feeds]
    last = [p for p in paths if p.name in feeds]
    print(f"{platform} {version} → {tag}{' + ' + LATEST if latest else ''}")
    # (tag "-": apps-latest only — ios.json naming a build an earlier run made, once it has passed beta review)
    rel = release(tag) if tag != "-" else {}
    if rel is None:
        raise SystemExit(f"{tag}: no such release")
    to_latest = False
    if latest:
        if not release(LATEST):
            gh("release", "create", LATEST, "--title", "Apps (latest)", "--notes", "Each platform's newest build.", "--latest=false")
        now = published_version(platform, assets(LATEST))
        to_latest = not (now and vkey(now) > vkey(version))
        if not to_latest:
            print(f"  {LATEST} has {platform} {now}, newer than {version}: left as it is")
    # (both releases at once: the installers are large)
    with ThreadPoolExecutor(2) as pool:
        jobs = [pool.submit(upload, tag, first + last)] if tag != "-" else []
        if to_latest:
            jobs.append(pool.submit(upload, LATEST, first + last))
        for j in jobs:
            j.result()
    if rel.get("draft"):
        gh("release", "edit", tag, "--draft=false", "--latest=false")
        print(f"  {tag}: public")
    if not to_latest:
        return
    keep = {p.name for p in paths}
    for a in assets(LATEST):
        if a["name"] not in keep and (pattern.search(a["name"]) or a["name"] in feeds) and not legacy_mac_needs(a["name"]):
            gh("release", "delete-asset", LATEST, a["name"], "--yes", check=False)
            print(f"  {LATEST} − {a['name']}")
    if tag != "-":
        latest_notes(version, tag)


_legacy: set[str] | None = None


def legacy_mac_needs(name: str) -> bool:
    """the files the shared macOS feed (latest-mac.yml) names now: they stay until it moves on"""
    global _legacy
    if not re.search(r"-macos-(arm64|x64)\.", name):
        return False
    if _legacy is None:
        r = gh("release", "download", LATEST, "-p", "latest-mac.yml", "-O", "-", check=False)
        _legacy = set(re.findall(r"url:\s*\"?([^\"\s]+)", r.stdout)) if r.returncode == 0 else set()
    return name in _legacy


def cmd_mac_legacy(version: str) -> None:
    """latest-mac.yml for the apps that read one feed for both architectures: both of this version, or nothing"""
    files = {a["name"] for a in assets(LATEST)}
    want = [f"latest-mac-{arch}.yml" for arch in ("arm64", "x64")]
    if not all(w in files for w in want):
        print("latest-mac.yml: not both architectures on apps-latest yet — the last complete one stays")
        return
    entries: list[str] = []
    for w in want:
        r = gh("release", "download", LATEST, "-p", w, "-O", "-")
        if not re.search(rf"^version:\s*\"?{re.escape(version)}\"?\s*$", r.stdout, re.M):
            print(f"latest-mac.yml: {w} is not {version} — the last complete one stays")
            return
        entries.append(r.stdout)
    blocks = [b for feed in entries for b in re.findall(r"  - url: .*\n    sha512: .*\n    size: .*", feed)]
    head = re.search(r"^path: (.*)\nsha512: (.*)", entries[0], re.M)
    if not blocks or not head:
        raise SystemExit("latest-mac.yml: the architectures' feeds are not as macos-dmg.py writes them")
    lines = [f"version: {json.dumps(version)}", "files:", *blocks, f"path: {head.group(1)}", f"sha512: {head.group(2)}",
             f"releaseDate: {json.dumps(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))}"]
    out = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "latest-mac.yml"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    upload(LATEST, [out])
    named = set(re.findall(r"url:\s*\"?([^\"\s]+)", out.read_text()))
    for a in assets(LATEST):
        n = a["name"]
        if re.search(r"-macos-(arm64|x64)\.(zip|dmg)(\.blockmap)?$", n) and n not in named and f"-{version}-" not in n:
            gh("release", "delete-asset", LATEST, n, "--yes", check=False)
            print(f"  {LATEST} − {n}")


# ---- finalize


def cmd_finalize(tag: str, channel: str) -> None:
    rel = release(tag)
    if rel and rel.get("draft") and not rel.get("assets"):
        gh("release", "delete", tag, "--yes", check=False)
        print(f"{tag}: nothing was published — its draft is gone (the next run takes its number)")
    prefix = "apps-test-v" if channel == "test" else "apps-v"
    rx = re.compile(rf"^{re.escape(prefix)}(\d+\.\d+\.\d+)$")
    r = gh("api", "--paginate", f"repos/{repo()}/releases?per_page=100", "--jq", ".[] | select(.draft | not) | {tag: .tag_name, files: [.assets[].name]}")
    rels = sorted((x for line in r.stdout.splitlines() if line.strip() and rx.match((x := json.loads(line))["tag"])),
                  key=lambda x: vkey(rx.match(x["tag"]).group(1)), reverse=True)
    keep = {x["tag"] for x in rels[: KEEP[channel]]}
    # (+ each platform's newest: what apps_plan.py compares a push with, and its archive)
    for rx_built in [r"-windows-x64-setup\.exe$", r"-linux-x86_64\.AppImage$", r"-macos-arm64\.dmg$", r"-macos-x64\.dmg$", r"-android\.apk$", r"-ios\.ipa$"]:
        hit = next((x for x in rels if any(re.search(rx_built, f) for f in x["files"])), None)
        if hit:
            keep.add(hit["tag"])
    for x in rels:
        if x["tag"] not in keep:
            r = gh("release", "delete", x["tag"], "--yes", "--cleanup-tag", check=False)
            print(f"{x['tag']}: {'pruned' if r.returncode == 0 else 'could not be pruned (' + r.stderr.strip()[:120] + ')'}")
    print(f"kept: {', '.join(sorted(keep, key=lambda t: vkey(rx.match(t).group(1)), reverse=True))}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("begin")
    b.add_argument("line")
    b.add_argument("channel", choices=["release", "test"])
    b.add_argument("platforms", nargs="*")
    p = sub.add_parser("publish")
    p.add_argument("platform", choices=list(PLATFORMS))
    p.add_argument("version")
    p.add_argument("tag")
    p.add_argument("--latest", action="store_true")
    p.add_argument("--wait-verify", action="store_true")
    p.add_argument("files", nargs="+", type=Path)
    m = sub.add_parser("mac-legacy")
    m.add_argument("version")
    f = sub.add_parser("finalize")
    f.add_argument("tag")
    f.add_argument("channel", choices=["release", "test"])
    a = ap.parse_args()
    if a.cmd == "begin":
        cmd_begin(a.line, a.channel, a.platforms)
    elif a.cmd == "publish":
        cmd_publish(a.platform, a.version, a.tag, a.latest, a.wait_verify, a.files)
    elif a.cmd == "mac-legacy":
        cmd_mac_legacy(a.version)
    else:
        cmd_finalize(a.tag, a.channel)
