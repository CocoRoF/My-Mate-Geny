"""How well an engine makes the sounds people write (app/voicehost/nonverbal.py; docs/local-voice.md "Laughs, sighs and
yawns"): lines in several spellings, a few takes each, through the product's engine class — each take heard by the
sound check (AudioSet AST: does a laugh / a sigh happen, how strongly) and, with --whisper, by Whisper (are the words
still all there: a tag can swallow the words after it).

Run it with the engine's own environment (the runtime the app installed), from the backend folder:

    <runtimes>/omni/bin/python tools/nonverbal_bench.py --engine omnivoice --model <models>/omnivoice \\
        --check <models>/sound-check [--whisper <models>/whisper-large-v3-turbo] [--cases cases.json] [--takes 3]

A case: {"id", "text", "kind" (laugh | sigh | none), "words" (what must still be heard), "language", "params",
"instruct"}. Without --cases, the built-in set: each sound as written, as the recipe renders it, and as a tag alone.
On a real recording of someone laughing mid-sentence the laugh score is 0.1–0.4; a line read without one, ~0.01.
"""

from __future__ import annotations

import argparse
import importlib
import json
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.voicehost import nonverbal as NV  # noqa: E402

VOICES = Path(__file__).resolve().parents[1] / "app/mate/builtin/voices"
ENGINES = {"omnivoice": ("omnivoice", "OmniVoiceEngine"), "cosyvoice3": ("cosyvoice3", "CosyVoice3Engine"),
           "qwen3_tts": ("qwen3_tts", "Qwen3TTSEngine")}


def default_cases(engine: str) -> list[dict]:
    lines = [("laugh", "자기야 헤헤 왜 그래 하하", "자기야 왜 그래"), ("laugh", "ㅋㅋㅋ 너 진짜 웃기다.", "너 진짜 웃기다"),
             ("sigh", "후우... 오늘 진짜 힘들었다.", "오늘 진짜 힘들었다"), ("sigh", "하암~ 졸려. 오늘은 일찍 잘래.", "졸려 오늘은 일찍 잘래"),
             ("none", "오늘 회의는 세 시에 있어.", "오늘 회의는 세 시에 있어")]
    out = []
    for i, (kind, text, words) in enumerate(lines):
        out.append({"id": f"{i}-written", "text": text, "kind": kind, "words": words})
        rendered = NV.render(text, engine).text
        if rendered != text:
            out.append({"id": f"{i}-recipe", "text": rendered, "kind": kind, "words": words})
    for kind, texts in NV.BANK_TEXTS.get(engine, {}).items():
        for j, (text, lang) in enumerate(texts):
            out.append({"id": f"bank-{kind}-{j}", "text": text, "kind": kind, "words": "", "language": lang})
    return out


def _lcs(a: str, b: str) -> int:
    dp = [0] * (len(b) + 1)
    for ch in a:
        prev = 0
        for j, cb in enumerate(b):
            cur = dp[j + 1]
            dp[j + 1] = prev + 1 if ch == cb else max(dp[j + 1], dp[j])
            prev = cur
    return dp[-1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, choices=sorted(ENGINES))
    ap.add_argument("--model", required=True)
    ap.add_argument("--check", required=True, help="the sound check's folder (catalog.SOUND_CHECK)")
    ap.add_argument("--whisper", default="")
    ap.add_argument("--voice", default="chaerin", help="a built-in voice (its neutral clip is cloned)")
    ap.add_argument("--cases", default="")
    ap.add_argument("--takes", type=int, default=3)
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    import numpy as np
    import soundfile as sf
    import torch

    from app.voicehost.worker.engines.base import Reference, SynthRequest
    from app.voicehost.worker.runtime import pick_device
    from app.voicehost.worker.soundcheck import SoundCheck

    mod, cls = ENGINES[a.engine]
    dev = pick_device("cuda:0")
    eng = getattr(importlib.import_module(f"app.voicehost.worker.engines.{mod}"), cls)(Path(a.model), dev, {})
    eng.load()
    spec = json.loads((VOICES / a.voice / "voice.json").read_text("utf-8"))
    ref = Reference(str(VOICES / a.voice / spec["emotions"]["neutral"]["ref"]), spec["emotions"]["neutral"]["text"], "ko")
    cases = json.loads(Path(a.cases).read_text("utf-8")) if a.cases else default_cases(a.engine)
    check = SoundCheck(a.check, dev.device)
    asr = None
    if a.whisper:
        from transformers import pipeline

        asr = pipeline("automatic-speech-recognition", model=a.whisper, device=dev.device, dtype=torch.float16)
    out_dir = Path(a.out) if a.out else None
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
    print(f"{'case':16} {'kind':6} {'laugh':>6} {'sigh':>6} {'words':>6}  heard (first take) | text")
    for c in cases:
        scores = {"laugh": [], "sigh": [], "words": []}
        heard0 = ""
        for take in range(a.takes):
            for f in (random.seed, np.random.seed, torch.manual_seed):
                f(take + 1)
            w = eng.synthesize(SynthRequest(text=[c["text"]], language=c.get("language", "ko"), reference=ref,
                                            instruct=c.get("instruct", ""), params=c.get("params", {})))[0]
            sr = eng.sample_rate
            if out_dir:
                sf.write(out_dir / f"{c['id']}_t{take + 1}.wav", w, sr)
            scores["laugh"].append(check.score(w, sr, "laugh")["score"])
            scores["sigh"].append(check.score(w, sr, "sigh")["score"])
            if asr is not None:
                import torchaudio

                y = torchaudio.functional.resample(torch.from_numpy(np.asarray(w, dtype=np.float32)), sr, 16000).numpy()
                text = asr(y, generate_kwargs={"language": "ko", "task": "transcribe"})["text"].strip()
                heard0 = heard0 or text
                want = re.sub(r"[^\w]", "", c.get("words", ""))
                scores["words"].append(_lcs(want, re.sub(r"[^\w]", "", text)) / max(1, len(want)) if want else 1.0)
        mean = {k: (sum(v) / len(v) if v else float("nan")) for k, v in scores.items()}
        print(f"{c['id']:16} {c['kind']:6} {mean['laugh']:6.2f} {mean['sigh']:6.2f} {mean['words']:6.2f}  "
              f"{heard0[:28]:28} | {c['text']}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
