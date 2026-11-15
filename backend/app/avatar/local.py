"""The avatar maker's stages on this machine's GPU (Image Studio, app/imagehost) — what the user picks per stage on the
estimate instead of Higgsfield: 0 credits, the time it takes on their card.

Each stage makes the very file the hosted job would have made, so everything after it (the processing in
pipeline.py, the checks, the export) is the same:

    design   local:design  a candidate      design/c<n>.png         Anima (words) — or FLUX.2 Klein when a picture is
                                                                     the reference (redraw, an outfit, a change)
    home     local:cutout  the cut-out      masters/candidate.cut.png   Lucida / BiRefNet
    stills   local:edit    an expression    stills/<name>.raw.png   FLUX.2 Klein, its colours fitted to the picture's
    clips    local:loop    a clip           clips/<id>.mp4          Wan 2.2, base picture first and last, the model
                                                                     seeing her (a crop), not the empty canvas
    matte    local:matte   subject on black clips/<id>.nobg.mp4     Lucida / BiRefNet on every frame
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.avatar.generator import JobError

#: the image use each local job needs (a design with a reference picture needs the edit model instead)
USES = {"local:design": "draft", "local:cutout": "cutout", "local:edit": "edit", "local:loop": "loop",
        "local:matte": "cutout"}
OUTPUT = {"draft": "1.png", "edit": "edit.png", "cutout": "cut.png", "loop": "loop.mp4", "matte": "nobg.mp4"}
#: Anima's framing tags in front of the description (its card: tags and plain sentences both work)
_WHO = {"she": "1girl", "he": "1boy", "they": "1other"}
#: room around her for what a clip does (a hand raised, a lean): a share of her own size on each side
CLIP_MARGIN = 0.12


def draft_prompt(description: str, pronoun: str) -> str:
    """the hosted prompt (description + framing) behind Anima's own framing tags"""
    tags = f"{_WHO.get(pronoun, '1girl')}, solo, upper body, looking at viewer, simple background, grey background"
    return f"{tags}, {description}"


def clip_box(d: Path) -> list[int] | None:
    """where she is on the base picture (masters/place.json, written when the cut-out was placed), with room around
    her, as [x0, y0, x1, y1] on the canvas — the clip model gets that crop at its own resolution"""
    try:
        place = json.loads((d / "masters" / "place.json").read_text())
        from PIL import Image  # noqa: PLC0415

        with Image.open(d / "masters" / "home.png") as im:
            w, h = im.size
    except (OSError, ValueError):
        return None
    W, H = place["canvas"]
    s, x, y = float(place["scale"]), int(place["x"]), int(place["y"])
    bw, bh = w * s, h * s
    m = CLIP_MARGIN * max(bw, bh)
    box = [int(max(0, x - m)), int(max(0, y - m)), int(min(W, x + bw + m)), int(min(H, y + bh + m))]
    if (box[2] - box[0]) * (box[3] - box[1]) > 0.85 * W * H:
        return None  # (she fills the canvas: the whole picture)
    return box


class LocalImages:
    """create / fetch — the counterpart of the Higgsfield generator's create / wait / download, on the image host"""

    def __init__(self, host: Any) -> None:
        self.host = host

    def ready(self, job_type: str, *, refs: bool = False) -> bool:
        use = "edit" if job_type == "local:design" and refs else USES.get(job_type, "")
        return bool(use) and self.host is not None and self.host.usable(use)

    async def create(self, job_type: str, spec: dict[str, Any], *, source: str) -> dict[str, Any]:
        """``spec``: kind (draft | edit | cutout | loop | matte), inputs, params → the image job's record"""
        from app.imagehost.service import ImageError  # noqa: PLC0415

        if self.host is None:
            raise JobError("local image models aren't available on this server", code="local_unavailable", retry=False)
        try:
            return self.host.submit(spec["kind"], inputs=spec.get("inputs") or {}, params=spec.get("params") or {},
                                    source=source)
        except ImageError as e:
            raise JobError(str(e), code=e.code, retry=e.code not in ("not_installed", "bad_input", "no_gpu",
                                                                         "old_driver", "old_gpu", "small_gpu", "off",
                                                                         "platform", "python")) from None

    async def fetch(self, jid: str, dest: Path) -> dict[str, Any]:
        """wait for the job, put its result where the hosted job's download would have"""
        from app.imagehost.service import ImageError  # noqa: PLC0415

        try:
            job = await self.host.wait(jid)
        except ImageError as e:
            raise JobError(str(e), code=e.code) from None
        if job["state"] != "done":
            msg = job.get("error") or job["state"]
            raise JobError(f"local {job['kind']}: {msg}", code="local_" + job["state"],
                           retry=job["state"] != "canceled" and "[oom]" not in msg)
        src = self.host.job_file(jid, OUTPUT[job["kind"]])
        if src is None:
            raise JobError("the local job finished without its file", code="no_result")
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".part")
        tmp.write_bytes(src.read_bytes())
        tmp.replace(dest)
        return job
