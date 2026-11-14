"""Engine worker: one process per loaded model, inside that engine's own Python environment (docs/local-voice.md).

Started as ``python -m app.voicehost.worker --engine <name>`` with only the backend's source on its path (nothing of
the server's own packages): it connects back to the server on 127.0.0.1:GENY_VOICE_PORT, says GENY_VOICE_TOKEN, and
then reads one JSON object per line and answers one per line on that connection — the same on Linux, Windows and
macOS. stdout and stderr stay free for the libraries' own logging, which the server copies to its log.

Requests: {"id": n, "op": ..., ...}. Responses: {"id": n, "ok": true, "result": {...}} or
{"id": n, "ok": false, "error": "...", "kind": "user"|"internal"}.

ops: hello, load, warmup, synthesize, transcribe, park, resume, memory, shutdown
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from typing import Any

ENGINES = {
    "fake": ("app.voicehost.worker.engines.fake", "FakeEngine"),
    "qwen3_tts": ("app.voicehost.worker.engines.qwen3_tts", "Qwen3TTSEngine"),
    "omnivoice": ("app.voicehost.worker.engines.omnivoice", "OmniVoiceEngine"),
    "cosyvoice3": ("app.voicehost.worker.engines.cosyvoice3", "CosyVoice3Engine"),
    "whisper": ("app.voicehost.worker.engines.whisper", "WhisperEngine"),
}


class _CpuOnly:
    """Device stand-in for the fake engine, which must run without torch."""

    device = "cpu"
    is_cuda = False
    name = "CPU (fake)"

    def describe(self) -> dict[str, Any]:
        return {"device": "cpu", "dtype": "float32", "name": self.name, "capability": None, "total_bytes": 0}


class Worker:
    def __init__(self, engine_name: str) -> None:
        self.engine_name = engine_name
        self.engine = None
        self.dev = None
        self.parker = None
        self.rt = None
        if engine_name != "fake":
            from . import runtime

            self.rt = runtime
            self.parker = runtime.Parker()

    # -- helpers -------------------------------------------------------------------------------------------------
    def _mem(self) -> dict[str, Any]:
        if self.rt is None or self.dev is None:
            return {}
        out = self.rt.memory(self.dev)
        out.update(self.rt.device_free(self.dev))
        return out

    def _sync(self) -> None:
        if self.rt is not None and self.dev is not None:
            self.rt.sync(self.dev)

    # -- ops -----------------------------------------------------------------------------------------------------
    def op_hello(self, msg: dict) -> dict:
        info: dict[str, Any] = {"engine": self.engine_name, "python": sys.version.split()[0], "pid": os.getpid()}
        if self.rt is not None:
            import torch

            info["torch"] = torch.__version__
            info["cuda"] = torch.version.cuda
            info["cuda_available"] = torch.cuda.is_available()
            info["devices"] = [
                {"index": i, "name": torch.cuda.get_device_name(i),
                 "capability": list(torch.cuda.get_device_capability(i)),
                 "total_bytes": torch.cuda.get_device_properties(i).total_memory}
                for i in range(torch.cuda.device_count())
            ]
        return info

    def op_load(self, msg: dict) -> dict:
        import importlib

        t0 = time.perf_counter()
        if self.rt is not None:
            self.dev = self.rt.pick_device(msg.get("device", "cuda:0"), msg.get("dtype", "auto"))
            self.rt.reset_peak(self.dev)
            frac = (msg.get("options") or {}).get("vram_fraction")
            if frac and self.dev.is_cuda:
                import torch

                # Hard ceiling for this process: it was admitted with this much; an oversize request fails here
                # (clean "out of memory" error) instead of squeezing other models or other programs on the GPU.
                torch.cuda.set_per_process_memory_fraction(float(frac))
        else:
            self.dev = _CpuOnly()
        mod_name, cls_name = ENGINES[self.engine_name]
        cls = getattr(importlib.import_module(mod_name), cls_name)
        t_import = time.perf_counter() - t0
        self.engine = cls(msg["model_dir"], self.dev, msg.get("options") or {})
        self.engine.load()
        self._sync()
        t_load = time.perf_counter() - t0 - t_import
        res = {"seconds": time.perf_counter() - t0, "import_seconds": t_import, "load_seconds": t_load,
               "device": self.dev.describe(), "sample_rate": self.engine.sample_rate, "memory": self._mem()}
        if msg.get("warmup", True):
            res["warmup_seconds"] = self._warmup()
            res["memory_after_warmup"] = self._mem()
        if self.rt is not None:
            self.rt.release_cache(self.dev)
            res["memory_idle"] = self._mem()
        return res

    def _warmup(self) -> float:
        t0 = time.perf_counter()
        self.engine.warmup()
        self._sync()
        return time.perf_counter() - t0

    def op_warmup(self, msg: dict) -> dict:
        return {"seconds": self._warmup()}

    def op_synthesize(self, msg: dict) -> dict:
        import numpy as np
        import soundfile as sf

        from .engines.base import Reference, SynthRequest

        self._require_ready()
        ref = msg.get("reference")
        req = SynthRequest(
            text=list(msg["text"]),
            language=msg.get("language") or "auto",
            reference=Reference(**ref) if ref else None,
            instruct=msg.get("instruct") or "",
            params=msg.get("params") or {},
        )
        seed = msg.get("seed")
        if seed is None:
            seed = int.from_bytes(os.urandom(4), "little") & 0x7FFFFFFF
        if self.rt is not None:
            self.rt.seed_everything(int(seed))
            self.rt.reset_peak(self.dev)
        t0 = time.perf_counter()
        wavs = self.engine.synthesize(req)
        self._sync()
        elapsed = time.perf_counter() - t0
        paths = []
        for i, w in enumerate(wavs):
            path = f"{msg['out_prefix']}.{i}.wav"
            sf.write(path, np.asarray(w, dtype=np.float32), self.engine.sample_rate, subtype="FLOAT")
            paths.append(path)
        total = sum(len(w) for w in wavs) / self.engine.sample_rate
        return {"paths": paths, "sample_rate": self.engine.sample_rate, "seconds": elapsed, "audio_seconds": total,
                "seed": int(seed), "memory": self._mem()}

    def op_transcribe(self, msg: dict) -> dict:
        self._require_ready()
        t0 = time.perf_counter()
        out = self.engine.transcribe(msg["path"], msg.get("language") or "auto")
        out["seconds"] = time.perf_counter() - t0
        return out

    def op_park(self, msg: dict) -> dict:
        self._require_ready()
        if self.parker is None or not self.dev.is_cuda:
            return {"seconds": 0.0, "parked": False}
        self.engine.on_park()
        s = self.parker.park(self.engine.modules())
        self.rt.release_cache(self.dev)
        return {"seconds": s, "parked": True, "memory": self._mem()}

    def op_resume(self, msg: dict) -> dict:
        self._require_ready()
        if self.parker is None or not self.parker.parked:
            return {"seconds": 0.0}
        s = self.parker.resume(self.engine.modules(), self.dev.device)
        return {"seconds": s, "memory": self._mem()}

    def op_trim(self, msg: dict) -> dict:
        """Give cached-but-free CUDA blocks back to the driver (after a long generation inflated the pool)."""
        if self.rt is not None and self.dev is not None:
            self.rt.release_cache(self.dev)
        return {"memory": self._mem()}

    def op_memory(self, msg: dict) -> dict:
        return {"memory": self._mem()}

    def _require_ready(self) -> None:
        if self.engine is None:
            raise RuntimeError("model is not loaded")


def _trim_host_heap() -> None:
    """Return freed heap to the OS. Loaders build CPU copies of the weights before moving them to the GPU; Python
    frees them but glibc keeps the pages (CosyVoice3: 4.9 GB RSS after load, 2.1 GB after this). Linux only (glibc)."""
    import ctypes
    import gc

    gc.collect()
    if not sys.platform.startswith("linux"):
        return
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):
        pass


_peak_seen = 0


def _rss(field: str = "VmRSS") -> int:
    """VmRSS: resident now; VmHWM: the most this process has ever held (the loader's peak). /proc on Linux; elsewhere
    psutil when the engine's environment has it (the peak is then the largest seen at a reply)."""
    global _peak_seen
    try:
        for line in open("/proc/self/status"):
            if line.startswith(field + ":"):
                return int(line.split()[1]) * 1024
    except OSError:
        pass
    try:
        import psutil

        rss = int(psutil.Process().memory_info().rss)
    except Exception:  # noqa: BLE001 - no psutil here: unknown
        return 0
    _peak_seen = max(_peak_seen, rss)
    return _peak_seen if field == "VmHWM" else rss


class UserError(Exception):
    pass


def _connect():
    """The line back to the server: 127.0.0.1:GENY_VOICE_PORT, first line GENY_VOICE_TOKEN."""
    import socket

    port = int(os.environ["GENY_VOICE_PORT"])
    token = os.environ.get("GENY_VOICE_TOKEN", "")
    sock = socket.create_connection(("127.0.0.1", port), timeout=30)
    sock.settimeout(None)
    rf = sock.makefile("r", encoding="utf-8", newline="\n")
    wf = sock.makefile("w", encoding="utf-8", newline="\n")
    wf.write(json.dumps({"token": token, "pid": os.getpid()}) + "\n")
    wf.flush()
    return sock, rf, wf


def main() -> None:
    import faulthandler

    if hasattr(faulthandler, "register"):
        import signal

        faulthandler.register(signal.SIGUSR1, all_threads=True)  # `kill -USR1 <pid>`: dump every thread's stack
    engine = sys.argv[sys.argv.index("--engine") + 1]
    _sock, rf, wf = _connect()
    worker = Worker(engine)
    for line in rf:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        op = msg.get("op")
        if op == "shutdown":
            wf.write(json.dumps({"id": msg.get("id"), "ok": True, "result": {}}) + "\n")
            wf.flush()
            # Libraries leave non-daemon threads behind (tokenizers, CosyVoice's LLM thread); a normal interpreter
            # exit waits for them. The driver frees the GPU memory as soon as the process is gone.
            sys.stdout.flush()
            sys.stderr.flush()
            os._exit(0)
        try:
            fn = getattr(worker, f"op_{op}")
            result = fn(msg)
            if op in ("load", "park", "resume", "trim"):
                _trim_host_heap()
            if isinstance(result, dict):
                result["host_rss"] = _rss()
                result["host_peak"] = _rss("VmHWM")
            resp = {"id": msg.get("id"), "ok": True, "result": result}
        except (ValueError, UserError) as e:
            resp = {"id": msg.get("id"), "ok": False, "error": str(e), "kind": "user"}
        except Exception as e:  # noqa: BLE001 - the server decides what to do with an engine failure
            traceback.print_exc()
            oom = "out of memory" in str(e).lower()
            resp = {"id": msg.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}",
                    "kind": "oom" if oom else "internal"}
            if oom and worker.rt is not None and worker.dev is not None:
                worker.rt.release_cache(worker.dev)
        wf.write(json.dumps(resp, ensure_ascii=False) + "\n")
        wf.flush()


if __name__ == "__main__":
    main()
