"""The stand-in run (VOICE_ENGINE_MODE=fake, the tests): the same stages and events as run.py in a moment, on the
recordings as they are (numpy only), with a made-up adapter and tones for samples."""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from . import segment
from .control import Control

SR = 24_000
# what each model is measured with (recipe.py: a model that can't speak without a clip has no "none")
CONDITIONS = {"omnivoice": ("long", "short", "none"), "qwen3_tts": ("long", "short", "none"),
              "cosyvoice3": ("long", "short")}


def run(job: dict, emit, ctl: Control) -> None:
    out = Path(job["out_dir"])
    (out / "segments").mkdir(parents=True, exist_ok=True)
    delay = float((job.get("limits") or {}).get("fake_delay", 0.01))
    conds = CONDITIONS.get(job.get("engine") or "omnivoice", ("long", "short", "none"))
    segs = []
    if job.get("shared_data"):  # (the same recordings, heard by another model's run: not listened to again)
        segs = json.loads(Path(job["shared_data"]).read_text())["segments"]
        emit(stage="prepare", done=len(segs), total=len(segs))
    for fi, src in enumerate([] if segs else job["inputs"]):
        ctl.check()
        x, sr = sf.read(src["path"], dtype="float32", always_2d=True)
        x = x.mean(axis=1)
        for s, e in segment.speech_segments(x, sr):
            segs.append({"id": f"u{len(segs):05d}", "source": src.get("name") or "", "file": src.get("file") or "",
                         "start": round(s / sr, 2),
                         "end": round(e / sr, 2), "seconds": round((e - s) / sr, 2), "text": "가짜 전사",
                         "similarity": 0.8})
        emit(stage="prepare", done=fi + 1, total=len(job["inputs"]), found=len(segs),
             found_s=round(sum(g["seconds"] for g in segs), 1))
    if not segs:
        from .run import RunError

        raise RunError("No speech was found in the recordings", "no_speech")
    if not job.get("shared_data"):
        emit(stage="transcribe", done=len(segs), total=len(segs), language=job.get("language") or "ko")
    kept_s = sum(g["seconds"] for g in segs)
    (out / "data.json").write_text(json.dumps({"language": "ko", "segments": segs}, ensure_ascii=False))
    emit(stage="screen", kept=len(segs), kept_s=round(kept_s, 1), dropped={"speaker": 0, "words": 0, "sound": 0},
         language="ko")
    if kept_s < float((job.get("limits") or {}).get("min_seconds", 60)):
        from .run import RunError

        raise RunError("Too little of her speech is left to learn from", "too_little", kept_s=round(kept_s, 1))
    emit(stage="tokens", done=len(segs), total=len(segs))
    m = lambda s: {c: {"similarity": s, "worst": s - 0.05, "cer": 0.0} for c in conds}  # noqa: E731
    base = m(0.5)
    (out / "samples").mkdir(exist_ok=True)
    t = np.arange(int(SR * 0.6)) / SR
    for which, f in (("base", 330.0), ("tuned", 440.0)):
        for cond in [c for c in ("long", "none", "short") if c in conds][:2]:
            for i in range(2):
                sf.write(str(out / "samples" / f"{which}-{cond}-{i}.wav"), (0.2 * np.sin(2 * np.pi * f * t)).astype(np.float32), SR)
    emit(stage="baseline", metrics=base, references={"long_s": 6.0, "short_s": 3.0})
    steps = 40
    emit(stage="train", step=0, steps=steps, every=20)
    for step in range(1, steps + 1):
        ctl.check(lambda p: emit(stage="paused" if p else "resumed", step=step))
        time.sleep(delay)
        if step % 10 == 0:
            emit(stage="train", step=step, steps=steps, loss=round(4.0 - step / 40, 3), eta_s=0)
        if step % 20 == 0:
            emit(stage="eval", step=step, steps=steps, metrics=m(0.5 + step / 100), best=True)
    adapter = out / "adapter"
    adapter.mkdir(exist_ok=True)
    (adapter / "adapter_config.json").write_text(json.dumps({"peft_type": "LORA", "r": 16}))
    (adapter / "adapter_model.safetensors").write_bytes(b"fake")
    (adapter / "geny.json").write_text(json.dumps({"engine": job.get("engine") or "omnivoice", "model_id": job.get("model_id", ""),
                                                   "base_revision": job.get("base_revision", ""),
                                                   "language": "ko", "step": steps, "metrics": {"base": base, "tuned": m(0.9)}}))
    emit(stage="done", improved=True, best_step=steps, steps=steps, base=base, tuned=m(0.9), evals=[], kept_s=round(kept_s, 1),
         language="ko", minutes=0.0, conditions=list(conds))
