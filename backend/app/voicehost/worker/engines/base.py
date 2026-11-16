"""The contract every engine runtime implements inside its worker process."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np


@dataclass
class Reference:
    path: str
    text: str = ""
    language: str = ""

    def key(self, *extra: Any) -> tuple:
        p = Path(self.path)
        st = p.stat()
        return (str(p), st.st_mtime_ns, st.st_size, self.text, *extra)


@dataclass
class SynthRequest:
    text: list[str]  # one or more segments, synthesised as one batch where the engine allows it
    language: str = "auto"  # ISO 639-1 or "auto"
    reference: Reference | None = None
    instruct: str = ""
    params: dict[str, Any] = field(default_factory=dict)
    # the voice's own trained adapter (app/voicehost/training.py): a LoRA directory, for the engines that take one
    adapter: str = ""


class Adapters:
    """A voice's own trained LoRA adapters (app/voicehost/train) on one module of an engine's model, switched per line:
    loaded the first time (peft, in place: the module keeps its own attribute paths), the last few kept, off for a
    voice without one. Off is peft's disable_adapter_layers — never unload(), which would swap the module's layers."""

    KEEP = 4  # (tens of MB each on the GPU)

    def __init__(self) -> None:
        self.peft: Any = None
        self.names: OrderedDict[str, str] = OrderedDict()

    @staticmethod
    def name_of(path: str) -> str:
        """the adapter's directory and when its weights were written (a new training is a new name)"""
        import hashlib

        p = Path(path) / "adapter_model.safetensors"
        stamp = p.stat().st_mtime_ns if p.exists() else 0
        return "v" + hashlib.sha1(f"{path}:{stamp}".encode()).hexdigest()[:12]

    def use(self, module: Any, path: str) -> bool:
        """the adapter at ``path`` on ``module`` ("" none) → whether one is on"""
        if not path:
            if self.peft is not None:
                self.peft.base_model.disable_adapter_layers()
            return False
        from peft import PeftModel

        name = self.name_of(path)
        if self.peft is None:
            self.peft = PeftModel.from_pretrained(module, path, adapter_name=name, is_trainable=False,
                                                  autocast_adapter_dtype=False)
        elif name not in self.peft.peft_config:
            self.peft.load_adapter(path, adapter_name=name, is_trainable=False, autocast_adapter_dtype=False)
        self.names[name] = path
        self.names.move_to_end(name)
        while len(self.names) > self.KEEP:
            old, _ = self.names.popitem(last=False)
            if old != name:
                self.peft.delete_adapter(old)
        self.peft.set_adapter(name)
        self.peft.base_model.enable_adapter_layers()
        module.eval()
        return True


class PromptCache:
    """Keeps the engine-specific encoding of recent references (speaker embedding, codec tokens ...).

    Encoding a reference costs a tokenizer/encoder pass; caching it makes every later line with the same voice skip
    that work. Entries live where the engine keeps them (often on the GPU), so the cache is small.
    """

    def __init__(self, size: int = 16) -> None:
        self.size = size
        self._d: OrderedDict[tuple, Any] = OrderedDict()
        self.on_evict: Callable[[Any], Any] | None = None

    def get(self, key: tuple) -> Any | None:
        if key in self._d:
            self._d.move_to_end(key)
            return self._d[key]
        return None

    def put(self, key: tuple, value: Any) -> None:
        self._d[key] = value
        self._d.move_to_end(key)
        while len(self._d) > self.size:
            _, old = self._d.popitem(last=False)
            if self.on_evict:
                self.on_evict(old)

    def clear(self) -> None:
        while self._d:
            _, old = self._d.popitem(last=False)
            if self.on_evict:
                self.on_evict(old)


class Engine:
    name = "base"
    sample_rate = 24000

    def __init__(self, model_dir: Path, device, options: dict[str, Any]) -> None:
        self.model_dir = Path(model_dir)
        self.dev = device
        self.options = options
        self.prompts = PromptCache()

    def load(self) -> None:
        raise NotImplementedError

    def modules(self) -> list:
        """torch modules whose tensors move on park/resume."""
        return []

    def synthesize(self, req: SynthRequest) -> list[np.ndarray]:
        raise NotImplementedError

    def transcribe(self, path: str, language: str = "auto") -> dict[str, Any]:
        raise NotImplementedError(f"{self.name} does not transcribe")

    def on_park(self) -> None:
        """Before the weights leave the GPU: drop whatever holds GPU memory or raw pointers into it."""
        self.prompts.clear()

    def warmup(self) -> None:
        """One tiny generation so the first real request does not pay for kernel selection / lazy init."""

    def close(self) -> None:
        self.prompts.clear()
