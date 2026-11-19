#!/usr/bin/env python3
"""Which platforms this run of the apps builds (.github/workflows/apps.yml; docs/apps.md "Releases").

A push makes a new version when something a platform is made of changed since its newest published build — that
build's release (apps-v<version>, the one holding its installer) names the commit it came from:

  desktop (Windows, Linux, macOS ×2)  bundles the backend and the UI for local execution: desktop/, backend/app/, the UI
  android, ios                        load the console live from the user's server: mobile/

and a new version is built for every platform: all of them are always the same version (a phone app at 1.1.1 beside a
desktop at 1.1.4 was taken for one left behind). This workflow and its scripts make every platform again too. By hand (Run workflow): PLATFORMS=all, or a list
(windows,linux,macos-arm64,macos-x64,android,ios), builds those whatever changed; PLATFORMS=changed decides as a push does.

Outputs (GITHUB_OUTPUT): desktop = the desktop matrix (JSON), android / ios / any = true|false. A table of why goes to
the run's summary.
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import subprocess
import sys

DESKTOP = {
    "linux": {"os": "ubuntu-latest"},
    "windows": {"os": "windows-latest"},
    "macos-arm64": {"os": "macos-15", "arch": "arm64"},
    "macos-x64": {"os": "macos-15-intel", "arch": "x64"},
}
ALL = [*DESKTOP, "android", "ios"]
# what each is made of (a directory/ = everything under it) — and what never changes a build
COMMON = [".github/workflows/apps.yml", ".github/scripts/apps_plan.py", ".github/scripts/apps_publish.py"]
SOURCES = {
    "desktop": ["desktop/", "backend/app/", "backend/local_main.py", "backend/pyproject.toml", "frontend/", "assets/"],
    "android": ["mobile/"],
    "ios": ["mobile/", ".github/scripts/asc.py", ".github/scripts/ios_signing.py"],
}
NOT = {
    "desktop": ["desktop/test/e2e/", "frontend/test/", "frontend/e2e/", "frontend/scripts/i18n-scan.mjs"],
    "android": ["mobile/ios/", "mobile/tools/appstore.py"],
    "ios": ["mobile/android/"],
}
NEVER = ["*.md", "*/README*", "*/docs/*"]
# a platform's build, by the file it leaves in its versioned release
BUILT = {
    "windows": r"-windows-x64-setup\.exe$",
    "linux": r"-linux-x86_64\.AppImage$",
    "macos-arm64": r"-macos-arm64\.dmg$",
    "macos-x64": r"-macos-x64\.dmg$",
    "android": r"-android\.apk$",
    "ios": r"-ios\.ipa$",
}


def family(platform: str) -> str:
    return "desktop" if platform in DESKTOP else platform


def under(path: str, prefixes: list[str]) -> bool:
    return any(path == p or (p.endswith("/") and path.startswith(p)) for p in prefixes)


def counts(platform: str, path: str) -> bool:
    if path in COMMON:
        return True
    if any(fnmatch.fnmatch(path, n) for n in NEVER):
        return False
    f = family(platform)
    return under(path, SOURCES[f]) and not under(path, NOT[f])


def git(*args: str) -> str:
    return subprocess.run(["git", *args], text=True, encoding="utf-8", errors="replace", capture_output=True, check=True).stdout


def releases(prefix: str) -> list[dict]:
    """the channel's published versioned releases, newest first, with their files"""
    repo = os.environ["GITHUB_REPOSITORY"]
    r = subprocess.run(["gh", "api", "--paginate", f"repos/{repo}/releases?per_page=100",
                        "--jq", ".[] | select(.draft | not) | {tag: .tag_name, files: [.assets[].name]}"],
                       text=True, encoding="utf-8", errors="replace", capture_output=True, check=True)
    rx = re.compile(rf"^{re.escape(prefix)}(\d+\.\d+\.\d+)$")
    out = [json.loads(line) for line in r.stdout.splitlines() if line.strip()]
    out = [x for x in out if rx.match(x["tag"])]
    return sorted(out, key=lambda x: tuple(int(n) for n in rx.match(x["tag"]).group(1).split(".")), reverse=True)


def last_built(platform: str, rels: list[dict]) -> tuple[str, str] | None:
    """(tag, commit) of the platform's newest published build"""
    rx = re.compile(BUILT[platform])
    for rel in rels:
        if any(rx.search(f) for f in rel["files"]):
            try:
                return rel["tag"], git("rev-list", "-n", "1", rel["tag"]).strip()
            except subprocess.CalledProcessError:
                return None  # (its tag is gone: build again)
    return None


def decide(want: str, prefix: str) -> dict[str, tuple[bool, str]]:
    if want != "changed":
        chosen = ALL if want == "all" else [p.strip() for p in want.split(",") if p.strip()]
        unknown = [p for p in chosen if p not in ALL]
        if unknown:
            raise SystemExit(f"unknown platform(s): {', '.join(unknown)} (one of {', '.join(ALL)}, or all / changed)")
        return {p: (p in chosen, "asked for" if p in chosen else "not asked for") for p in ALL}
    rels = releases(prefix)
    out = {}
    for p in ALL:
        last = last_built(p, rels)
        if not last:
            out[p] = (True, "no published build yet")
            continue
        tag, commit = last
        try:
            changed = [f for f in git("diff", "--name-only", commit, "HEAD").splitlines() if counts(p, f)]
        except subprocess.CalledProcessError:
            out[p] = (True, f"{tag}'s commit is not in this history")
            continue
        out[p] = (bool(changed), f"{len(changed)} file(s) changed since {tag}: {', '.join(changed[:3])}{' …' if len(changed) > 3 else ''}"
                  if changed else f"nothing it is made of changed since {tag}")
    return one_version(out)


def one_version(plan: dict[str, tuple[bool, str]]) -> dict[str, tuple[bool, str]]:
    """a new version is every platform's: the ones nothing changed for are built too"""
    why = [p for p, (b, _) in plan.items() if b]
    if not why:
        return plan
    return {p: (True, r) if b else (True, f"the same version as the others ({', '.join(why[:3])}{' …' if len(why) > 3 else ''}); {r}")
            for p, (b, r) in plan.items()}


def main() -> None:
    want = (os.environ.get("PLATFORMS") or "changed").strip().lower()
    prefix = "apps-test-v" if os.environ.get("CHANNEL") == "test" else "apps-v"
    plan = decide(want, prefix)
    desktop = [{"name": p, **DESKTOP[p]} for p in DESKTOP if plan[p][0]]
    outputs = {
        "desktop": json.dumps(desktop),
        "android": str(plan["android"][0]).lower(),
        "ios": str(plan["ios"][0]).lower(),
        "any": str(any(b for b, _ in plan.values())).lower(),
    }
    with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a", encoding="utf-8") as f:
        for k, v in outputs.items():
            f.write(f"{k}={v}\n")
    lines = ["| platform | build | why |", "|---|---|---|", *(f"| {p} | {'yes' if b else '—'} | {why} |" for p, (b, why) in plan.items())]
    with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a", encoding="utf-8") as f:
        f.write("### Apps: what this run builds\n\n" + "\n".join(lines) + "\n")
    print("\n".join(lines))
    print(json.dumps(outputs), file=sys.stderr)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # (Windows: cp1252 otherwise)
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    main()
