"""The real run, in the runtime of the model it trains (torch, transformers, peft, onnxruntime and the model's own
package). See __init__.py for the stages; what is the model's own (its tokens, speaking, LoRA, loss) is its recipe
(recipe.py → omni.py, qwen.py, cosy.py); the rest is here: her utterances, the measurements, the best checkpoint.

Measured on an RTX 5070 (12 GB), OmniVoice, one Korean speaker (KSS, 5 and 26 minutes): 0.45 s a step at 4k tokens,
4.9 GB at most on the GPU (gradient checkpointing; the audio tokenizer and Whisper off the GPU while training), 7 and
13 minutes in all. Speaker similarity (CAM++, to her own recordings): with no reference 0.34 → 0.77, with a 3 s one
0.73 → 0.75, with a 7 s one unchanged (0.79: the zero-shot clone of clean speech is already near her recordings'
0.82); words heard back unchanged (CER 0). The other models: docs/local-voice.md "Training a voice".
"""

from __future__ import annotations

import json
import math
import random
import shutil
import time
from pathlib import Path
from typing import Any, Callable

import numpy as np
import soundfile as sf
import soxr
import torch

from . import segment, texts
from .control import Control, Released
from .recipe import Recipe, recipe_for, wav as _wav

SR = 24_000  # her utterances as kept

Emit = Callable[..., None]


class RunError(Exception):
    """a run that can't go on, in words for the user (code: the UI's message)"""

    def __init__(self, message: str, code: str = "failed", **data: Any) -> None:
        super().__init__(message)
        self.code = code
        self.data = data


class Speakers:
    """CAM++ (3D-Speaker) on the CPU: unit-length speaker embeddings of 16 kHz speech"""

    def __init__(self, model_dir: str) -> None:
        import onnxruntime as ort
        import torchaudio.compliance.kaldi as kaldi

        so = ort.SessionOptions()
        so.intra_op_num_threads = 4
        self.sess = ort.InferenceSession(str(Path(model_dir) / "campplus.onnx"), so, providers=["CPUExecutionProvider"])
        self.inp = self.sess.get_inputs()[0].name
        self.kaldi = kaldi

    def embed(self, w16: np.ndarray) -> np.ndarray:
        f = self.kaldi.fbank(torch.from_numpy(np.ascontiguousarray(w16)).unsqueeze(0), num_mel_bins=80, dither=0,
                             sample_frequency=16000)
        e = self.sess.run(None, {self.inp: (f - f.mean(dim=0, keepdim=True)).unsqueeze(0).numpy()})[0][0]
        return e / (np.linalg.norm(e) + 1e-9)


class Ears:
    """Whisper (fp16): what was said, and in which language; moved to the GPU only while it listens"""

    def __init__(self, model_dir: str, dev: torch.device) -> None:
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor

        self.dev = dev
        self.dtype = torch.float16 if dev.type == "cuda" else torch.float32
        self.proc = AutoProcessor.from_pretrained(model_dir)
        import transformers

        # (CosyVoice's runtime has a transformers from before ``dtype=``)
        old = tuple(int(x) for x in transformers.__version__.split(".")[:2]) < (4, 56)
        kw = {"torch_dtype" if old else "dtype": self.dtype}
        self.model = AutoModelForSpeechSeq2Seq.from_pretrained(model_dir, attn_implementation="sdpa", **kw).eval()
        self.special = {self.proc.tokenizer.convert_tokens_to_ids(f"<|{c}|>"): c for c in texts.WHISPER}

    @torch.inference_mode()
    def language(self, wavs16: list[np.ndarray]) -> str:
        self.model.to(self.dev)
        votes: dict[str, int] = {}
        for i in range(0, min(len(wavs16), 24), 8):
            feats = self.proc(wavs16[i:i + 8], sampling_rate=16000, return_tensors="pt").input_features
            for t in self.model.detect_language(feats.to(self.dev, self.dtype)).view(-1).tolist():
                code = self.special.get(int(t))
                if code:
                    votes[code] = votes.get(code, 0) + 1
        return max(votes, key=votes.get) if votes else "auto"

    @torch.inference_mode()
    def hear(self, wavs16: list[np.ndarray], lang: str, on_batch: Callable[[int], None] | None = None) -> list[str]:
        self.model.to(self.dev)
        out: list[str] = []
        kw: dict[str, Any] = {"task": "transcribe", "max_new_tokens": 220}
        if lang in texts.WHISPER:
            kw["language"] = texts.WHISPER[lang]
        for i in range(0, len(wavs16), 8):
            part = wavs16[i:i + 8]
            feats = self.proc(part, sampling_rate=16000, return_tensors="pt").input_features.to(self.dev, self.dtype)
            ids = self.model.generate(feats, **kw)
            out += [t.strip() for t in self.proc.batch_decode(ids, skip_special_tokens=True)]
            if on_batch:
                on_batch(len(out))
        return out

    def off(self) -> None:
        self.model.to("cpu")
        if self.dev.type == "cuda":
            torch.cuda.empty_cache()


def _repeats(t: str) -> bool:
    """Whisper's loops: the same character 8 times, or one short piece over and over"""
    s = texts.norm(t)
    if any(s[i] * 8 == s[i:i + 8] for i in range(max(0, len(s) - 7))):
        return True
    for n in (2, 3, 4):
        grams = [s[i:i + n] for i in range(0, max(0, len(s) - n + 1))]
        if grams and max(grams.count(g) for g in set(grams)) >= 6 and len(set(grams)) < len(grams) / 3:
            return True
    return False


def run(job: dict, emit: Emit, ctl: Control) -> None:
    out = Path(job["out_dir"])
    seg_dir = out / "segments"
    seg_dir.mkdir(parents=True, exist_ok=True)
    rnd = random.Random(int(job.get("seed", 42)))
    torch.manual_seed(int(job.get("seed", 42)))
    lim = job.get("limits") or {}
    dev = torch.device("cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu"))
    if dev.type == "cuda":
        torch.cuda.set_per_process_memory_fraction(float(job.get("vram_fraction") or 0.6))
        torch.backends.cuda.matmul.allow_tf32 = True
    t_start = time.time()
    state_dir = out / "state"
    resume = None
    if (state_dir / "state.json").exists() and (state_dir / "train.pt").exists() and (out / "data.json").exists():
        resume = json.loads((state_dir / "state.json").read_text())
    ears = Ears(job["whisper_dir"], dev)
    spk = Speakers(job["speaker_dir"])
    if resume is None and not (out / "data.json").exists() and job.get("shared_data"):
        _cut_as(job, out, seg_dir, emit, ctl)  # (the same recordings, already heard by another model's run)
    if resume is None and not (out / "data.json").exists():
        segs, kept, lang, centroid = _gather(job, out, seg_dir, emit, ctl, ears, spk, lim)
    else:  # (her utterances and their words as they were: going on from where it left the GPU, or another run's)
        data = json.loads((out / "data.json").read_text())
        segs, lang = data["segments"], data["language"]
        kept = [g for g in segs if not g.get("left_out")]
        embs = np.stack([spk.embed(_wav(g["path"], 16000)) for g in kept])
        centroid = embs.mean(0)
        centroid /= np.linalg.norm(centroid) + 1e-9
        if resume is None:
            emit(stage="screen", kept=len(kept), kept_s=round(sum(g["seconds"] for g in kept), 1),
                 dropped=data.get("dropped") or {"speaker": 0, "words": 0, "sound": 0}, language=lang)
    kept_s = sum(g["seconds"] for g in kept)
    _train(job, out, emit, ctl, ears, spk, lim, dev, rnd, segs, kept, kept_s, lang, centroid, resume, t_start)


def _cut_as(job: dict, out: Path, seg_dir: Path, emit: Emit, ctl: Control) -> None:
    """another run's utterances of the same recordings (their places and words) cut again from this run's copies:
    no listening twice"""
    data = json.loads(Path(job["shared_data"]).read_text())
    by_file = {src.get("file") or Path(src["path"]).name: src["path"] for src in job["inputs"]}
    if not all(g.get("file") in by_file for g in data["segments"]):
        return  # (not the same recordings after all: heard again)
    cache: dict[str, np.ndarray] = {}
    for i, g in enumerate(data["segments"]):
        if i % 50 == 0:
            ctl.check()
            emit(stage="prepare", done=i, total=len(data["segments"]))
        x = cache.get(g["file"])
        if x is None:
            cache.clear()
            x = cache[g["file"]] = _wav(by_file[g["file"]], SR)
        p = seg_dir / f"{g['id']}.wav"
        sf.write(str(p), x[int(g["start"] * SR):int(g["end"] * SR)], SR, subtype="PCM_16")
        g["path"] = str(p)
    (out / "data.json").write_text(json.dumps(data, ensure_ascii=False))


def _gather(job: dict, out: Path, seg_dir: Path, emit: Emit, ctl: Control, ears: "Ears", spk: "Speakers",
            lim: dict) -> tuple[list[dict], list[dict], str, np.ndarray]:
    """prepare, transcribe, screen → (every utterance, those kept, the language, her speaker centroid)"""
    # ── prepare: her recordings → utterances ──
    segs: list[dict] = []
    total_s = 0.0
    for fi, src in enumerate(job["inputs"]):
        ctl.check()
        x = _wav(src["path"], SR)
        total_s += len(x) / SR
        for s, e in segment.speech_segments(x, SR):
            p = seg_dir / f"u{len(segs):05d}.wav"
            sf.write(str(p), x[s:e], SR, subtype="PCM_16")
            segs.append({"id": p.stem, "path": str(p), "source": src.get("name") or Path(src["path"]).name,
                         "file": src.get("file") or Path(src["path"]).name,
                         "start": round(s / SR, 2), "end": round(e / SR, 2), "seconds": round((e - s) / SR, 2)})
        emit(stage="prepare", done=fi + 1, total=len(job["inputs"]), recorded_s=round(total_s, 1),
             found=len(segs), found_s=round(sum(g["seconds"] for g in segs), 1))
    if not segs:
        raise RunError("No speech was found in the recordings", "no_speech")

    # ── transcribe ──
    w16 = [_wav(g["path"], 16000) for g in segs]
    lang = job.get("language") or "auto"
    if lang == "auto":
        lang = ears.language(w16)
    def heard(n: int) -> None:
        ctl.check()
        emit(stage="transcribe", done=n, total=len(segs), language=lang)

    words = ears.hear(w16, lang, heard)
    ears.off()
    for g, t in zip(segs, words):
        g["text"] = t

    # ── screen: only her, only words that are sure ──
    embs = np.stack([spk.embed(w) for w in w16])
    keep = np.ones(len(segs), bool)
    for _ in range(3):  # (the dominant speaker: the mean of the closest, three times over)
        c = embs[keep].mean(0)
        c /= np.linalg.norm(c) + 1e-9
        sims = embs @ c
        keep = sims >= np.quantile(sims, 0.2) if len(segs) >= 10 else np.ones(len(segs), bool)
    c = embs[keep].mean(0)
    c /= np.linalg.norm(c) + 1e-9
    sims = embs @ c
    floor = max(0.4, float(np.median(sims)) - 0.18)
    dropped = {"speaker": 0, "words": 0, "sound": 0}
    for g, w, sim in zip(segs, w16, sims):
        g["similarity"] = round(float(sim), 3)
        n_chars = len(texts.norm(g["text"]))
        cps = n_chars / max(0.1, g["seconds"])
        peak_share = float(np.mean(np.abs(w) > 0.995))
        level = 20 * math.log10(float(np.sqrt(np.mean(w * w))) + 1e-9)
        if sim < floor:
            g["left_out"] = "speaker"
        elif not n_chars or cps < 1.0 or cps > 30 or _repeats(g["text"]):
            g["left_out"] = "words"
        elif peak_share > 0.005 or level < -45:
            g["left_out"] = "sound"
        if g.get("left_out"):
            dropped[g["left_out"]] += 1
    kept = [g for g in segs if not g.get("left_out")]
    max_s = float(lim.get("max_minutes", 90)) * 60
    if sum(g["seconds"] for g in kept) > max_s:  # (the most like her, up to the limit)
        kept.sort(key=lambda g: -g["similarity"])
        acc, cut = 0.0, []
        for g in kept:
            if acc >= max_s:
                g["left_out"] = "enough"
                continue
            cut.append(g)
            acc += g["seconds"]
        kept = cut
    kept_s = sum(g["seconds"] for g in kept)
    (out / "data.json").write_text(json.dumps({"language": lang, "segments": segs, "dropped": dropped}, ensure_ascii=False))
    emit(stage="screen", kept=len(kept), kept_s=round(kept_s, 1), dropped=dropped, language=lang)
    if kept_s < float(lim.get("min_seconds", 60)):
        raise RunError("Too little of her speech is left to learn from", "too_little", kept_s=round(kept_s, 1))
    centroid = np.stack([embs[i] for i, g in enumerate(segs) if not g.get("left_out")]).mean(0)
    centroid /= np.linalg.norm(centroid) + 1e-9
    return segs, kept, lang, centroid


def _train(job: dict, out: Path, emit: Emit, ctl: Control, ears: "Ears", spk: "Speakers", lim: dict,
           dev: torch.device, rnd: random.Random, segs: list[dict], kept: list[dict], kept_s: float, lang: str,
           centroid: np.ndarray, resume: dict | None, t_start: float) -> None:
    state_dir = out / "state"
    rec: Recipe = recipe_for(job.get("engine") or "omnivoice")(job, dev, lang, lim)
    conditions = rec.conditions
    # ── tokens ──
    rec.load()

    def tokens_at(n: int) -> None:
        ctl.check()
        emit(stage="tokens", done=n, total=len(kept))

    rec.tokens(kept, tokens_at)

    # ── the references a run is measured with: her own clip when the voice has one, a long and a short utterance ──
    def best_of(lo: float, hi: float, near: float | None = None) -> dict:
        pool = [g for g in kept if lo <= g["seconds"] <= hi] or kept
        if near is not None:
            return sorted(pool, key=lambda g: (abs(g["seconds"] - near), -g["similarity"]))[0]
        return sorted(pool, key=lambda g: -g["similarity"])[0]

    ref = job.get("reference") or {}
    long_ref = {"path": ref["path"], "text": ref["text"]} if ref.get("path") and ref.get("text") else best_of(5, 12)
    long_ref = {**long_ref, "seconds": round(_wav(long_ref["path"], SR).size / SR, 2)}
    short_ref = best_of(2, 4.5, near=3.0)
    refs = {"long": long_ref, "short": short_ref, "none": None}
    prompts = {c: rec.prompt(refs[c]) for c in conditions}
    sentences = list(texts.eval_texts(lang))
    samples_dir = out / "samples"
    samples_dir.mkdir(exist_ok=True)
    shown = [c for c in ("long", "none", "short") if c in conditions][:2]  # (the A/B samples kept)

    def measure() -> dict:
        rec.training(False)
        rec.measuring(True)
        made = {c: rec.speak(sentences, prompts[c], ctl.check) for c in conditions}
        rec.measuring(False)
        if dev.type == "cuda":
            torch.cuda.empty_cache()
        res: dict[str, Any] = {}
        heard_all = ears.hear([soxr.resample(w, rec.sr, 16000) for c in conditions for w in made[c]], lang)
        ears.off()
        k = 0
        for cond in conditions:
            sims = [float(spk.embed(soxr.resample(w, rec.sr, 16000)) @ centroid) for w in made[cond]]
            cers = [texts.cer(t, heard_all[k + i]) for i, t in enumerate(sentences)]
            k += len(sentences)
            res[cond] = {"similarity": round(float(np.mean(sims)), 4), "worst": round(float(np.min(sims)), 4),
                         "cer": round(float(np.mean(cers)), 4)}
        res["_made"] = made
        return res

    def keep_samples(which: str, made: dict) -> None:
        for cond in shown:
            for i, w in enumerate(made[cond][:2]):
                sf.write(str(samples_dir / f"{which}-{cond}-{i}.wav"), w, rec.sr, subtype="PCM_16")

    if resume is None:
        base = measure()
        keep_samples("base", base.pop("_made"))
        emit(stage="baseline", metrics=base, references={"long_s": long_ref["seconds"], "short_s": short_ref["seconds"]})
    else:
        base = resume["base"]

    # ── train ──
    rank = int(lim.get("rank", 16))
    trainable = rec.wrap(rank)
    lens = rec.lengths()
    order = sorted(range(len(lens)), key=lambda i: lens[i])
    budget = int(lim.get("batch_tokens", rec.batch_tokens))

    def epoch_batches() -> list[list[int]]:
        groups, cur, longest = [], [], 0
        for i in order:
            n = lens[i]
            if cur and max(longest, n) * (len(cur) + 1) > budget:
                groups.append(cur)
                cur, longest = [], 0
            cur.append(i)
            longest = max(longest, n)
        if cur:
            groups.append(cur)
        rnd.shuffle(groups)
        return groups

    per_epoch = len(epoch_batches())
    if resume is None:
        steps = segment.steps_for(per_epoch, epochs=int(lim.get("epochs", rec.epochs)), least=int(lim.get("min_steps", 200)),
                                  most=int(lim.get("max_steps", 1500)))
        every = segment.eval_every(steps)
    else:
        steps, every = int(resume["steps"]), int(resume["every"])
    lr = float(lim.get("lr", 1e-4))
    opt = torch.optim.AdamW(trainable, lr=lr, weight_decay=0.01)
    warm = max(1, int(steps * 0.03))
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: (s + 1) / warm if s < warm else 0.5 * (1 + math.cos(math.pi * min(1.0, (s - warm) / max(1, steps - warm)))))
    base_cer = {c: base[c]["cer"] for c in conditions}
    score = lambda m: sum(m[c]["similarity"] for c in conditions)  # noqa: E731
    best: dict[str, Any] = {"step": 0, "score": score(base), "metrics": base}
    evals: list[dict] = []
    step, queue, losses = 0, [], []
    if resume is not None:
        st = torch.load(str(state_dir / "train.pt"), map_location="cpu", weights_only=False)
        rec.load_lora_state(st["lora"])
        opt.load_state_dict(st["opt"])
        sched.load_state_dict(st["sched"])
        rnd.setstate(st["rng"])
        step, best, evals = int(resume["step"]), resume["best"], resume["evals"]

    def save_state() -> None:
        """where it is: the adapter and the optimiser as they are, to go on from (each evaluation, and on leaving)"""
        state_dir.mkdir(exist_ok=True)
        tmp = state_dir / "train.pt.part"
        torch.save({"lora": rec.lora_state(), "opt": opt.state_dict(), "sched": sched.state_dict(),
                    "rng": rnd.getstate()}, str(tmp))
        tmp.replace(state_dir / "train.pt")
        (state_dir / "state.json").write_text(json.dumps({"step": step, "steps": steps, "every": every, "best": best,
                                                          "evals": evals, "base": base}, ensure_ascii=False))
    t_train = time.time()
    paused_s = 0.0
    pause_at = [0.0]

    def on_pause(p: bool) -> None:
        nonlocal paused_s
        if p:
            pause_at[0] = time.time()
            emit(stage="paused", step=step)
        else:
            paused_s += time.time() - pause_at[0]
            emit(stage="resumed", step=step)

    emit(stage="train", step=step, steps=steps, every=every, per_epoch=per_epoch, resumed=resume is not None,
         trainable_m=round(sum(p.numel() for p in trainable) / 1e6, 2))
    rec.training(True)
    try:
        while step < steps:
            ctl.check(on_pause)
            if not queue:
                queue = epoch_batches()
            rec.progress = step / max(1, steps)  # (how far along: VoxCPM2's objective changes with it)
            loss = rec.loss(queue.pop())
            loss.backward()
            torch.nn.utils.clip_grad_norm_(trainable, 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            step += 1
            losses.append(float(loss))
            if step % 10 == 0:
                spent = time.time() - t_train - paused_s
                emit(stage="train", step=step, steps=steps, loss=round(sum(losses[-10:]) / len(losses[-10:]), 4),
                     eta_s=round(spent / step * (steps - step) + (steps - step) / every * 20, 0),
                     vram_gb=round(torch.cuda.max_memory_allocated() / 2**30, 2) if dev.type == "cuda" else None)
            last_eval = evals[-1]["step"] if evals else 0
            if step % every == 0 or (step == steps and steps - last_eval > every // 2):
                m = measure()
                made = m.pop("_made")
                rec.training(True)
                # (never less intelligible, nor noticeably less like her with any reference — only better overall)
                fair = all(m[c]["cer"] <= base_cer[c] + 0.03 and m[c]["similarity"] >= base[c]["similarity"] - 0.02
                           for c in conditions)
                better = fair and score(m) > best["score"]
                evals.append({"step": step, "metrics": m, "best": better})
                if better:
                    best = {"step": step, "score": score(m), "metrics": m}
                    rec.save(out / "best")
                    keep_samples("tuned", made)
                emit(stage="eval", step=step, steps=steps, metrics=m, best=better)
            if step % every == 0 and step < steps:
                save_state()
    except Released:
        save_state()  # (the GPU is wanted elsewhere: from this step, later)
        raise

    # ── done ──
    improved = best["step"] > 0
    if improved:
        adapter = out / "adapter"
        shutil.rmtree(adapter, ignore_errors=True)
        shutil.copytree(out / "best", adapter)
        rec.export(adapter)
        (adapter / "geny.json").write_text(json.dumps({
            "engine": rec.engine, "model_id": job.get("model_id", ""), "base_revision": job.get("base_revision", ""),
            "language": lang, "step": best["step"], "rank": rank, "conditions": list(conditions),
            "metrics": {"base": base, "tuned": best["metrics"]}, "kept_s": round(kept_s, 1),
            "made_at": time.strftime("%Y-%m-%dT%H:%M:%S")}, ensure_ascii=False))
    shutil.rmtree(out / "best", ignore_errors=True)
    shutil.rmtree(state_dir, ignore_errors=True)
    emit(stage="done", improved=improved, best_step=best["step"], steps=steps, base=base, tuned=best["metrics"],
         evals=evals, kept_s=round(kept_s, 1), language=lang, minutes=round((time.time() - t_start) / 60, 1),
         conditions=list(conditions))
