"""Install local voice models from this platform's lock file and make them speak and hear — for real, through the
service the app uses (install → load → a line in a built-in voice → its words heard back).

    python tools/voice_smoke.py --home /tmp/voice-smoke --model omnivoice --model whisper-large-v3-turbo

CI runs it on Windows and macOS (.github/workflows/voice-local.yml), where the lock files can't be checked any other
way. Those machines have no NVIDIA GPU: the gate, which asks for one, is passed over and the engines run on the CPU —
or on an Apple Silicon Mac's GPU (Metal) where the machine has one (``--device mps``; Metal unavailable → the CPU).
Exit 0 only when every model installed and every line came out as speech (and was heard back, with Whisper)."""

from __future__ import annotations

import argparse
import asyncio
import io
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

LINE = "안녕하세요. 오늘은 이 컴퓨터에서 직접 말하고 있어요."


def _say(*a: object) -> None:
    print(*a, flush=True)


async def main(args: argparse.Namespace) -> int:
    import numpy as np
    import soundfile as sf

    from app.db import Database
    from app.voicehost import catalog, gate as G, system
    from app.voicehost.installer import RUNTIME_OF
    from app.voicehost.service import VoiceHost
    from app.voicehost.settings import VoiceSettings

    home = Path(args.home).resolve()
    s = VoiceSettings(home=home, engine_mode="real", device=args.device, idle_unload_seconds=0, park_ram_gb=0)
    s.ensure_dirs()
    here = G.check("real", args.device)
    _say(f"platform {system.platform_key()} · gate here: {here.code} — {here.message}")
    _say(f"GPUs: {[g.to_dict() for g in system.gpus(max_age=0.0)]}")
    if not here.ok:
        # (no NVIDIA GPU on these machines, or a virtual Mac with 7 GB: the engines run on what there is — the gate
        # and the room the GPU placement would want are passed over; what is checked is the environment and the engine)
        from app.voicehost.host import EngineManager

        G.check = lambda engine_mode="real", device="": G.Gate(True, "ok", "smoke: the gate is passed over")

        async def no_room_check(self, need, exclude):
            return None

        EngineManager._make_room = no_room_check
    db = Database(home / "smoke.db")
    db.bootstrap()
    h = VoiceHost(db, s)
    await h.start()
    failed: list[str] = []
    try:
        for mid in args.model:
            spec = catalog.BY_ID[mid]
            t0, last = time.monotonic(), ""
            h.install(mid, accept_license=True)
            while True:
                await asyncio.sleep(5)
                st = h.installer.status(spec)
                p = st.get("progress") or {}
                line = f"{mid}: {p.get('state')} {p.get('message', '')} {p.get('done_bytes', 0) >> 20} MB"
                if line != last:
                    _say(f"  [{time.monotonic() - t0:5.0f}s] {line}")
                    last = line
                if p.get("state") in ("done", "error", "cancelled") or (st["installed"] and p.get("state") != "weights"):
                    break
            if not h.installer.status(spec)["installed"]:
                _say(f"INSTALL FAILED {mid}: {p.get('error')}\n" + "\n".join((p.get("log") or [])[-30:]))
                failed.append(f"install {mid}")
                continue
            _say(f"installed {mid} in {time.monotonic() - t0:.0f}s (lock {h.installer.lock_path(RUNTIME_OF[spec.engine]).name})")

        spoken: bytes | None = None
        for mid in [m for m in args.model if catalog.BY_ID[m].kind == "tts" and f"install {m}" not in failed]:
            t0 = time.monotonic()
            try:
                e = await h.generate(model_id=mid, text=LINE, voice_id="builtin:chaerin", feeling="joy", language="ko",
                                     mode="clone")
            except Exception as x:  # noqa: BLE001
                _say(f"SPEAK FAILED {mid}: {x}")
                failed.append(f"speak {mid}")
                continue
            data = h.history.path(e).read_bytes()
            x, sr = sf.read(io.BytesIO(data), dtype="float32")
            rms = float(np.sqrt(np.mean(np.square(x)))) if len(x) else 0.0
            dev = next((r["device"] for r in h.engines.status() if r["model_id"] == mid), {})
            _say(f"spoke {mid}: {len(x) / sr:.2f}s of audio, rms {rms:.3f}, made in {e['generate_seconds']}s "
                 f"(RTF {e['rtf']}) on {dev} · wall {time.monotonic() - t0:.0f}s")
            if len(x) / sr < 1.0 or rms < 0.005:
                failed.append(f"speech {mid}: {len(x) / sr:.2f}s rms {rms:.4f}")
            spoken = spoken or data
            await h.engines.unload(mid)  # (one model at a time: a CI machine's memory is small)

        for mid in [m for m in args.model if catalog.BY_ID[m].kind == "stt" and f"install {m}" not in failed]:
            if spoken is None:  # (no speech model here: a built-in voice's clip)
                spoken = (Path(__file__).resolve().parents[1] / "app/mate/builtin/voices/chaerin/joy.wav").read_bytes()
            t0 = time.monotonic()
            try:
                r = await h.transcribe(spoken, language="ko", model_id=mid, source="smoke")
            except Exception as x:  # noqa: BLE001
                _say(f"HEAR FAILED {mid}: {x}")
                failed.append(f"hear {mid}")
                continue
            dev = next((x["device"] for x in h.engines.status() if x["model_id"] == mid), {})
            _say(f"heard with {mid} in {time.monotonic() - t0:.0f}s on {dev}: {r['text']!r} ({r.get('language')})")
            if not r["text"].strip():
                failed.append(f"hear {mid}: nothing")
    finally:
        await h.stop()
    _say("RESULT: " + ("ok" if not failed else "FAILED — " + "; ".join(failed)))
    return 0 if not failed else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", required=True)
    ap.add_argument("--model", action="append", required=True)
    ap.add_argument("--device", default="cuda:0")
    sys.exit(asyncio.run(main(ap.parse_args())))
