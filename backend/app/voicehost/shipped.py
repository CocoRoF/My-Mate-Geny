"""The adapters that come with the built-in voices (docs/local-voice.md "Training a voice"): 한채린's and 서아's voices
learned by a speech model — trained with Voice Studio → 학습 on the owner's recordings of their own voices — published
as GitHub release assets (they are not in the repository), and fetched, checked against their SHA-256, once that model
is installed. A built-in voice speaks with its shipped adapter unless the user trained one of their own for that model
(app/voicehost/training.py) or turned shipped adapters off (Voice Studio → 설정).

A release asset is a zip of the adapter's files (adapter_config.json, adapter_model.safetensors, geny.json, and the
license notices that go with it); it is unpacked under <voice home>/adapters/<voice>/<model>/<sha256[:12]>/.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import shutil
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

log = logging.getLogger("app.voicehost.shipped")

RELEASE = "https://github.com/CocoRoF/My-Mate-Geny/releases/download/voice-adapters-v1"
# (voice id, model id) → the release asset: its name, SHA-256, size, and the model revision it was made from. Trained
# 2026-11-17 with 학습 on ~18 / 19 minutes of speech the owner made with their own ElevenLabs voices (and each voice's
# five clips). CAM++ similarity to her recordings, through the worker as the app speaks (8 new sentences), without →
# with, from her five feeling clips (한채린 / 서아): OmniVoice 0.841 → 0.852 / 0.837 → 0.846 (서아's at half the learning
# rate, which kept her clips' likeness), VoxCPM2 0.801 → 0.841 / 0.787 → 0.832, Qwen3-TTS 1.7B 0.787 → 0.880 /
# 0.749 → 0.836, 0.6B 0.752 → 0.874 / 0.748 → 0.847, CosyVoice3 0.850 → 0.867 / 0.829 → 0.859 — no clip worse on any;
# with no clip OmniVoice 0.23 → 0.85 / 0.29 → 0.83, VoxCPM2 0.22 → 0.87 / 0.17 → 0.85 (docs/local-voice.md).
SHIPPED: dict[tuple[str, str], dict[str, Any]] = {
    ("builtin:chaerin", "omnivoice"): {
        "asset": "higgs-audio-2-omnivoice-lora-chaerin-v1.zip",
        "sha256": "993b09c95b4fff0bbb34a4738daee810a99d6b20910ae40fcce23d48b3ba62ae", "bytes": 53835562,
        "base_revision": "c5fdb5ccb189"},
    ("builtin:seoa", "omnivoice"): {
        "asset": "higgs-audio-2-omnivoice-lora-seoa-v1.zip",
        "sha256": "91f268d804171be3be2a349c91ad5aa480dbb665ac613fb242d9723db65acd1f", "bytes": 53835545,
        "base_revision": "c5fdb5ccb189"},
    ("builtin:chaerin", "voxcpm2"): {
        "asset": "voxcpm2-lora-chaerin-v1.zip",
        "sha256": "2f35fee8fdc5b61cc90f4f7d78804ee6d8bfeb9ba0444e1c56e95cd410f8d474", "bytes": 18139415,
        "base_revision": "7936080b4116"},
    ("builtin:seoa", "voxcpm2"): {
        "asset": "voxcpm2-lora-seoa-v1.zip",
        "sha256": "252da5e59d07e7fc8fad1029c174e0d578b01bbb11c9f0eb9c387c9edf76cb96", "bytes": 18139411,
        "base_revision": "7936080b4116"},
    ("builtin:chaerin", "qwen3-tts-0.6b-base"): {
        "asset": "qwen3-tts-0.6b-lora-chaerin-v1.zip",
        "sha256": "d01f3cf81f6e1874c6d5708367bb20bb5017e259ff86451ded5c120306917700", "bytes": 20250451,
        "base_revision": "5d83992436ea"},
    ("builtin:seoa", "qwen3-tts-0.6b-base"): {
        "asset": "qwen3-tts-0.6b-lora-seoa-v1.zip",
        "sha256": "80f6ec662817f5398ed198668942f47a1fa0a0a85061be39a189475c9affd9fe", "bytes": 20250450,
        "base_revision": "5d83992436ea"},
    ("builtin:chaerin", "qwen3-tts-1.7b-base"): {
        "asset": "qwen3-tts-1.7b-lora-chaerin-v1.zip",
        "sha256": "ca6680028d1530664f92d06a85c1364b46881b2ec69439a3c5c9bbbfc0dcc9d4", "bytes": 34934461,
        "base_revision": "fd4b25438912"},
    ("builtin:seoa", "qwen3-tts-1.7b-base"): {
        "asset": "qwen3-tts-1.7b-lora-seoa-v1.zip",
        "sha256": "a8bf7a22c3dcadf3e06e9be5b2e12310be0acf6d9fcaf69465c8bbe8013bf04b", "bytes": 34934441,
        "base_revision": "fd4b25438912"},
    ("builtin:chaerin", "cosyvoice3-0.5b"): {
        "asset": "cosyvoice3-0.5b-lora-chaerin-v1.zip",
        "sha256": "538c46f3a9f72592b8a2d3fdd4aa79145beef53efe05c7a55d9446d2bc05215e", "bytes": 52017694,
        "base_revision": "29e01c4e8d00"},
    ("builtin:seoa", "cosyvoice3-0.5b"): {
        "asset": "cosyvoice3-0.5b-lora-seoa-v1.zip",
        "sha256": "c08e00ab56e178a5f2f942fa67f5588c531e6166d245601e45ba374fbda590f8", "bytes": 52017680,
        "base_revision": "29e01c4e8d00"},
}
# what a release zip may hold (nothing else is unpacked, and never a path)
FILES = {"adapter_config.json", "adapter_model.safetensors", "geny.json", "voice.safetensors", "NOTICE.md",
         "LICENSE-Boson-Higgs-Audio-2.txt", "LICENSE-Meta-Llama-3.txt", "LICENSE-Apache-2.0.txt"}


class Shipped:
    def __init__(self, host, catalog: dict[tuple[str, str], dict[str, Any]] | None = None) -> None:
        self.h = host
        self.s = host.s
        # (the stand-in engine — tests, a throwaway server — fetches nothing it isn't given)
        self.catalog = (SHIPPED if self.s.engine_mode != "fake" else {}) if catalog is None else catalog
        self.failed: dict[tuple[str, str], str] = {}
        self._task: asyncio.Task | None = None

    @property
    def root(self) -> Path:
        return self.s.home / "adapters"

    def _dir(self, voice_id: str, model_id: str) -> Path | None:
        e = self.catalog.get((voice_id, model_id))
        if e is None:
            return None
        return self.root / voice_id.split(":", 1)[-1] / model_id / e["sha256"][:12]

    def run_id(self, voice_id: str, model_id: str) -> str:
        """what stands for a shipped adapter where a training's id would (a speech cache key, the history)"""
        e = self.catalog[(voice_id, model_id)]
        return f"shipped-{voice_id.split(':', 1)[-1]}-{model_id}-{e['sha256'][:8]}"

    def ready(self, voice_id: str, model_id: str) -> Path | None:
        d = self._dir(voice_id, model_id)
        return d if d is not None and (d / "adapter_config.json").is_file() else None

    def of_voice(self, voice_id: str) -> dict[str, str]:
        """{model id: run id} of the shipped adapters here for this voice"""
        return {m: self.run_id(v, m) for (v, m) in self.catalog if v == voice_id and self.ready(v, m)}

    def status(self) -> list[dict[str, Any]]:
        from . import catalog

        def installed(m: str) -> bool:
            spec = catalog.BY_ID.get(m)
            return spec is not None and self.h.installer.installed(spec)

        return [{"voice_id": v, "model_id": m, "bytes": e.get("bytes", 0), "ready": bool(self.ready(v, m)),
                 "installed": installed(m), "error": self.failed.get((v, m), "")} for (v, m), e in self.catalog.items()]

    # -- fetching --
    def want(self, voice_id: str = "", model_id: str = "") -> None:
        """fetch what is missing for the installed models, in the background (a line spoken meanwhile goes without)"""
        if self._task is None or self._task.done():
            try:
                self._task = asyncio.get_running_loop().create_task(self.fetch_all())
            except RuntimeError:  # (no loop: a thread — the next line asks again)
                pass

    async def fetch_all(self) -> list[str]:
        from . import catalog

        got = []
        for (v, m), e in list(self.catalog.items()):
            spec = catalog.BY_ID.get(m)
            if spec is None or self.ready(v, m) or (v, m) in self.failed or not self.h.installer.installed(spec):
                continue
            dest = self._dir(v, m)
            assert dest is not None
            try:
                await asyncio.to_thread(_fetch, f"{RELEASE}/{e['asset']}", e["sha256"], int(e.get("bytes") or 0), dest,
                                        self.s.tmp_dir)
                got.append(f"{v}/{m}")
                self.h.on_change(f"voice:{v}")
            except Exception as ex:  # noqa: BLE001 - said in the studio; tried again after a restart
                self.failed[(v, m)] = str(ex)[:300]
                log.warning("shipped adapter %s/%s: %s", v, m, ex)
        return got


def _fetch(url: str, sha256: str, size: int, dest: Path, tmp_dir: Path) -> None:
    """the asset → checked → unpacked at ``dest`` (whole, or not at all); older versions of it removed"""
    tmp_dir.mkdir(parents=True, exist_ok=True)
    part = tmp_dir / f"{dest.parent.parent.name}-{dest.parent.name}-{sha256[:12]}.zip.part"
    h = hashlib.sha256()
    n = 0
    req = urllib.request.Request(url, headers={"User-Agent": "my-mate-geny"})
    with urllib.request.urlopen(req, timeout=60) as r, part.open("wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            f.write(chunk)
            n += len(chunk)
            if size and n > size:
                break
    try:
        if h.hexdigest() != sha256 or (size and n != size):
            raise ValueError(f"{url}: not the expected file (SHA-256 or size differs)")
        stage = dest.parent / (dest.name + ".part")
        shutil.rmtree(stage, ignore_errors=True)
        stage.mkdir(parents=True)
        with zipfile.ZipFile(part) as z:
            names = [i for i in z.infolist() if not i.is_dir()]
            for i in names:
                name = Path(i.filename).name
                if name not in FILES or i.filename != name:
                    continue
                stage.joinpath(name).write_bytes(z.read(i))
        try:
            json.loads((stage / "geny.json").read_text("utf-8"))
            if not (stage / "adapter_config.json").is_file() or not (stage / "adapter_model.safetensors").is_file():
                raise ValueError
        except (OSError, ValueError):
            shutil.rmtree(stage, ignore_errors=True)
            raise ValueError(f"{url}: no adapter in it") from None
        shutil.rmtree(dest, ignore_errors=True)
        stage.rename(dest)
        for old in dest.parent.iterdir():  # (an earlier version of the same adapter)
            if old != dest and old.is_dir():
                shutil.rmtree(old, ignore_errors=True)
    finally:
        part.unlink(missing_ok=True)
