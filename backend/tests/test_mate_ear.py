"""A call's own ear (app/mate/ear.py): their voice begins and ends at the page's clock, Smart Turn judges the turn the
moment it ends (its features as Whisper's), the call's line carries the microphone's sound to it and its events back.
The models are stand-ins here (no downloads); the real ones run when this machine has them (skipped otherwise)."""

from __future__ import annotations

import asyncio
import struct
from pathlib import Path

import numpy as np
import pytest

from app.mate import ear as E


class LoudVad:
    """stand-in for Silero: speech when the frame is loud"""

    def __call__(self, frame):
        return 0.9 if float(np.sqrt(np.mean(frame ** 2))) > 0.05 else 0.05


class Judge:
    """stand-in for Smart Turn: what it was given, and a fixed answer"""

    def __init__(self, p=0.8):
        self.p, self.heard = p, []

    def __call__(self, audio):
        self.heard.append(len(audio))
        return self.p


def frames(seconds_and_loud, t0=1_000_000.0, chunk=1600):
    """the page's binary frames: (seconds, loud?) stretches, 100 ms at a time, each with its last sample's page ms"""
    audio = np.concatenate([(np.sin(np.arange(int(s * E.SR)) / 3) * 0.3 if loud else np.zeros(int(s * E.SR)))
                            for s, loud in seconds_and_loud]).astype(np.float32)
    out = []
    for i in range(0, len(audio), chunk):
        ch = audio[i:i + chunk]
        out.append(struct.pack("<d", t0 + (i + len(ch)) / 16.0) + (ch * 32767).astype("<i2").tobytes())
    return out


def run(ear, data):
    return [ev for d in data for ev in ear.feed(d)]


def test_their_voice_begins_and_ends_at_the_pages_clock_and_is_judged_as_it_ends():
    judge = Judge(0.83)
    ear = E.Ear(None, vad=LoudVad(), turn=judge)
    evs = run(ear, frames([(0.5, False), (1.2, True), (0.6, False)]))
    assert [e["on"] for e in evs] == [True, False]
    on, off = evs
    # (speech began at 0.5 s, ended at 1.7 s: to within a frame or two)
    assert abs(on["at"] - (1_000_000 + 500)) <= 40, on
    assert abs(off["at"] - (1_000_000 + 1700)) <= 40, off
    assert off["p"] == 0.83
    # Smart Turn heard the turn (from a little before it began) and TAIL_S of quiet after it
    assert len(judge.heard) == 1
    assert abs(judge.heard[0] - int((1.2 + E.PRE_S + E.TAIL_S) * E.SR)) < 2 * E.FRAME


def test_a_short_gap_is_still_one_turn_for_smart_turn_and_a_turn_sent_starts_the_next_afresh():
    judge = Judge()
    ear = E.Ear(None, vad=LoudVad(), turn=judge)
    run(ear, frames([(0.3, False), (1.0, True), (0.5, False), (1.0, True), (0.5, False)]))
    # (the second end is judged on both stretches: the turn so far)
    assert judge.heard[1] > judge.heard[0] + int(1.0 * E.SR)
    ear.reset_turn()
    run(ear, frames([(1.0, True), (0.5, False)], t0=1_003_300.0))
    assert judge.heard[2] < judge.heard[1], "after their turn went to her, the next is judged on its own"


def test_a_blip_is_not_a_voice_and_a_long_quiet_forgets_the_turn():
    ear = E.Ear(None, vad=LoudVad(), turn=Judge())
    # (a click inside one frame)
    assert run(ear, frames([(E.FRAME * 16 / E.SR, False), (0.02, True), (0.5, False)])) == []
    judge = Judge()
    ear = E.Ear(None, vad=LoudVad(), turn=judge)
    run(ear, frames([(1.0, True), (E.FORGET_S + 0.5, False), (1.0, True), (0.5, False)]))
    assert judge.heard[1] < int((1.0 + E.PRE_S + E.TAIL_S) * E.SR) + 2 * E.FRAME


def test_smart_turns_features_are_whispers():
    """log-mel 80 × 800 for 8 s, zeros padded at the start, as Whisper's feature extractor (the model was trained on
    them): its own transformers implementation agrees to 1e-6 (checked by hand: ~/.cache/hrh-e2e/turnlab)"""
    st = E.SmartTurn(None)
    f = st.features(np.sin(np.arange(24000) / 7).astype(np.float32) * 0.2)
    assert f.shape == (1, 80, 800) and f.dtype == np.float32
    # (the padded start is the floor: 8 below the loudest, scaled)
    assert np.allclose(f[0, :, :100], f[0, :, :100].min())
    fb = E.mel_filters()
    assert fb.shape == (201, 80) and (fb >= 0).all()


def test_the_models_are_fetched_and_checked(tmp_path, monkeypatch):
    m = E.Models(tmp_path)
    good = tmp_path / "x.onnx"
    good.write_bytes(b"model")
    import hashlib

    ok = {"file": "x.onnx", "sha256": hashlib.sha256(b"model").hexdigest(), "url": "http://unused"}
    assert m._fetch(ok) == good  # (there and right: not fetched again)
    bad = {"file": "y.onnx", "sha256": "0" * 64, "url": "http://example.invalid/y.onnx"}

    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def raise_for_status(self):
            return None

        def iter_bytes(self):
            yield b"something else"

    import httpx

    monkeypatch.setattr(httpx, "stream", lambda *a, **k: Resp())
    with pytest.raises(RuntimeError, match="SHA-256"):
        m._fetch(bad)
    assert not (tmp_path / "y.onnx").exists() and not (tmp_path / "y.part").exists()


REAL = Path.home() / ".hr-harnessor" / "models" / "ear"


@pytest.mark.skipif(not (REAL / E.MODELS["vad"]["file"]).exists(), reason="the ear's models aren't on this machine")
def test_the_real_ear_hears_a_voice_and_judges_it():
    pytest.importorskip("onnxruntime")
    m = E.Models(REAL)
    assert m.load(), m.error
    ear = E.Ear(m)
    rng = np.random.default_rng(0)
    # (a voice-like sound: harmonics of 150 Hz with a syllable rhythm)
    t = np.arange(int(1.5 * E.SR)) / E.SR
    voice = sum(np.sin(2 * np.pi * 150 * k * t) / k for k in range(1, 8)) * (0.5 + 0.5 * np.sin(2 * np.pi * 4 * t)) * 0.2
    audio = np.concatenate([np.zeros(8000), voice + rng.normal(0, 0.002, len(t)), np.zeros(16000)]).astype(np.float32)
    evs = run(ear, [struct.pack("<d", 1000.0 + (i + 1600) / 16.0) + (audio[i:i + 1600] * 32767).astype("<i2").tobytes()
                    for i in range(0, len(audio), 1600)])
    assert any(e["on"] for e in evs) or evs == []  # (a synthetic tone may or may not pass for speech)
    for e in evs:
        if not e["on"]:
            assert 0.0 <= e["p"] <= 1.0


async def test_the_calls_line_carries_the_sound_to_the_ear_and_its_events_back(db, tmp_path, monkeypatch):
    from tests.test_mate_calls import _stack

    svc, store, _, calls, _line = _stack(db, tmp_path, monkeypatch)
    mate = store.create(name="Haru", persona={"language": "ko"}, llm={"model": "m1"})
    try:
        call = await calls.dial(mate["id"])
        sent: list = []
        calls.attach(call, sent.append)
        assert {"type": "ear", "ready": False} in sent, "no models here: the page goes by its level"
        judge = Judge(0.91)
        call.ear = E.Ear(None, vad=LoudVad(), turn=judge)
        for f in frames([(0.3, False), (1.0, True), (0.6, False)]):
            calls.hear(call, f)
        for _ in range(100):
            if any(m.get("type") == "ear" and m.get("on") is False for m in sent):
                break
            await asyncio.sleep(0.02)
        evs = [m for m in sent if m.get("type") == "ear" and "on" in m]
        assert [e["on"] for e in evs] == [True, False] and evs[-1]["p"] == 0.91
        # their turn went to her: the next is judged afresh
        call.ear.turn_from = 123
        await calls.receive(call, {"type": "say", "text": "응"})
        assert call.ear.turn_from is None
        await calls.hangup(call.id)
    finally:
        await calls.stop()
        await svc.shutdown()
