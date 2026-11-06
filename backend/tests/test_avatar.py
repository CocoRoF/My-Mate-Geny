"""Avatar Create (docs/avatar-create.md): presets → plan, prices, the spending gate, the runner's state machine
(checkpoints, redo, cap, pause, resume after a restart), apply / restore, the agent's sealed engine and bridge, the
real Higgsfield CLI path against a fake CLI, and the real processing pipeline (alpha recovery, export → a rig the
avatar player loads) when the processing venv exists."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import stat
import subprocess
import sys
import textwrap
import threading
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from app.avatar import mcp_bridge
from app.avatar import plan as PL
from app.avatar import presets as P
from app.avatar import service as S
from app.avatar.generator import Generator, JobError, result_url
from app.config import settings
from app.mate import files as mate_files
from app.mate.service import MateService
from app.mate.store import MateStore
from app.providers.claude_code import ClaudeCodeProvider
from app.services import session_service as ss_mod
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault
from tests.test_engine import FAKE, _until

ROOT = Path(__file__).resolve().parents[2]
FAKE_HF = ROOT / "desktop" / "test" / "e2e" / "fake-higgsfield.py"
MASTERS = Path("/home/workspace_app/ailism-mate/original_content/mate")
UNITS = {"nano_banana_pro": 2.0, "image_background_remover": 0.5, "kling_o3_flf": 9.0,
         "video_background_remover": 1.0}


def _brief(**kw):
    b = P.merge_brief(None, {"design": {"prompt": "A cheerful girl with short silver hair and a red scarf."},
                             "target": {"mode": "new", "name": "Mina"}})
    return P.merge_brief(b, kw) if kw else b


def _quotes(brief):
    return {k: UNITS[jt] for k, jt, _ in PL.quote_requests(PL.jobs_for(brief))}


# ---------------------------------------------------------------- presets, plan, prices

def test_presets_and_plan_per_preset():
    seen = {}
    for preset, clips, stills in (("minimal", 6, 6), ("standard", 15, 11), ("rich", 21, 12)):
        b = _brief(preset=preset)
        assert len(b["clips"]) == clips and len(b["stills"]) == stills
        jobs = {j["stage"]: j for j in PL.jobs_for(b)}
        assert jobs["design"]["count"] == 4 and jobs["design"]["job_type"] == "nano_banana_pro"
        assert jobs["design"]["params"] == {"aspect_ratio": "3:4", "resolution": "2k"}
        assert jobs["home"]["job_type"] == "image_background_remover" and jobs["home"]["count"] == 1
        assert jobs["stills"]["count"] == stills
        assert jobs["clips"] == {**jobs["clips"], "job_type": "kling_o3_flf", "count": clips,
                                 "params": {"aspect_ratio": "1:1", "duration": 5, "mode": "pro", "sound": "off"}}
        assert jobs["matte"]["job_type"] == "video_background_remover" and jobs["matte"]["count"] == clips
        # the same model + settings are quoted once: candidates and stills share a quote
        assert len(PL.quote_requests(PL.jobs_for(b))) == 4
        seen[preset] = PL.price(b, _quotes(b))["total"]
    # 4 candidates·2 + 0.5 + stills·2 + clips·(9+1)
    assert seen == {"minimal": 8 + 0.5 + 12 + 60, "standard": 8 + 0.5 + 22 + 150, "rich": 8 + 0.5 + 24 + 210}
    # the standard preset is 한채린's manifest without the retired pout
    manifest = json.loads((MASTERS / "chaerin" / "manifest.json").read_text()) if MASTERS.is_dir() else None
    if manifest:
        assert [c["id"] for c in _brief()["clips"]] == [c["id"] for c in manifest["clips"] if c["id"] != "pout"]
    # a reference used as the base: no candidates; light tier: Kling std; 9:16
    b = _brief(reference={"mode": "as_base", "files": ["ref-1.png"]}, tier="light", aspect="9:16", preset="minimal")
    stages = [j["stage"] for j in PL.jobs_for(b)]
    assert stages == ["home", "stills", "clips", "matte"]
    assert PL.clip_params(b) == {"aspect_ratio": "9:16", "duration": 5, "mode": "std", "sound": "off"}


def test_brief_checks_and_custom_motions():
    with pytest.raises(P.BriefError, match="idle"):
        _brief(clips=[{"id": "wave", "kind": "react", "action": "{S} waves", "emotion": "greet"}])
    with pytest.raises(P.BriefError, match="emotion"):
        _brief(clips=[{"id": "idle_a", "kind": "idle"}, {"id": "hop", "kind": "react", "action": "{S} hops twice"}])
    with pytest.raises(P.BriefError, match="upload"):
        _brief(reference={"mode": "redraw"})
    with pytest.raises(P.BriefError):
        _brief(candidates=9)
    b = _brief(clips=[{"id": "idle_a", "kind": "idle"}, {"id": "hop", "kind": "react", "action": "{S} hops twice",
                                                         "emotion": "joy"}, {"id": "doze", "kind": "away"}])
    assert b["preset"] == "custom" and b["clips"][0]["action"] == P.CLIPS["idle_a"][1]
    assert b["clips"][2]["loop"] is True
    assert P.problems(P.merge_brief(None, {})) == [
        "design.prompt: an English description of the character (or a reference used as the base)",
        "target.name: the new mate's name"]
    # the prompts the official mates were made with, for any pronoun
    assert P.clip_prompt(P.CLIPS["wave"][1], "she") == (
        "She lifts a hand and gives a small friendly wave, then lowers it. Static camera. The plain gray background "
        "stays exactly the same. She ends in exactly the same pose as she starts.")
    assert P.face_prompt(P.STILLS["laugh"], "he").startswith(
        "Exactly the same picture as the reference: same pose, framing, hair, clothes and lighting. Change only his "
        "face: laughing happily with his eyes closed")
    assert "waist-up" in P.design_prompt("A knight.", redraw=False).lower()


def test_price_aggregation_reserve_cap_and_missing_quotes():
    b = _brief(preset="minimal")
    plan = PL.price(b, _quotes(b), balance=1000.0, credit_usd=0.033)
    assert plan["complete"] and plan["total"] == 80.5
    assert plan["reserve"] == pytest.approx(12.075) and plan["cap"] == pytest.approx(92.575)
    assert plan["balance_after"] == pytest.approx(919.5) and plan["usd"] == pytest.approx(2.66)
    lines = {ln["stage"]: ln for ln in plan["lines"]}
    assert lines["clips"]["unit"] == 9.0 and lines["clips"]["credits"] == 54.0
    assert plan["minutes"] > 20
    q = _quotes(b)
    q[PL.quote_key("kling_o3_flf", PL.clip_params(b))] = {"error": "invalid_params: start_image"}
    bad = PL.price(b, q)
    assert not bad["complete"] and bad["errors"] == ["kling_o3_flf: invalid_params: start_image"]
    assert bad["balance_after"] is None


# ---------------------------------------------------------------- the gate

def test_gate_confirm_and_spend():
    b = _brief(preset="minimal")
    doc = {"status": "estimate", "plan": PL.price(b, _quotes(b)), "confirmation": None, "extras": [],
           "ledger": {"committed": 0.0}}
    with pytest.raises(PL.GateError) as e:
        PL.check_spend(doc, 2.0)
    assert e.value.code == "not_confirmed"
    with pytest.raises(PL.GateError) as e:
        PL.confirm(doc, "plan_other", doc["plan"]["total"])
    assert e.value.code == "plan_changed"
    with pytest.raises(PL.GateError) as e:
        PL.confirm(doc, doc["plan"]["id"], doc["plan"]["total"] - 1)
    assert e.value.code == "total_mismatch"
    old = datetime.now(timezone.utc) + timedelta(minutes=31)
    with pytest.raises(PL.GateError) as e:
        PL.confirm(doc, doc["plan"]["id"], doc["plan"]["total"], now=old)
    assert e.value.code == "stale_quote"
    doc["confirmation"] = PL.confirm(doc, doc["plan"]["id"], doc["plan"]["total"])
    PL.check_spend(doc, 9.0)
    # a new plan replaces the confirmed one: spending stops
    other = dict(doc, plan={**doc["plan"], "id": "plan_new"})
    with pytest.raises(PL.GateError) as e:
        PL.check_spend(other, 1.0)
    assert e.value.code == "plan_changed"
    # the cap: total + reserve, nothing beyond
    doc["ledger"]["committed"] = doc["confirmation"]["cap"] - 1.0
    PL.check_spend(doc, 1.0)
    with pytest.raises(PL.GateError) as e:
        PL.check_spend(doc, 2.0)
    assert e.value.code == "over_cap"
    assert PL.redo_decision(doc, 2.0) == "confirm"
    x = PL.new_extra("a redo of clip:wave", [{"kind": "item", "key": "clip:wave", "credits": 10.0}])
    doc["extras"].append(x)
    with pytest.raises(PL.GateError):
        PL.confirm_extra(doc, x["id"], 9.0)
    PL.confirm_extra(doc, x["id"], 10.0)
    PL.check_spend(doc, 10.0)  # the extra raised the cap
    doc["paused"] = True
    with pytest.raises(PL.GateError) as e:
        PL.check_spend(doc, 1.0)
    assert e.value.code == "paused"


# ---------------------------------------------------------------- the runner (fake generator / processing)

class FakeGen:
    def __init__(self) -> None:
        self.created: list[tuple[str, list[str]]] = []
        self.waited: list[str] = []
        self.fail: dict[str, JobError] = {}
        self.hold: asyncio.Event | None = None

    def account_id(self):
        return "hf_test"

    def cli(self):
        return "/bin/true"

    async def balance(self):
        return {"credits": 500.0}

    async def credit_usd(self):
        return 0.033

    async def quote(self, jt, params, *, workdir, placeholders=None):
        return UNITS[jt]

    async def create(self, jt, flags, *, workdir):
        self.created.append((jt, flags))
        return {"id": f"job{len(self.created)}", "status": "queued"}

    async def wait(self, jid, *, workdir, timeout_s=1800):
        self.waited.append(jid)
        if self.hold is not None:
            await self.hold.wait()
        if jid in self.fail:
            raise self.fail[jid]
        return {"id": jid, "status": "completed", "results": {"raw": {"url": f"https://x/{jid}"}}}

    async def download(self, url, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"result " + url.encode())


class FakeDeps:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list[str]]] = []

    def ready(self):
        return True

    def status(self):
        return {"ready": True}

    async def run(self, step, args, *, timeout=0, check_ready=True, on_progress=None):
        self.calls.append((step, list(args)))
        p = Path(args[0]) if args else None
        if step == "thumb":
            Path(args[1]).parent.mkdir(parents=True, exist_ok=True)
            Path(args[1]).write_bytes(b"jpg")
        if step == "home":
            (p / "thumbs").mkdir(parents=True, exist_ok=True)
            (p / "thumbs" / "home.jpg").write_bytes(b"jpg")
            (p / "masters" / "home-gray.jpg").write_bytes(b"jpg")
        if step == "check":
            return {"clips": {}, "passed": True, "redo": []}
        if step == "export":
            exp = p / "export"
            exp.mkdir(parents=True, exist_ok=True)
            (exp / "neutral.webp").write_bytes(b"webp")
            (exp / "idle_a.lg.mp4").write_bytes(b"mp4")
            (exp / "rig.json").write_text(json.dumps({
                "aspect": [10, 12], "home": "asset:x/neutral.webp", "stills": {"neutral": "asset:x/neutral.webp"},
                "clips": [{"id": "idle_a", "kind": "idle", "src": "asset:x/idle_a.lg.mp4"}],
                "packing": "stacked-alpha"}))
            return {"stills": 1, "clips": 1}
        return {}


def _services(db, tmp_path, monkeypatch, gen=None, deps=None):
    fake = tmp_path / "claude"
    fake.write_text(f"#!{sys.executable}\n" + textwrap.dedent(FAKE).replace("__FAKE_DIR__", str(tmp_path)))
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: ClaudeCodeProvider(binary=str(fake)))
    monkeypatch.setattr(settings, "avatar_root", str(tmp_path / "avatars"))
    vault = SecretVault(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)))
    mates = MateService(svc, MateStore(db, vault))
    av = S.AvatarService(svc, mates, None, generator=gen or FakeGen(), deps=deps or FakeDeps())
    return svc, mates, av


async def _settle(av, pid, statuses=("waiting", "ready", "failed", "paused", "canceled"), timeout=10):
    for _ in range(int(timeout / 0.02)):
        await asyncio.sleep(0.02)
        if av.doc(pid)["status"] in statuses and pid not in av._runners:
            return av.doc(pid)
    raise AssertionError(f"stuck at {av.doc(pid)['status']} / {av.doc(pid).get('phase')}")


async def _ready_project(av, pid, events):
    ctx = {"project_id": pid, "session_id": av.doc(pid)["session_id"]}
    text, err, _ = await av.call_tool(ctx, "update_brief", {"patch": {
        "design": {"prompt": "A cheerful girl with short silver hair."}, "preset": "minimal", "candidates": 2,
        "target": {"mode": "new", "name": "Mina"}}})
    assert not err, text
    text, err, _ = await av.call_tool(ctx, "estimate", {})
    assert not err and "estimate card" in text, text
    return ctx


async def test_runner_state_machine(db, tmp_path, monkeypatch):
    svc, mates, av = _services(db, tmp_path, monkeypatch)
    events: list[tuple[str, str]] = []
    monkeypatch.setattr(av, "_event", lambda pid, kind, text: events.append((kind, text)))
    pid = av.create(language="ko")["id"]
    ctx = await _ready_project(av, pid, events)
    doc = av.doc(pid)
    assert doc["status"] == "estimate" and doc["plan"]["total"] == 2 * 2 + 0.5 + 6 * 2 + 6 * 10
    # nothing spends before the user's confirmation — not even the agent's redo
    text, err, _ = await av.call_tool(ctx, "regenerate", {"item": "design"})
    assert err and "not_confirmed" in text
    assert av.gen.created == []
    with pytest.raises(PL.GateError):
        await av.confirm(pid, doc["plan"]["id"], doc["plan"]["total"] + 1)
    assert av.gen.created == []
    await av.confirm(pid, doc["plan"]["id"], doc["plan"]["total"])
    # the brief is locked now
    text, err, _ = await av.call_tool(ctx, "update_brief", {"patch": {"aspect": "9:16"}})
    assert err and "locked" in text
    doc = await _settle(av, pid)
    assert doc["status"] == "waiting" and doc["checkpoint"]["stage"] == "pick"
    assert [jt for jt, _ in av.gen.created] == ["nano_banana_pro"] * 2
    assert all("--image-references" not in f and "Waist-up" in f[1] for _, f in av.gen.created)
    assert doc["ledger"]["committed"] == 4.0
    view = av.view(pid)
    assert [c["id"] for c in view["files"]["candidates"]] == ["c1", "c2"]
    await av.checkpoint(pid, "pick", candidate="c2")
    doc = await _settle(av, pid)
    assert doc["checkpoint"]["stage"] == "home"
    assert (av.dir(pid) / "masters" / "candidate.png").read_bytes() == (av.dir(pid) / "design" / "c2.png").read_bytes()
    jt, flags = av.gen.created[-1]
    assert jt == "image_background_remover" and flags[-1].endswith("masters/candidate.cutin.jpg")
    await av.checkpoint(pid, "approve")
    doc = await _settle(av, pid)
    assert doc["checkpoint"]["stage"] == "stills"
    stills = [f for jt, f in av.gen.created if jt == "nano_banana_pro" and "--image-references" in f]
    assert len(stills) == 6 and all(f[f.index("--image-references") + 1].endswith("candidate.ref.jpg") for f in stills)
    assert "Change only her face: a warm, gentle smile." in [f[1] for f in stills][0]
    await av.checkpoint(pid, "approve")
    doc = await _settle(av, pid)
    assert doc["status"] == "ready", doc.get("error")
    kl = [f for jt, f in av.gen.created if jt == "kling_o3_flf"]
    assert len(kl) == 6
    home = str(av.dir(pid) / "masters" / "home-gray.jpg")
    assert kl[0][kl[0].index("--start-image") + 1] == home == kl[0][kl[0].index("--end-image") + 1]
    assert kl[0][kl[0].index("--mode") + 1] == "pro" and kl[0][kl[0].index("--duration") + 1] == "5"
    assert len([1 for jt, _ in av.gen.created if jt == "video_background_remover"]) == 6
    steps = [s for s, _ in av.deps.calls if s != "thumb"]
    assert steps == ["prep", "home", "stills", *["matte"] * 6, "encode", "check", "export"]
    assert doc["ledger"]["committed"] == doc["plan"]["total"]
    assert av.view(pid)["preview"]["kind"] == "video"
    # a redo of one clip inside the cap: only that clip + its matte again, then encode → check → export
    n = len(av.gen.created)
    res = await av.user_redo(pid, "clip:talk_a")
    assert res["result"]["started"] and res["result"]["credits"] == 10.0
    doc = await _settle(av, pid, ("ready",))
    assert [jt for jt, _ in av.gen.created[n:]] == ["kling_o3_flf", "video_background_remover"]
    assert doc["reencode"] == []
    # a redo past the cap needs the user's OK (an extra), and the gate holds until then
    doc["ledger"]["committed"] = PL.cap(doc)
    res = await av.call_tool(ctx, "regenerate", {"item": "still:smile"})
    assert "card to confirm" in res[0]
    x = av.doc(pid)["extras"][-1]
    assert x["status"] == "pending" and x["total"] == 2.0
    n = len(av.gen.created)
    await av.confirm_extra(pid, x["id"], 2.0)
    await _settle(av, pid, ("ready",))
    assert [jt for jt, _ in av.gen.created[n:]] == ["nano_banana_pro"]


async def test_apply_backup_restore_and_new_mate(db, tmp_path, monkeypatch):
    svc, mates, av = _services(db, tmp_path, monkeypatch)
    monkeypatch.setattr(av, "_event", lambda *a: None)
    mate = mates.create({"name": "Mina"})
    # her current avatar: an imported pack (applying a new one removes that folder; the backup keeps a copy)
    pack = tmp_path / "oldpack"
    pack.mkdir()
    (pack / "neutral.webp").write_bytes(b"old")
    (pack / "rig.json").write_text(json.dumps({"stills": {"neutral": "neutral.webp"}, "home": "neutral.webp"}))
    old = mate_files.import_folder_pack(mate["id"], pack)
    mates.update(mate["id"], {"avatar": old})
    pid = av.create(mate_id=mate["id"])["id"]
    doc = av.doc(pid)
    assert doc["brief"]["target"] == {"mode": "existing", "mate_id": mate["id"], "name": "Mina"}
    await av.deps.run("export", [str(av.dir(pid))])
    doc["status"] = "ready"
    av.save(doc)
    out = await av.apply(pid, mate_id=mate["id"])
    assert out["mate"]["avatar"]["kind"] == "video"
    assert out["mate"]["avatar"]["rig"]["clips"][0]["src"].startswith(f"/api/mates/{mate['id']}/assets/pack-")
    old_dir = next(iter(mate_files.import_dirs_of(old, mate["id"])))
    assert not (mate_files.assets_dir(mate["id"]) / old_dir).exists()
    out = await av.restore(pid)
    assert out["mate"]["avatar"] == old
    assert (mate_files.assets_dir(mate["id"]) / old_dir / "neutral.webp").read_bytes() == b"old"
    out = await av.apply(pid, new_name="Nova")
    assert out["mate"]["name"] == "Nova" and out["mate"]["avatar"]["kind"] == "video"


async def test_pause_cancel_and_resume_after_restart(db, tmp_path, monkeypatch):
    gen = FakeGen()
    svc, mates, av = _services(db, tmp_path, monkeypatch, gen=gen)
    monkeypatch.setattr(av, "_event", lambda *a: None)
    pid = av.create()["id"]
    await _ready_project(av, pid, [])
    doc = av.doc(pid)
    gen.hold = asyncio.Event()
    await av.confirm(pid, doc["plan"]["id"], doc["plan"]["total"])
    for _ in range(100):
        await asyncio.sleep(0.02)
        if len(gen.waited) == 2:
            break
    assert len(gen.created) == 2  # both candidates submitted, ids saved, waiting
    items = av.doc(pid)["items"]
    assert {it["job_id"] for it in items.values()} == {"job1", "job2"}
    # a restart now: the runner is gone, the document says running with job ids
    av._runners[pid].cancel()
    await asyncio.sleep(0.05)
    gen2 = FakeGen()
    av2 = S.AvatarService(svc, mates, None, generator=gen2, deps=FakeDeps())
    monkeypatch.setattr(av2, "_event", lambda *a: None)
    av2.store._cache.clear()
    await av2.start()
    doc = await _settle(av2, pid)
    assert doc["checkpoint"]["stage"] == "pick"
    assert gen2.created == [] and sorted(gen2.waited) == ["job1", "job2"]  # waited for, never paid twice
    assert doc["ledger"]["committed"] == 4.0
    # pause: no new job starts
    await av2.checkpoint(pid, "pick", candidate="c1")
    av2.pause(pid)
    doc = await _settle(av2, pid, ("paused",))
    assert gen2.created == []
    av2.resume(pid)
    doc = await _settle(av2, pid)
    assert doc["checkpoint"]["stage"] == "home" and len(gen2.created) == 1
    av2.cancel(pid)
    assert av2.doc(pid)["status"] == "canceled"
    with pytest.raises(Exception):
        av2.resume(pid)


async def test_failures_retries_refusals_and_the_cap(db, tmp_path, monkeypatch):
    gen = FakeGen()
    svc, mates, av = _services(db, tmp_path, monkeypatch, gen=gen)
    monkeypatch.setattr(av, "_event", lambda *a: None)
    monkeypatch.setattr(S.asyncio, "sleep", _fast_sleep)
    pid = av.create()["id"]
    await _ready_project(av, pid, [])
    doc = av.doc(pid)
    gen.fail = {"job1": JobError("Higgsfield: nsfw", code="nsfw", retry=False),
                "job2": JobError("Higgsfield: failed", code="failed")}
    await av.confirm(pid, doc["plan"]["id"], doc["plan"]["total"])
    doc = await _settle(av, pid)
    items = doc["items"]
    assert items["design:c1"]["status"] == "failed" and items["design:c1"]["tries"] == 1  # refused: no retry
    assert items["design:c2"]["status"] == "done" and items["design:c2"]["tries"] == 2  # failed once, retried
    assert doc["ledger"]["committed"] == 6.0  # every try counts (Higgsfield may refund failed ones)
    # the cap holds even for retries: with no room, the run stops and asks
    await av.checkpoint(pid, "pick", candidate="c2")
    d = av.doc(pid)
    d["ledger"]["committed"] = PL.cap(d)
    av.save(d)
    doc = await _settle(av, pid)
    assert doc["status"] == "waiting" and doc["checkpoint"]["stage"] == "cap"
    assert doc["extras"][-1]["status"] == "pending" and doc["extras"][-1]["total"] == 0.5
    assert [jt for jt, _ in gen.created].count("image_background_remover") == 0
    await av.confirm_extra(pid, doc["extras"][-1]["id"], 0.5)
    doc = await _settle(av, pid)
    assert doc["checkpoint"]["stage"] == "home"


_real_sleep = asyncio.sleep


async def _fast_sleep(t, *a, **k):
    await _real_sleep(min(t, 0.01))


# ---------------------------------------------------------------- the engine, the bridge, the internal route

async def test_agent_engine_is_sealed_with_only_avatar_tools(db, tmp_path, monkeypatch):
    svc, mates, av = _services(db, tmp_path, monkeypatch)
    monkeypatch.setattr(S, "EVENT_DELAY_S", 0.05)
    pid = av.create(language="ko")["id"]
    sid = av.doc(pid)["session_id"]
    assert svc.get(sid)["kind"] == "avatar" and sid not in [s["id"] for s in svc.list_all()]
    q = svc.subscribe(sid)
    await _until(q, lambda m: m["type"] == "run.state" and not m["data"]["running"], timeout=20)
    calls = [json.loads(line) for line in open(tmp_path / "calls.log")]
    argv = calls[-1]["argv"]
    assert argv[argv.index("--tools") + 1] == ""
    assert argv[argv.index("--allowedTools") + 1] == "mcp__avatar"
    assert "--disable-slash-commands" in argv and "--strict-mcp-config" in argv
    prompt = open(argv[argv.index("--system-prompt-file") + 1], encoding="utf-8").read()
    assert "Avatar Create agent" in prompt and "Always reply in Korean" in prompt
    cfg = json.load(open(argv[argv.index("--mcp-config") + 1]))
    env = cfg["mcpServers"]["avatar"]["env"]
    assert env["HRH_AVATAR_PROJECT"] == pid and av.token_info(env["HRH_AVATAR_TOKEN"])["project_id"] == pid
    msgs = svc.messages(sid)
    assert msgs[0]["role"] == "user" and "avatar_event" in msgs[0]["content"]
    assert json.loads(msgs[0]["meta"] or "{}").get("kind") == "avatar_event" if isinstance(msgs[0].get("meta"), str) \
        else (msgs[0].get("meta") or {}).get("kind") == "avatar_event"


def test_bridge_lists_the_avatar_tools():
    proc = subprocess.Popen([sys.executable, "-I", mcp_bridge.__file__], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            text=True, env={"PATH": os.environ.get("PATH", ""), "HRH_AVATAR_API": "http://127.0.0.1:9",
                                            "HRH_AVATAR_TOKEN": "t"})

    def rpc(m):
        proc.stdin.write(json.dumps(m) + "\n")
        proc.stdin.flush()
        return json.loads(proc.stdout.readline()) if "id" in m else None
    try:
        init = rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
        assert init["result"]["serverInfo"]["name"] == "avatar"
        names = [t["name"] for t in rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]]
        assert names == ["get_project", "ask_user", "update_brief", "update_mate_draft", "use_reference", "estimate", "look",
                         "regenerate", "extend", "pause", "resume", "cancel"]
        r = rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "get_project", "arguments": {}}})
        assert r["result"]["isError"] is True and "unreachable" in r["result"]["content"][0]["text"]
    finally:
        proc.stdin.close()
        proc.wait(timeout=5)


def test_internal_route_needs_the_avatar_token(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        r = c.post("/api/internal/avatar/call", json={"name": "get_project", "arguments": {}})
        assert r.status_code in (401, 404)
        r = c.post("/api/internal/avatar/call", json={"name": "get_project"}, headers={"X-Avatar-Token": "nope"})
        assert r.status_code in (401, 404)
        # and the user's routes need the login
        assert c.get("/api/avatar/projects").status_code == 401


# ---------------------------------------------------------------- the real CLI path (a fake higgsfield binary)

@pytest.mark.skipif(not (MASTERS / "chaerin" / "masters" / "clips").is_dir(), reason="official masters not here")
async def test_generator_runs_the_cli_with_access_only_credentials(tmp_path, monkeypatch):
    files = tmp_path / "files"
    files.mkdir()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(_Quiet, directory=str(files)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    home = tmp_path / "home"
    home.mkdir()
    (home / ".fake-higgsfield.json").write_text(json.dumps({
        "masters": str(MASTERS), "files_dir": str(files), "files_url": f"http://127.0.0.1:{srv.server_address[1]}",
        "delay": 0.1, "log": str(tmp_path / "jobs.jsonl")}))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr("app.avatar.generator.find_cli", lambda: str(FAKE_HF))

    class Svc:
        def default_id(self):
            return "hf_1"

        async def access_token(self, aid, keep=None):
            return {"access": "oat_ACCESS_ONLY", "refresh": "rt_SECRET"}

        def _row(self, aid):
            return {"info": {"workspace_id": "ws1"}}

    gen = Generator(Svc())
    work = tmp_path / "proj"
    (work / "masters").mkdir(parents=True)
    shutil.copyfile(MASTERS / "chaerin" / "masters" / "candidate.png", work / "masters" / "candidate.png")
    shutil.copyfile(MASTERS / "chaerin" / "masters" / "home-gray.jpg", work / "masters" / "home-gray.jpg")
    seen = {}
    real_env = gen._env

    async def spy(workdir):
        env, d = await real_env(workdir)
        seen["creds"] = json.loads((d / "credentials.json").read_text())
        seen["env"] = env
        return env, d
    gen._env = spy
    job = await gen.create("kling_o3_flf", ["--prompt", P.clip_prompt(P.CLIPS["wave"][1], "she"), "--start-image",
                                            str(work / "masters/home-gray.jpg"), "--end-image",
                                            str(work / "masters/home-gray.jpg")], workdir=work)
    assert seen["creds"] == {"auth_version": 2, "access_token": "oat_ACCESS_ONLY", "token_type": "bearer",
                             "scope": seen["creds"]["scope"]}  # never the refresh token
    assert seen["env"]["HIGGSFIELD_CREDENTIALS_PATH"].startswith(str(work / ".hf"))  # never the user's own login
    done = await gen.wait(job["id"], workdir=work)
    await gen.download(result_url(done), work / "clips" / "wave.mp4")
    assert (work / "clips" / "wave.mp4").read_bytes() == (MASTERS / "chaerin/masters/clips/wave.mp4").read_bytes()
    assert not any((work / ".hf").iterdir())  # the token never stays on disk
    log = [json.loads(x) for x in (tmp_path / "jobs.jsonl").read_text().splitlines()]
    assert [x["job_type"] for x in log] == ["kling_o3_flf"]
    assert await gen.cli_cost("kling_o3_flf", {"mode": "pro"}, {}, workdir=work) == 9.0


class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


# ---------------------------------------------------------------- the real processing (needs the venv)

def _venv() -> Path | None:
    for c in (os.environ.get("AVATAR_TEST_VENV"), os.path.expanduser("~/.cache/hrh-avatar-venv")):
        if c and (Path(c) / "bin" / "python").is_file() and (Path(c) / "ready.json").is_file():
            return Path(c)
    return None


needs_venv = pytest.mark.skipif(_venv() is None, reason="no avatar processing venv (AVATAR_TEST_VENV)")


@needs_venv
def test_the_pipeline_finds_her_face_across_her_stills_even_when_one_picture_fools_it(tmp_path):
    bundled = S.Path(S.__file__).parents[1] / "mate" / "builtin" / "assets" / "chaerin" / "outfits" / "gray-band-2"
    rig = json.loads((bundled / "rig.json").read_text())
    rig.pop("frame", None)
    (tmp_path / "rig.json").write_text(json.dumps(rig))
    for path in bundled.glob("*.webp"):
        (tmp_path / path.name).write_bytes(path.read_bytes())
    r = subprocess.run([str(_venv() / "bin" / "python"), "-I", str(S.Path(S.__file__).with_name("pipeline.py")), "frame", str(tmp_path)],
                       capture_output=True, text=True, timeout=120)
    res = json.loads(r.stdout.strip().splitlines()[-1])
    assert res["ok"], res
    cx, cy, h = res["frame"]["face"]
    assert res["frame"]["how"] == "face" and res["frame"]["for"] == "neutral.webp"
    assert 0.48 < cx < 0.56 and 0.24 < cy < 0.33 and 0.27 < h < 0.34  # (neutral alone gets her chest: cy 0.52)
    assert len(res["frame"]["outline"]) == 3  # (for comparing with a set that has only that)
    assert json.loads((tmp_path / "rig.json").read_text())["frame"] == res["frame"]


@needs_venv
def test_alpha_recovery_on_a_synthetic_frame():
    r = subprocess.run([str(_venv() / "bin" / "python"), "-I", str(S.Path(S.__file__).with_name("pipeline.py")),
                        "selftest", str(S.Path(S.__file__).parents[1] / "mate" / "builtin" / "assets")],
                       capture_output=True, text=True, timeout=240)
    res = json.loads(r.stdout.strip().splitlines()[-1])
    assert res["ok"], res
    assert res["bg"] == pytest.approx([213, 212, 217], abs=1.0)
    # (a stray pixel where two parts meet may dip before solidify; what ships is solid)
    assert res["alpha_inside_mean"] > 0.995 and res["alpha_inside_min"] > 0.85 and res["alpha_shipped_inside_min"] > 0.99
    assert res["fold_alpha_min"] > 0.9  # the remover's crack along a dark fold is closed
    assert res["alpha_edge_mae"] < 0.3 and res["colour_mae"] < 3.0
    assert res["gap_alpha_max"] < 0.1 and res["strand_alpha_mean"] > 0.5  # the gray between hair and a loose strand
    assert res["light_patch_alpha_min"] > 0.9 and res["deep_patch_alpha_min"] > 0.9  # body in the gray's colour stays
    assert res["strand_shown_mean"] > 0.5  # a fine strand isn't eaten away at the edge
    # real art, black hair, silver hair, pink hair: what is solid stays, what the remover covered opens
    assert set(res["art"]) == {"chaerin", "estelle", "seoa"}
    for who, m in res["art"].items():
        assert m["lost"] < 1 and m["opened"] > 30, (who, m)
    assert res["wall_changed"] == 0  # not on one flat colour: the picture says nothing about the background
    assert res["thumb_page"] == pytest.approx([22, 46, 72], abs=6)  # judged on a page where the gray would show


@needs_venv
async def test_pipeline_end_to_end_on_a_synthetic_clip_loads_as_a_video_avatar(tmp_path, monkeypatch):
    """prep → home → stills → matte → encode → check → export on synthetic inputs (a figure on the known gray, its
    'remover' results), then the export loads as a video avatar of the stacked-alpha kind."""
    from app.avatar.deps import Deps

    monkeypatch.setattr(settings, "avatar_venv", str(_venv()))
    monkeypatch.setattr(settings, "avatar_root", str(tmp_path))
    py = str(_venv() / "bin" / "python")
    p = tmp_path / "av_000000000001"
    (p / "masters").mkdir(parents=True)
    (p / "stills").mkdir()
    (p / "clips").mkdir()
    subprocess.run([py, "-I", str(Path(__file__).with_name("avatar_synth.py")), str(p)], check=True, timeout=300)
    (p / "pipeline.json").write_text(json.dumps({"aspect": "1:1", "sizes": {"lg": 360, "sm": 180},
                                                 "stills": ["smile"], "clips": [{"id": "idle_a", "kind": "idle"}]}))
    deps = Deps()
    for step, args in (("prep", []), ("home", []), ("stills", []), ("matte", ["idle_a"]), ("encode", []),
                       ("check", []), ("export", ["avatar-t"])):
        res = await deps.run(step, [str(p), *args], timeout=600)
    chk = json.loads((p / "check.json").read_text())
    assert chk["clips"]["idle_a"]["seam"] < 3 and chk["clips"]["idle_a"]["drift"] < 10
    rig = json.loads((p / "export" / "rig.json").read_text())
    assert rig["packing"] == "stacked-alpha" and rig["clips"][0]["src"] == "asset:avatar-t/idle_a.lg.mp4"
    avatar = mate_files.rig_avatar(rig, p / "export", lambda rel: f"/x/{rel}")
    assert avatar["kind"] == "video" and avatar["rig"]["packing"] == "stacked-alpha"
    assert set(avatar["rig"]["stills"]) == {"neutral", "smile"} and avatar["rig"]["home"] == "/x/neutral.webp"
    assert res["clips"] == 1


def test_cli_create_answer_with_a_bare_job_id_is_a_job():
    """`higgsfield generate create --json` answers ["<uuid>"]: that is the new job's id, not "no job id"
    (taking it for a failure retried — and paid — every candidate three times)."""
    from app.avatar.generator import _first, job_id

    assert job_id(_first(["bed76c68-013a-4764-a697-a4f17065862e"])) == "bed76c68-013a-4764-a697-a4f17065862e"
    assert job_id(_first({"id": "x1", "status": "queued"})) == "x1"
    assert job_id(_first([{"job_id": "x2"}])) == "x2"
    assert _first([]) == {} and _first(["  "]) == {}


def test_resume_rejoins_jobs_higgsfield_ran_and_retries_the_rest(db, tmp_path, monkeypatch):
    """Resume = try again: a candidate whose job Higgsfield did run (its id in the old "no job id: [\\"<uuid>\\"]"
    error) is only waited for (no new submission, no credits); another failed item gets fresh tries; a refused one
    stays failed."""
    _svc, _mates, av = _services(db, tmp_path, monkeypatch)
    uid = "b4affccc-8938-4135-9683-f498043abc43"
    doc = {"id": "av_0123456789ab", "items": {
        "design:c1": {"status": "failed", "tries": 3, "job_id": None, "error": f'Higgsfield gave no job id: ["{uid}"]'},
        "design:c2": {"status": "failed", "tries": 3, "job_id": None, "error": "the job took too long"},
        "design:c3": {"status": "failed", "tries": 1, "job_id": None, "error": "nsfw", "refused": True},
        "design:c4": {"status": "done", "tries": 1, "job_id": "x"},
    }}
    av._revive_failed(doc)
    it = doc["items"]
    assert it["design:c1"]["status"] == "running" and it["design:c1"]["job_id"] == uid and it["design:c1"]["tries"] == 3
    assert it["design:c2"]["status"] == "pending" and it["design:c2"]["tries"] == 0
    assert it["design:c3"]["status"] == "failed"
    assert it["design:c4"]["status"] == "done"


async def test_a_redo_at_a_checkpoint_runs(db, tmp_path, monkeypatch):
    """While a checkpoint waits for the user (status "waiting"), a redo inside the cap must start, not only say so."""
    _, _, av = _services(db, tmp_path, monkeypatch)
    events: list[tuple[str, str]] = []
    monkeypatch.setattr(av, "_event", lambda pid, kind, text: events.append((kind, text)))
    pid = av.create(language="ko")["id"]
    await _ready_project(av, pid, events)
    plan = av.doc(pid)["plan"]
    await av.confirm(pid, plan["id"], plan["total"])
    assert (await _settle(av, pid, ("waiting",)))["checkpoint"]["stage"] == "pick"
    n = len(av.gen.created)
    res = await av.user_redo(pid, "design")
    assert res["result"]["started"]
    doc = await _settle(av, pid, ("waiting",))
    assert [jt for jt, _ in av.gen.created[n:]] == ["nano_banana_pro"] * 2
    assert doc["checkpoint"]["stage"] == "pick"
    assert sorted(k for k in doc["items"] if k.startswith("design:")) == [f"design:c{i}" for i in range(1, 5)]


async def test_a_candidate_with_one_thing_changed(db, tmp_path, monkeypatch):
    """"Number 2 without the headset": the model gets candidate 2 itself and only the change; one picture, so it runs at
    once. A request past the cap waits on a card, a newer one replaces it, and the OK brings the checkpoint back."""
    _, _, av = _services(db, tmp_path, monkeypatch)
    events: list[tuple[str, str]] = []
    monkeypatch.setattr(av, "_event", lambda pid, kind, text: events.append((kind, text)))
    pid = av.create(language="ko")["id"]
    ctx = await _ready_project(av, pid, events)
    plan = av.doc(pid)["plan"]
    await av.confirm(pid, plan["id"], plan["total"])
    await _settle(av, pid, ("waiting",))
    # the brief stays locked, and the refusal says what to do instead
    text, err, _ = await av.call_tool(ctx, "update_brief", {"patch": {"design": {"prompt": "No headset."}}})
    assert err and "regenerate with item design" in text
    for args in ({"item": "design", "from": "c9", "note": "x"}, {"item": "design", "from": "c2"},
                 {"item": "home", "from": "c2", "note": "x"}):
        assert (await av.call_tool(ctx, "regenerate", args))[1], args
    n = len(av.gen.created)
    text, err, _ = await av.call_tool(ctx, "regenerate", {"item": "design", "from": "c2", "note": "Remove the headset."})
    assert not err and "Redoing" in text, text
    doc = await _settle(av, pid, ("waiting",))
    assert doc["checkpoint"]["stage"] == "pick" and "design:c3" in doc["items"] and "design:c4" not in doc["items"]
    [(jt, flags)] = av.gen.created[n:]
    assert jt == "nano_banana_pro" and flags[flags.index("--image-references") + 1].endswith("c2-flat.jpg")
    prompt = flags[flags.index("--prompt") + 1]
    assert prompt.endswith("Change only this: Remove the headset.") and "Waist-up" not in prompt
    assert ("flatten", [str(av.dir(pid) / "design/c2.png"), str(av.dir(pid) / "ref/c2-flat.jpg")]) in av.deps.calls
    # past the cap: a card; a newer request replaces it; the OK runs that one and comes back to the checkpoint
    doc["ledger"]["committed"] = PL.cap(doc)
    av.save(doc)
    await av.call_tool(ctx, "regenerate", {"item": "design", "note": "first try"})
    await av.call_tool(ctx, "regenerate", {"item": "design", "from": "c1", "note": "Shorter sleeves."})
    first, second = av.doc(pid)["extras"][-2:]
    assert first["status"] == "declined" and second["status"] == "pending" and second["total"] == 2.0
    n = len(av.gen.created)
    await av.confirm_extra(pid, second["id"], second["total"])
    doc = await _settle(av, pid, ("waiting",))
    assert doc["checkpoint"]["stage"] == "pick"
    [(_, flags)] = av.gen.created[n:]
    assert flags[flags.index("--image-references") + 1].endswith("c1-flat.jpg")
