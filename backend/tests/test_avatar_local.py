"""The avatar maker's stages on this machine's GPU (app/avatar/local.py, Image Studio): the plan (no credits, no
quotes, the time it takes here), the choice per stage, a run with no Higgsfield at all, and the image jobs each stage
asks for — the same files the hosted jobs make."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.avatar import plan as PL
from app.avatar import presets as P
from app.avatar.local import clip_box, draft_prompt
from app.imagehost.service import AVATAR_STAGES
from tests.test_avatar import UNITS, FakeGen, _brief, _ready_project, _services, _settle


class NoHiggsfield(FakeGen):
    def account_id(self):
        return None

    def cli(self):
        return None


class FakeImages:
    """the image host as the avatar maker sees it"""

    def __init__(self, root: Path, uses=("draft", "edit", "cutout", "loop")) -> None:
        self.root, self.uses = root, set(uses)
        self.jobs: list[tuple[str, dict, dict, str]] = []
        self.fail: set[int] = set()
        self.hold = False

    def avatar_engines(self, lang: str = "en"):
        return {"available": True, "stages": {st: {"ready": use in self.uses, "model": "m" if use in self.uses else "",
                                                   "default": "local" if use in self.uses else "higgsfield"}
                                              for st, use in AVATAR_STAGES.items()}}

    def usable(self, use: str) -> bool:
        return use in self.uses

    def submit(self, kind, *, inputs, params, source):
        self.jobs.append((kind, inputs, params, source))
        return {"id": f"img{len(self.jobs)}"}

    async def wait(self, jid):
        n = int(jid[3:])
        kind = self.jobs[n - 1][0]
        if n in self.fail:
            return {"id": jid, "kind": kind, "state": "failed", "error": "[failed] boom"}
        return {"id": jid, "kind": kind, "state": "done"}

    def job(self, jid):
        return {"id": jid, "state": "queued" if int(jid[3:]) == len(self.jobs) and self.hold else "done"}

    def job_file(self, jid, name):
        p = self.root / jid / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(f"{jid}/{name}".encode())
        return p


ALL_LOCAL = {s: "local" for s in PL.STAGES}


def test_a_local_stage_costs_nothing_is_not_quoted_and_takes_its_measured_time():
    b = _brief()
    hosted = PL.price(b, {k: UNITS[jt] for k, jt, _ in PL.quote_requests(PL.jobs_for(b))})
    jobs = PL.jobs_for(b, ALL_LOCAL)
    assert [j["job_type"] for j in jobs] == ["local:design", "local:cutout", "local:edit", "local:loop", "local:matte"]
    assert PL.quote_requests(jobs) == []
    plan = PL.price(b, {}, engines=ALL_LOCAL)
    assert plan["complete"] and plan["total"] == 0 and plan["cap"] == 0
    assert set(plan["engines"].values()) == {"local"}
    assert plan["minutes"] > hosted["minutes"]  # (one GPU, one job at a time)
    mixed = {"design": "local"}
    q = {k: UNITS[jt] for k, jt, _ in PL.quote_requests(PL.jobs_for(b, mixed))}
    plan = PL.price(b, q, engines=mixed)
    assert plan["engines"]["design"] == "local" and plan["engines"]["clips"] == "higgsfield"
    assert plan["total"] == round(hosted["total"] - 4 * UNITS["nano_banana_pro"], 4)


def test_the_draft_prompt_and_where_a_clip_crops(tmp_path):
    assert draft_prompt("A girl.", "she").startswith("1girl, solo, upper body")
    assert draft_prompt("A boy.", "he").startswith("1boy")
    m = tmp_path / "masters"
    m.mkdir()
    from PIL import Image

    Image.new("RGBA", (400, 800)).save(m / "home.png")
    (m / "place.json").write_text('{"canvas": [1080, 1080], "scale": 1.1, "x": 320, "y": 200}')
    box = clip_box(tmp_path)
    assert box[0] < 320 and box[1] < 200 and box[3] == 1080 and box[2] < 1080
    Image.new("RGBA", (800, 800)).save(m / "home.png")
    (m / "place.json").write_text('{"canvas": [1080, 1080], "scale": 1.35, "x": 0, "y": 0}')
    assert clip_box(tmp_path) is None  # (she fills the canvas)


async def test_a_run_on_this_machine_needs_no_higgsfield(db, tmp_path, monkeypatch):
    svc, mates, av = _services(db, tmp_path, monkeypatch, gen=NoHiggsfield())
    av.images = FakeImages(tmp_path / "img")
    monkeypatch.setattr(av, "_event", lambda *a: None)
    pid = av.create(language="ko")["id"]
    await _ready_project(av, pid, [])
    doc = av.doc(pid)
    assert doc["plan"]["total"] == 0 and set(doc["plan"]["engines"].values()) == {"local"}
    assert av._summary(doc)["plan"]["engines"]["clips"] == "local"
    await av.confirm(pid, doc["plan"]["id"], 0)
    doc = await _settle(av, pid)
    assert doc["checkpoint"]["stage"] == "pick"
    drafts = av.images.jobs
    assert [k for k, *_ in drafts] == ["draft", "draft"]
    assert drafts[0][1]["prompt"].startswith("1girl, solo") and "Waist-up" in drafts[0][1]["prompt"]
    assert drafts[0][3] == f"avatar:{pid}" and drafts[0][2]["width"] == 864
    assert (av.dir(pid) / "design" / "c1.png").read_bytes() == b"img1/1.png"
    await av.checkpoint(pid, "pick", candidate="c1")
    doc = await _settle(av, pid)
    kind, inputs, *_ = av.images.jobs[-1]
    assert kind == "cutout" and inputs["image"].endswith("masters/candidate.cutin.jpg")
    assert (av.dir(pid) / "masters" / "candidate.cut.png").read_bytes().endswith(b"/cut.png")
    await av.checkpoint(pid, "approve")
    doc = await _settle(av, pid)
    edits = [(i, p) for k, i, p, _ in av.images.jobs if k == "edit"]
    assert len(edits) == len(doc["brief"]["stills"]) and edits[0][1]["match"] is True
    assert edits[0][0]["image"].endswith("candidate.ref.jpg") and "Change only her face" in edits[0][0]["prompt"]
    await av.checkpoint(pid, "approve")
    doc = await _settle(av, pid)
    assert doc["status"] == "ready", doc.get("error")
    loops = [(i, p) for k, i, p, _ in av.images.jobs if k == "loop"]
    mattes = [i for k, i, _p, _ in av.images.jobs if k == "matte"]
    assert len(loops) == len(mattes) == len(doc["brief"]["clips"])
    assert loops[0][0]["image"].endswith("masters/home-gray.jpg") and loops[0][1]["seconds"] in (3, 4, 5)
    assert mattes[0]["clip"].endswith(".mp4")
    assert av.gen.created == [] and doc["ledger"]["committed"] == 0


async def test_the_engine_per_stage_is_the_users_and_only_where_it_can_run(db, tmp_path, monkeypatch):
    svc, mates, av = _services(db, tmp_path, monkeypatch)
    av.images = FakeImages(tmp_path / "img", uses=("draft", "cutout"))  # (no edit or loop model installed)
    monkeypatch.setattr(av, "_event", lambda *a: None)
    pid = av.create(language="ko")["id"]
    await _ready_project(av, pid, [])
    eng = av.doc(pid)["plan"]["engines"]
    assert eng["design"] == eng["home"] == eng["matte"] == "local" and eng["stills"] == eng["clips"] == "higgsfield"
    view = await av.set_engines(pid, {"design": "higgsfield", "clips": "local"})
    eng = view["plan"]["engines"]
    assert eng["design"] == "higgsfield" and eng["clips"] == "higgsfield"  # (clips: no model here)
    assert view["plan"]["total"] > 0
    # a stage that can't run here any more is refused at Confirm, before anything is spent
    doc = av.doc(pid)
    av.images.uses = set()
    with pytest.raises(PL.GateError) as e:
        await av.confirm(pid, doc["plan"]["id"], doc["plan"]["total"])
    assert e.value.code == "local_unavailable"


async def test_a_failed_local_job_is_retried_then_reported(db, tmp_path, monkeypatch):
    svc, mates, av = _services(db, tmp_path, monkeypatch, gen=NoHiggsfield())
    av.images = FakeImages(tmp_path / "img")
    av.images.fail = {1}
    events = []
    monkeypatch.setattr(av, "_event", lambda pid, kind, text: events.append((kind, text)))
    monkeypatch.setattr("app.avatar.service.asyncio.sleep", _no_sleep)
    pid = av.create(language="ko")["id"]
    await _ready_project(av, pid, [])
    doc = av.doc(pid)
    await av.confirm(pid, doc["plan"]["id"], 0)
    doc = await _settle(av, pid)
    assert doc["items"]["design:c1"]["tries"] == 2 and doc["items"]["design:c1"]["status"] == "done"


_real_sleep = __import__("asyncio").sleep


async def _no_sleep(t):
    await _real_sleep(0 if t > 1 else t)


def test_presets_keep_their_clip_lengths_for_the_local_minutes():
    b = _brief()
    clips = next(j for j in PL.jobs_for(b, ALL_LOCAL) if j["stage"] == "clips")
    assert clips["seconds"] == sum(P.clip_seconds(c) for c in b["clips"])


async def test_a_local_job_waiting_for_the_gpu_shows_as_waiting(db, tmp_path, monkeypatch):
    svc, mates, av = _services(db, tmp_path, monkeypatch, gen=NoHiggsfield())
    av.images = FakeImages(tmp_path / "img")
    pid = av.create(language="ko")["id"]
    doc = av.doc(pid)
    av.images.jobs = [("loop", {}, {}, "avatar:x")] * 2
    av.images.hold = True
    doc["items"]["clip:a"] = {"key": "clip:a", "stage": "clips", "job_type": "local:loop", "status": "running",
                              "job_id": "img1", "tries": 1, "credits": 0}
    doc["items"]["clip:b"] = {"key": "clip:b", "stage": "clips", "job_type": "local:loop", "status": "running",
                              "job_id": "img2", "tries": 1, "credits": 0}
    av.save(doc)
    items = av.view(pid)["items"]
    assert not items["clip:a"].get("gpu_queued") and items["clip:b"]["gpu_queued"]
    assert "gpu_queued" not in av.doc(pid)["items"]["clip:b"]  # (shown, never stored)
