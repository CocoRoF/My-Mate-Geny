"""Image Studio's engine host (app/imagehost): who may run it, the catalog, the graphs, installing, the jobs through
the stand-in engine and their finishing, and sharing the GPU with the voice models."""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.imagehost import catalog, gate as G, graphs as Gr, media
from app.imagehost.installer import Installer
from app.imagehost.service import AVATAR_STAGES, ImageError, ImageHost
from app.imagehost.settings import ImageSettings
from app.voicehost import system

GiB = 1 << 30
CAN_ENCODE = importlib.util.find_spec("av") is not None or media._ffmpeg() is not None


def _gpu(total_gb: float = 12, used_gb: float = 0.5, driver: str = "580.159.03", cap: str = "12.0") -> system.Gpu:
    total, used = int(total_gb * GiB), int(used_gb * GiB)
    return system.Gpu(0, "Test GPU", total, used, total - used, 0, driver, cap)


def base_picture(path: Path, size: int = 256) -> Path:
    """a figure on the flat gray the avatar pictures use"""
    im = Image.new("RGB", (size, size), (213, 212, 217))
    px = im.load()
    for y in range(size // 4, size):
        for x in range(size // 3, 2 * size // 3):
            px[x, y] = (30, 30, 36)
    im.save(path)
    return path


@pytest.fixture()
def ims(tmp_path: Path) -> ImageSettings:
    s = ImageSettings(home=tmp_path / "image", engine_mode="fake", idle_stop_seconds=0)
    s.ensure_dirs()
    return s


@pytest.fixture()
async def ih(db, ims):
    h = ImageHost(db, ims)
    h.engine.delay = 0.0
    await h.start()
    yield h
    await h.stop()


async def installed(h: ImageHost, *ids: str) -> None:
    for mid in ids:
        h.install(mid, accept_license=True)
        await h.installer._tasks[mid]


# ---- who may run it ----

def test_the_gate_wants_a_cuda_13_driver_and_a_turing_or_newer_gpu(monkeypatch):
    monkeypatch.setattr(system, "platform_key", lambda: "linux-x86_64")
    for gpu, code in ((_gpu(driver="575.51.02"), "old_driver"), (_gpu(cap="6.1"), "old_gpu"),
                      (_gpu(cap="7.0"), "old_gpu"), (_gpu(total_gb=6), "small_gpu")):
        monkeypatch.setattr(system, "gpus", lambda max_age=1.0, g=gpu: [g])
        g = G.check("real")
        assert not g.ok and g.code == code, (gpu, g.code)
    monkeypatch.setattr(system, "gpus", lambda max_age=1.0: [_gpu()])
    g = G.check("real")
    assert g.ok and g.code == "ok"
    assert g.to_dict()["requirements"]["driver"] == 580


def test_without_a_gpu_nothing_installs(db, tmp_path, monkeypatch):
    monkeypatch.setattr(system, "platform_key", lambda: "linux-x86_64")
    monkeypatch.setattr(system, "gpus", lambda max_age=1.0: [])
    monkeypatch.setattr(system, "in_container", lambda: False)
    h = ImageHost(db, ImageSettings(home=tmp_path / "image", engine_mode="real"))
    h._started = True
    with pytest.raises(ImageError) as e:
        h.install("anima-turbo", accept_license=True)
    assert e.value.code == "no_gpu"


# ---- the catalog ----

NEEDS = {"draft": {"model", "text_encoder", "vae"}, "edit": {"model", "text_encoder", "vae"},
         "loop": {"model", "text_encoder", "vae"}, "cutout": {"remover"}}


def test_every_model_has_the_files_its_graph_takes_and_a_license():
    for m in catalog.CATALOG:
        roles = {f.role for f in m.files}
        for use in m.uses:
            assert NEEDS[use] <= roles, (m.id, use, roles)
        assert all(f.size > 1_000_000 and f.revision and f.url.startswith("https://huggingface.co/") for f in m.files)
        assert m.license.name and m.license.url.startswith("https://") and m.license.summary
        assert m.vram_gb > 0 and m.ram_gb > 0, f"{m.id}: not measured"
    for r in catalog.RECIPES:
        assert r.models and all(r.use in catalog.BY_ID[mid].uses for mid in r.models)
    # (files two models share are the same file: one download)
    keys = {}
    for m in catalog.CATALOG:
        for f in m.files:
            assert keys.setdefault(f.key, (f.repo, f.revision, f.size)) == (f.repo, f.revision, f.size), f.key


# ---- the graphs ----

def test_the_graphs_are_wired_to_their_nodes():
    a = Gr.anima_txt2img("1girl", model="m", text_encoder="t", vae="v", width=770, height=1000, steps=10, cfg=1, seed=5)
    assert a.graph["2"]["inputs"]["type"] == "stable_diffusion" and a.graph["6"]["inputs"]["width"] == 768
    assert a.graph["4"]["inputs"]["text"].startswith(Gr.ANIMA_PREFIX)
    w = Gr.wan_loop("in.png", "she breathes", model="m", text_encoder="t", vae="v", seconds=3.4, fps=24, seed=1)
    assert w.graph["8"]["inputs"]["length"] == 81 and w.graph["8"]["inputs"]["end_image"] == ["7", 0]
    assert w.graph["7"]["inputs"]["image"] == "in.png"  # (no end picture: the start one again)
    k = Gr.klein_edit("in.png", "smile", model="m", text_encoder="t", vae="v", refs=("a.png", "b.png"), seed=3)
    g = k.graph
    assert g["2"]["inputs"]["type"] == "flux2"
    # each reference chains onto both the prompt and the empty negative
    assert g["16"]["inputs"]["positive"] == ["28", 0] and g["16"]["inputs"]["negative"] == ["29", 0]
    assert g["23"]["inputs"]["conditioning"] == ["10", 0] and g["28"]["inputs"]["conditioning"] == ["23", 0]
    v = Gr.video_mask("clip.mp4", model="lucida.safetensors")
    assert v.graph["4"]["inputs"]["image"] == ["3", 0]
    assert all(isinstance(n["class_type"], str) for b in (a, w, k, v) for n in b.graph.values())


# ---- finishing ----

def test_the_colour_fit_finds_a_decoders_drift():
    rng = np.random.default_rng(1)
    ref = rng.uniform(20, 230, (64, 64, 3)).astype(np.float32)
    drifted = (ref - 11) / 1.03
    a, b = media.fit_colour(drifted, ref)
    assert np.abs(media.apply_colour(drifted, a, b) - ref).mean() < 0.5


@pytest.mark.skipif(not CAN_ENCODE, reason="no video encoder here")
def test_a_loops_ends_are_the_base_picture(tmp_path):
    base = base_picture(tmp_path / "base.png", 128)
    frames = media.cmd_fake_frames({"base": str(base), "dir": str(tmp_path / "f"), "width": 64, "height": 64,
                                    "frames": 9})["files"]
    for f in frames:  # (the decoder's drift: every frame darker)
        im = np.asarray(Image.open(f)).astype(np.float32) - 10
        Image.fromarray(im.clip(0, 255).astype(np.uint8)).save(f)
    res = media.cmd_loop({"frames": frames, "base": str(base), "out": str(tmp_path / "loop.mp4"), "fps": 24,
                          "ease": 2})
    assert res["frames"] == 9 and res["size"] == [128, 128]
    assert res["colour"]["first"][1][0] > 5  # (brought back up)
    assert res["seam"][0] < 3
    out, _fps = media.read_video(tmp_path / "loop.mp4")
    assert len(out) == 9
    b = np.asarray(Image.open(base)).astype(np.float32)
    assert np.abs(out[0] - b).mean() < 3 and np.abs(out[-1] - b).mean() < 3


def test_a_cut_out_takes_its_alpha_from_the_mask(tmp_path):
    base = base_picture(tmp_path / "base.png")
    media.cmd_fake_mask({"image": str(base), "out": str(tmp_path / "mask.png")})
    res = media.cmd_cut({"image": str(base), "mask": str(tmp_path / "mask.png"), "out": str(tmp_path / "cut.png")})
    a = np.asarray(Image.open(tmp_path / "cut.png"))[..., 3]
    assert a[5, 5] == 0 and a[200, 128] == 255 and 0.1 < res["coverage"] < 0.6


# ---- installing ----

async def test_a_license_is_accepted_before_anything_is_downloaded(ih):
    with pytest.raises(ImageError) as e:
        ih.install("anima-turbo", accept_license=False)
    assert e.value.code == "license" and e.value.data["license"]["url"]
    await installed(ih, "anima-turbo")
    assert ih.installer.installed(catalog.get("anima-turbo"))
    assert ih.store.license_record("anima-turbo")["license"].startswith("CircleStone")


def test_a_file_counts_only_at_its_exact_size_and_shared_files_stay(tmp_path):
    s = ImageSettings(home=tmp_path / "image", engine_mode="real")
    inst = Installer(s)
    inst.engine_ready = lambda: True  # type: ignore[method-assign]
    turbo, base = catalog.get("anima-turbo"), catalog.get("anima-base")
    for m in (turbo, base):
        for f in m.files:
            p = inst.file_path(f)
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, "wb") as fh:
                fh.truncate(f.size)
    assert inst.installed(turbo) and inst.installed(base)
    with open(inst.file_path(turbo.files[0]), "wb") as fh:
        fh.truncate(10)
    assert not inst.installed(turbo)
    with open(inst.file_path(turbo.files[0]), "wb") as fh:
        fh.truncate(turbo.files[0].size)
    inst.remove(turbo)
    assert not inst.file_path(turbo.files[0]).exists()
    assert inst.file_path(turbo.files[1]).exists() and inst.installed(base)  # (the text encoder Anima 1.0 needs too)


# ---- jobs through the stand-in ----

async def test_a_job_without_its_model_is_refused_with_the_use_it_needs(ih, tmp_path):
    with pytest.raises(ImageError) as e:
        ih.submit("draft", inputs={"prompt": "1girl"})
    assert e.value.code == "not_installed" and e.value.data["use"] == "draft"


async def test_drafts_edits_and_cut_outs_come_out_as_files_in_the_history(ih, tmp_path):
    await installed(ih, "anima-turbo", "flux2-klein-4b", "lucida")
    j = await ih.run("draft", inputs={"prompt": "1girl, solo"}, params={"count": 2, "width": 512, "height": 640},
                     source="avatar:p1")
    assert j["state"] == "done", j["error"]
    assert [o["name"] for o in j["outputs"]] == ["1.png", "2.png"] and j["model_id"] == "anima-turbo"
    assert j["params"]["steps"] == 10 and Image.open(ih.job_file(j["id"], "1.png")).size == (512, 640)
    base = base_picture(tmp_path / "base.png")
    e = await ih.run("edit", inputs={"image": str(base), "prompt": "make her smile"})
    assert e["state"] == "done", e["error"]
    assert Image.open(ih.job_file(e["id"], "edit.png")).size == (256, 256)
    c = await ih.run("cutout", inputs={"image": str(base)})
    assert c["state"] == "done" and {o["name"] for o in c["outputs"]} == {"cut.png", "mask.png"}
    assert Image.open(ih.job_file(c["id"], "cut.png")).mode == "RGBA"
    assert ih.job_file(c["id"], "in-image.png")  # (what it was made from stays with it)
    h = ih.history(source="avatar:")
    assert h["total"] == 1 and h["items"][0]["id"] == j["id"]


@pytest.mark.skipif(not CAN_ENCODE, reason="no video encoder here")
async def test_a_loop_and_its_matte(ih, tmp_path):
    await installed(ih, "wan22-fun-5b", "lucida")
    base = base_picture(tmp_path / "base.png")
    j = await ih.run("loop", inputs={"image": str(base), "prompt": "she breathes", "box": [60, 40, 200, 256]},
                     params={"seconds": 1, "size": 128})
    assert j["state"] == "done", j["error"]
    assert {o["name"] for o in j["outputs"]} == {"loop.mp4", "poster.jpg"}
    assert j["params"]["box"] == [60, 40, 200, 256] and j["params"]["result"]["size"] == [256, 256]
    m = await ih.run("matte", inputs={"clip": str(ih.job_file(j["id"], "loop.mp4"))})
    assert m["state"] == "done", m["error"]
    frames, _ = media.read_video(ih.job_file(m["id"], "nobg.mp4"))
    assert frames[0][5, 5].sum() < 30 and frames[0][200, 128].sum() < 200  # (the gray gone, her kept)


async def test_a_queued_job_can_be_canceled(ih, tmp_path):
    await installed(ih, "anima-turbo")
    ih.engine.delay = 0.2
    first = ih.submit("draft", inputs={"prompt": "a"})
    second = ih.submit("draft", inputs={"prompt": "b"})
    assert await ih.cancel(second["id"])
    assert (await ih.wait(first["id"]))["state"] == "done"
    assert (await ih.wait(second["id"]))["state"] == "canceled"


async def test_the_model_a_use_takes_and_what_the_avatar_maker_sees(ih):
    await installed(ih, "anima-turbo", "anima-base")
    assert ih.model_for("draft") == "anima-turbo"
    ih.put_settings({"models": {"draft": "anima-base"}})
    assert ih.model_for("draft") == "anima-base"
    with pytest.raises(ImageError):
        ih.put_settings({"models": {"draft": "lucida"}})
    av = ih.avatar_engines()["stages"]
    assert set(av) == set(AVATAR_STAGES)
    assert av["design"]["ready"] and av["design"]["default"] == "local"
    assert not av["clips"]["ready"] and av["clips"]["default"] == "higgsfield"
    ih.put_settings({"avatar": {"design": "higgsfield"}})
    assert ih.avatar_engines()["stages"]["design"]["default"] == "higgsfield"


async def test_a_restart_marks_unfinished_jobs_failed(db, ims):
    h = ImageHost(db, ims)
    h.store.add_job(kind="draft", recipe="draft", model_id="anima-turbo", source="studio", inputs={"prompt": "x"},
                    params={})
    await h.start()
    try:
        items = h.history()["items"]
        assert items[0]["state"] == "failed" and "restart" in items[0]["error"]
    finally:
        await h.stop()


# ---- sharing the GPU ----

async def test_the_voice_models_make_room_for_an_image_job(monkeypatch, tmp_path):
    from app.voicehost import host as vhost
    from app.voicehost.settings import VoiceSettings

    em = vhost.EngineManager(VoiceSettings(home=tmp_path / "v", engine_mode="fake"), lambda e: None)
    free = {"bytes": 2 * GiB}
    monkeypatch.setattr(em, "_gpu", lambda: _gpu(used_gb=12 - free["bytes"] / GiB))
    stopped = []

    class R:
        def __init__(self, mid):
            self.spec = type("S", (), {"id": mid})()
            self.state, self.busy, self.last_used = "ready", 0, 0

    em.residents = {"a": R("a"), "b": R("b")}
    em.pins["b"] = 1  # (a call holds it)

    async def evict(r, why):
        stopped.append(r.spec.id)
        em.residents.pop(r.spec.id)
        free["bytes"] += 3 * GiB

    monkeypatch.setattr(em, "_evict", evict)
    monkeypatch.setattr(em, "_settle", lambda: asyncio.sleep(0))
    await em.make_room_for(4 * GiB)
    assert stopped == ["a"] and "b" in em.residents


async def test_an_idle_image_engine_stops_for_the_voice_models(ih):
    ih.engine.running = lambda: True  # type: ignore[method-assign]
    stopped = []

    async def stop():
        stopped.append(1)

    ih.engine.stop = stop  # type: ignore[method-assign]
    assert await ih.release_gpu() and stopped
    ih.engine.busy = lambda: True  # type: ignore[method-assign]
    assert not await ih.release_gpu()


def test_the_engine_leaves_room_for_the_voice_models(tmp_path):
    from app.imagehost.engines import ComfyEngine

    s = ImageSettings(home=tmp_path / "image")
    e = ComfyEngine(s, lambda: "python", lambda: tmp_path, voice_room=lambda: int(2.9 * GiB))
    assert e.reserve() == 3.9  # (its own 1 GB + the default speech model)
    s.voice_room_gb = 0
    assert e.reserve() == 1.0
    e._process()
    assert e.proc.flags[:2] == ["--reserve-vram", "1"] and "--disable-pinned-memory" in e.proc.flags


async def test_speech_keeps_room_for_its_default_model(db, tmp_path):
    from app.voicehost import catalog as VC
    from app.voicehost.service import VoiceHost
    from app.voicehost.settings import VoiceSettings
    from tests.test_voicehost import mark_installed

    vs = VoiceSettings(home=tmp_path / "voice", engine_mode="fake", idle_unload_seconds=0)
    vs.ensure_dirs()
    vh = VoiceHost(db, vs)
    await vh.start()
    try:
        assert vh.room_for_speech() == 0  # (no speech model: nothing to keep room for)
        mark_installed(vs, "omnivoice")
        assert vh.room_for_speech() == int(VC.BY_ID["omnivoice"].vram_gb * GiB)
    finally:
        await vh.stop()


def test_media_runs_as_a_script_with_no_app_imports():
    src = Path(media.__file__).read_text()
    assert "from app" not in src and "import app" not in src
