#!/usr/bin/env -S python3 -P
"""A stand-in for the `higgsfield` CLI for Avatar Create tests (backend/tests/test_avatar.py,
desktop/test/e2e/avatar-create-browser.js): it never calls Higgsfield and spends nothing. Point the backend at it
with HIGGSFIELD_BINARY=<this file>.

It answers `generate create|wait|get|cost`, `account status` and `--version` like the real CLI (`--json`), and its
"results" are real pictures and clips made for the official mates (ailism-mate original_content/mate/<key>/masters:
candidates, the remover's cut-out, the raw stills, the Kling clips and the video remover's results), chosen the way a
real job would have produced them:

* a candidate (nano_banana_pro without the stills' reference) → the next character's candidate.png;
* the picture remover / a still / a clip: the character is the one whose candidate.png is byte-identical to the
  ``candidate.png`` next to the input file (the project's masters/), the still by its "change only … face:" text and
  the clip by its action text (best word overlap with that character's manifest);
* the video remover: the clip whose bytes are the input's → its ``.nobg.mp4``.

Config: ``$HOME/.fake-higgsfield.json`` — {"masters": "<…/original_content/mate>", "files_dir": "<dir>",
"files_url": "http://127.0.0.1:<port>/<path>" (where files_dir is served; the backend downloads results from there),
"delay": 0.5 (seconds a job takes), "fail": {"<job_type>": "failed|nsfw"} (optional), "log": "<jobs.jsonl>"}.
Every created job is appended to the log (tests count them: no job may exist before the user confirmed).
"""
import hashlib
import json
import os
import re
import shutil
import sys
import time
import uuid
from pathlib import Path

CONF = json.loads((Path(os.path.expanduser("~")) / ".fake-higgsfield.json").read_text())
MASTERS = Path(CONF["masters"])
FILES = Path(CONF["files_dir"])
FILES.mkdir(parents=True, exist_ok=True)
URL = CONF["files_url"].rstrip("/")
DELAY = float(CONF.get("delay", 0.5))
LOG = Path(CONF.get("log") or FILES / "jobs.jsonl")
CHARS = [c for c in ("chaerin", "estelle", "seoa") if (MASTERS / c / "masters" / "candidate.png").is_file()]
COSTS = {"nano_banana_pro": 2.0, "image_background_remover": 0.5, "kling_o3_flf": 9.0,
         "video_background_remover": 1.0}


def emit(o) -> None:
    print(json.dumps(o))


def sha(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def flags(args: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith("--") and a != "--json":
            v = args[i + 1] if i + 1 < len(args) and not args[i + 1].startswith("--") else ""
            out.setdefault(a[2:].replace("-", "_"), []).append(v)
            i += 2 if v else 1
        else:
            i += 1
    return out


def char_of(path: str) -> str:
    cand = Path(path).with_name("candidate.png")
    if cand.is_file():
        h = sha(cand)
        for c in CHARS:
            if sha(MASTERS / c / "masters" / "candidate.png") == h:
                return c
    return CHARS[0]


def words(t: str) -> set[str]:
    return set(re.findall(r"[a-z']+", t.lower())) - {"she", "her", "he", "his", "the", "a", "and", "then", "with",
                                                       "of", "to", "at", "in", "as", "it", "its", "their", "back"}


def best(text: str, options: dict[str, str]) -> str:
    w = words(text)
    return max(options, key=lambda k: (len(w & words(options[k])), -len(k)))


def manifest(c: str) -> dict:
    return json.loads((MASTERS / c / "manifest.json").read_text())


def pick(job_type: str, f: dict[str, list[str]]) -> Path:
    prompt = (f.get("prompt") or [""])[0]
    if job_type == "nano_banana_pro":
        refs = f.get("image_references") or []
        if refs and refs[0].endswith("candidate.ref.jpg"):
            c = char_of(refs[0])
            face = prompt.split("face:", 1)[-1]
            stills = {s["name"]: s["face"] for s in manifest(c)["stills"]}
            name = best(face, stills)
            return MASTERS / c / "masters" / "stills" / f"{name}.raw.png"
        n = sum(1 for line in LOG.read_text().splitlines() if '"nano_banana_pro"' in line and '"design"' in line) \
            if LOG.exists() else 0
        return MASTERS / CHARS[n % len(CHARS)] / "masters" / "candidate.png"
    if job_type == "image_background_remover":
        c = char_of((f.get("image_references") or [""])[0])
        return MASTERS / c / "masters" / "candidate.cut.png"
    if job_type == "kling_o3_flf":
        c = char_of((f.get("start_image") or [""])[0])
        clips = {x["id"]: x["action"] for x in manifest(c)["clips"]}
        cid = best(prompt.split(". Static camera")[0], clips)
        return MASTERS / c / "masters" / "clips" / f"{cid}.mp4"
    if job_type == "video_background_remover":
        h = sha(Path((f.get("video_references") or [""])[0]))
        for c in CHARS:
            for clip in (MASTERS / c / "masters" / "clips").glob("*.mp4"):
                if not clip.name.endswith(".nobg.mp4") and sha(clip) == h:
                    return clip.with_name(clip.stem + ".nobg.mp4")
        raise SystemExit("fake-higgsfield: unknown video")
    raise SystemExit(f"fake-higgsfield: unknown job type {job_type}")


def job_file(jid: str) -> Path:
    return FILES / f"{jid}.json"


def answer(jid: str, wait: bool) -> dict:
    j = json.loads(job_file(jid).read_text())
    if wait:
        time.sleep(max(0.0, j["ready_at"] - time.time()))
    if time.time() < j["ready_at"]:
        return {"id": jid, "status": "in_progress", "job_type": j["job_type"]}
    if j.get("fail"):
        return {"id": jid, "status": j["fail"], "job_type": j["job_type"], "error": f"fake {j['fail']}"}
    return {"id": jid, "status": "completed", "job_type": j["job_type"],
            "results": {"raw": {"url": f"{URL}/{j['file']}", "type": j["kind"]}}}


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("--version", "version"):
        print("higgsfield fake 0.0.1")
        return 0
    if argv[:2] == ["account", "status"]:
        emit({"credits": 1000, "subscription_plan_type": "ultra"})
        return 0
    if argv[0] != "generate" or len(argv) < 3:
        print("fake-higgsfield: unsupported", argv, file=sys.stderr)
        return 2
    cmd, rest = argv[1], argv[2:]
    if cmd == "cost":
        emit({"credits": COSTS.get(rest[0], 1.0)})
        return 0
    if cmd == "create":
        jt, f = rest[0], flags(rest[1:])
        src = pick(jt, f)
        jid = str(uuid.uuid4())
        ext = src.suffix
        shutil.copyfile(src, FILES / f"{jid}{ext}")
        stage = "design" if jt == "nano_banana_pro" and not any(r.endswith("candidate.ref.jpg")
                                                                    for r in f.get("image_references") or []) else jt
        job_file(jid).write_text(json.dumps({"job_type": jt, "file": f"{jid}{ext}", "ready_at": time.time() + DELAY,
                                             "kind": "video" if ext == ".mp4" else "image",
                                             "fail": (CONF.get("fail") or {}).get(jt)}))
        with LOG.open("a") as fh:
            fh.write(json.dumps({"id": jid, "job_type": jt, "stage": stage, "source": str(src), "flags": f,
                                 "at": time.time()}) + "\n")
        emit([{"id": jid, "status": "queued", "job_type": jt}])
        return 0
    if cmd in ("wait", "get"):
        emit(answer(rest[0], wait=cmd == "wait"))
        return 0
    print("fake-higgsfield: unsupported", argv, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
