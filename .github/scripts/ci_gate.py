#!/usr/bin/env python3
"""Which of CI's jobs run (.github/workflows/ci.yml, voice-local.yml, windows-update.yml; docs/apps.md "CI").

    ci_gate.py ci                     ci.yml's changes job: each job's go (GITHUB_OUTPUT <job>=true|false), from what
                                      changed (FILTERS, dorny/paths-filter's outputs as JSON) and —
                                        the Windows and macOS jobs: only on a pull request with their label (ci:windows,
                                        ci:ios), never on a push; Linux runners for the rest;
                                        a push to main that merged a pull request: not the jobs that pull request already
                                        passed on the very same tree (its commit status "ci: tested tree", by `mark`)
    ci_gate.py mark                   ci.yml's tested job, on a pull request: the tree it tested (the merge GitHub made)
                                      and the jobs that passed on it (NEEDS: toJSON(needs)), as that commit status on
                                      the pull request's head — nothing when one failed
    ci_gate.py heavy <label>          a suite on Windows / macOS runners (voice-local, windows-update): run=true by hand
                                      or on a push to its own branch; on a pull request only with <label>

A label added after the run (or a re-run) counts: the labels are read when the job runs, not from the event.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

CONTEXT = "ci: tested tree"
# ci.yml's jobs: (the paths-filter result each follows, the label it needs on a pull request: Windows / macOS runners)
JOBS = {
    "backend": ("backend", None),
    "bridges-windows": ("bridges", "ci:windows"),
    "avatar-processing": ("avatar", None),
    "frontend": ("frontend", None),
    "desktop": ("desktop", None),
    "mobile": ("mobile", None),
    "ios": ("ios", "ci:ios"),
    "compose": ("compose", None),
}


def api(path: str, *fields: str, method: str = "GET"):
    args = ["gh", "api", "-X", method, path, *[x for f in fields for x in ("-f", f)]]
    done = subprocess.run(args, text=True, encoding="utf-8", capture_output=True)
    if done.returncode:
        raise RuntimeError(f"gh api {path}: {done.stderr.strip()[:300]}")
    return json.loads(done.stdout or "null")


def repo() -> str:
    return os.environ["GITHUB_REPOSITORY"]


def event() -> dict:
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as f:
        return json.load(f)


def output(**kv: str) -> None:
    with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a", encoding="utf-8") as f:
        for k, v in kv.items():
            f.write(f"{k}={v}\n")


def summary(text: str) -> None:
    print(text)
    with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a", encoding="utf-8") as f:
        f.write(text + "\n")


def labels() -> set[str]:
    n = event()["pull_request"]["number"]
    return {x["name"] for x in api(f"repos/{repo()}/pulls/{n}")["labels"]}


def tree(sha: str) -> str:
    return api(f"repos/{repo()}/git/commits/{sha}")["tree"]["sha"]


def seen(sha: str) -> tuple[set[str], str]:
    """(the jobs passed on this very tree, by which pull request) — when this commit is a pull request's merge"""
    prs = [p for p in api(f"repos/{repo()}/commits/{sha}/pulls") if p.get("merged_at") and p.get("merge_commit_sha") == sha]
    if not prs:
        return set(), ""
    mine = tree(sha)
    for s in api(f"repos/{repo()}/commits/{prs[0]['head']['sha']}/statuses?per_page=100"):
        words = (s.get("description") or "").split()
        if s.get("context") == CONTEXT and s.get("state") == "success" and words and words[0] == mine:
            return set(words[1:]), f"#{prs[0]['number']}"
    return set(), f"#{prs[0]['number']} (not on this tree)"


def cmd_ci() -> None:
    changed = json.loads(os.environ.get("FILTERS") or "{}")
    name = os.environ["GITHUB_EVENT_NAME"]
    have, done, by = set(), set(), ""
    try:
        if name == "pull_request":
            have = labels()
        elif name == "push":
            done, by = seen(os.environ["GITHUB_SHA"])
    except RuntimeError as e:  # (the API failing: a push runs everything, a pull request its Linux jobs)
        print(f"::warning::{e}")
    rows = ["| job | runs | why |", "|---|---|---|"]
    go = {}
    for job, (part, label) in JOBS.items():
        if changed.get(part) != "true":
            go[job], why = False, "nothing it checks changed"
        elif job in done:
            go[job], why = False, f"passed on this very tree in {by}"
        elif label and (name != "pull_request" or label not in have):
            go[job], why = False, f"Windows / macOS: only on a pull request with the label {label}"
        else:
            go[job], why = True, "changed" + (f"; {by}" if by else "")
        rows.append(f"| {job} | {'yes' if go[job] else '—'} | {why} |")
    output(**{j: str(v).lower() for j, v in go.items()})
    summary("### CI: what runs\n\n" + "\n".join(rows))


def cmd_mark() -> None:
    needs = json.loads(os.environ["NEEDS"])
    bad = [j for j, r in needs.items() if r.get("result") in ("failure", "cancelled")]
    if bad:
        print(f"not marked: {', '.join(bad)} did not pass")
        return
    passed = [j for j, r in needs.items() if r.get("result") == "success" and j in JOBS]
    desc = " ".join([tree(os.environ["GITHUB_SHA"]), *passed])
    head = event()["pull_request"]["head"]["sha"]
    try:
        api(f"repos/{repo()}/statuses/{head}", "state=success", f"context={CONTEXT}", f"description={desc[:140]}",
            method="POST")
    except RuntimeError as e:  # (a fork's pull request: a read-only token — its merge is simply tested again)
        print(f"::warning::{e}")
        return
    print(f"marked {head[:7]}: {desc}")


def cmd_heavy(label: str) -> None:
    name = os.environ["GITHUB_EVENT_NAME"]
    if name == "pull_request":
        run = label in labels()
        why = f"the label {label}" if run else f"a pull request without the label {label}"
    else:
        run, why = True, name
    output(run=str(run).lower())
    summary(f"{'Runs' if run else 'Skipped'}: {why}")


if __name__ == "__main__":
    cmd, *rest = sys.argv[1:] or [""]
    if cmd == "ci":
        cmd_ci()
    elif cmd == "mark":
        cmd_mark()
    elif cmd == "heavy" and len(rest) == 1:
        cmd_heavy(rest[0])
    else:
        raise SystemExit(__doc__)
