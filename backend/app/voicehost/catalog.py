"""What can be downloaded and served (docs/local-voice.md "Models").

My Mate Geny ships the framework that serves these models — never the weights. Each entry names the Hugging Face
files it needs (only those: the repos also carry training- or TensorRT-only files), the engine runtime that serves it,
what it can do, the knobs a user may turn, and the license the user is shown — with links to the model's page and the
license itself — and must accept before the download starts. VRAM / host RAM figures are measured on an RTX 5070
(12 GB) and feed the GPU budget (app/voicehost/host.py): a model is only loaded next to others if its measured peak fits.

Every text a person reads comes in Korean and English (``L``); ``to_dict(lang)`` picks one.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class L:
    """a text in both of the UI's languages"""
    ko: str
    en: str

    def get(self, lang: str) -> str:
        return self.ko if lang == "ko" else self.en


def _t(v: Any, lang: str) -> Any:
    if isinstance(v, L):
        return v.get(lang)
    if isinstance(v, tuple):
        return [_t(x, lang) for x in v]
    return v


@dataclass(frozen=True)
class Param:
    name: str
    label: L
    type: str  # "float" | "int" | "bool" | "choice"
    default: Any
    min: float | None = None
    max: float | None = None
    step: float | None = None
    choices: tuple[str, ...] = ()
    help: L | None = None
    advanced: bool = True

    def to_dict(self, lang: str) -> dict[str, Any]:
        d: dict[str, Any] = {"name": self.name, "label": self.label.get(lang), "type": self.type,
                             "default": self.default, "advanced": self.advanced}
        for k in ("min", "max", "step"):
            if getattr(self, k) is not None:
                d[k] = getattr(self, k)
        if self.choices:
            d["choices"] = list(self.choices)
        if self.help is not None:
            d["help"] = self.help.get(lang)
        return d


@dataclass(frozen=True)
class License:
    name: str
    url: str
    # what the user should know, in short sentences
    summary: tuple[L, ...]
    # text that must be shown wherever the model's output is offered, if the license asks for one
    attribution: str = ""
    commercial: L = L("허용", "Allowed")


@dataclass(frozen=True)
class RepoFiles:
    repo_id: str
    revision: str = "main"
    include: tuple[str, ...] = ()
    exclude: tuple[str, ...] = ()
    subdir: str = ""

    @property
    def url(self) -> str:
        return f"https://huggingface.co/{self.repo_id}"


@dataclass(frozen=True)
class ModelSpec:
    id: str
    name: str
    kind: str  # "tts" | "stt"
    engine: str  # runtime that serves it: cosyvoice3 | qwen3_tts | omnivoice | whisper
    description: L
    repos: tuple[RepoFiles, ...]
    download_gb: float
    # peak VRAM while generating (weights + activations + CUDA context), GiB, measured
    vram_gb: float
    # host RAM of its worker process while loaded (after the loader's CPU copies are trimmed), GiB, measured
    host_gb: float
    # host RAM the worker peaks at while loading (VmHWM), GiB, measured; admission makes room for this much
    load_peak_gb: float
    license: License
    languages: tuple[str, ...]
    features: tuple[str, ...]  # clone | design | instruct | cross_lingual | auto_voice | transcribe | tags
    params: tuple[Param, ...] = ()
    homepage: str = ""
    # engine-specific load options passed to the worker
    load_options: dict[str, Any] = field(default_factory=dict)
    sample_rate: int = 24000
    notes: tuple[L, ...] = ()

    def to_dict(self, lang: str = "en") -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "engine": self.engine,
            "description": self.description.get(lang),
            "download_gb": self.download_gb,
            "vram_gb": self.vram_gb,
            "host_gb": self.host_gb,
            "languages": list(self.languages),
            "features": list(self.features),
            "params": [p.to_dict(lang) for p in self.params],
            "homepage": self.homepage,
            "sample_rate": self.sample_rate,
            "notes": _t(self.notes, lang),
            "license": {
                "name": self.license.name,
                "url": self.license.url,
                "summary": _t(self.license.summary, lang),
                "attribution": self.license.attribution,
                "commercial": self.license.commercial.get(lang),
            },
            "repos": [{"id": r.repo_id, "url": r.url, "revision": r.revision} for r in self.repos],
        }


APACHE = "Apache License 2.0"

_CONSENT = L("타인의 목소리를 복제할 때는 본인의 동의를 받으세요. 사칭·사기 등 불법 사용은 금지됩니다.",
             "Only clone someone's voice with their consent. Impersonation, fraud and other unlawful use are forbidden.")
_APACHE_SUMMARY = (
    L("코드와 가중치 모두 Apache-2.0 입니다. 상업적 사용, 수정, 재배포가 가능합니다.",
      "Code and weights are Apache-2.0: commercial use, modification and redistribution are allowed."),
    L("재배포할 때는 라이선스 사본과 저작권 고지를 함께 둬야 합니다.",
      "A redistribution must carry a copy of the license and the copyright notices."),
    _CONSENT,
)

_QWEN_PARAMS = (
    Param("temperature", L("temperature", "temperature"), "float", 0.9, 0.1, 1.5, 0.05,
          help=L("높을수록 억양이 다양해지고, 낮을수록 안정적입니다.", "Higher: livelier intonation; lower: steadier.")),
    Param("top_p", L("top_p", "top_p"), "float", 1.0, 0.1, 1.0, 0.05),
    Param("top_k", L("top_k", "top_k"), "int", 50, 1, 200, 1),
    Param("repetition_penalty", L("repetition_penalty", "repetition_penalty"), "float", 1.05, 1.0, 1.5, 0.01),
    Param("x_vector_only", L("전사 없이 음색만", "Timbre only (no transcript)"), "bool", False,
          help=L("레퍼런스 전사(텍스트)를 쓰지 않고 화자 임베딩만으로 복제합니다. 품질은 조금 떨어집니다.",
                 "Clone from the speaker embedding alone, without the reference's transcript. Slightly lower quality.")),
)

_QWEN_LICENSE = License(name=APACHE, url="https://github.com/QwenLM/Qwen3-TTS/blob/main/LICENSE",
                        summary=_APACHE_SUMMARY)

_QWEN_LANGS = ("auto", "ko", "en", "zh", "ja", "de", "fr", "ru", "pt", "es", "it")

CATALOG: tuple[ModelSpec, ...] = (
    ModelSpec(
        id="qwen3-tts-0.6b-base",
        name="Qwen3-TTS 0.6B (Base)",
        kind="tts",
        engine="qwen3_tts",
        description=L("Qwen 의 12Hz 코덱 TTS. 3초 정도의 레퍼런스로 목소리를 복제합니다. 가볍고 빠릅니다.",
                      "Qwen's 12 Hz codec TTS: clones a voice from about 3 s of reference. Light and fast."),
        repos=(RepoFiles("Qwen/Qwen3-TTS-12Hz-0.6B-Base", exclude=("README.md", ".gitattributes")),),
        download_gb=2.5,
        vram_gb=4.0,
        host_gb=2.5,
        load_peak_gb=2.7,
        license=_QWEN_LICENSE,
        languages=_QWEN_LANGS,
        features=("clone",),
        params=_QWEN_PARAMS,
        homepage="https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    ),
    ModelSpec(
        id="qwen3-tts-1.7b-base",
        name="Qwen3-TTS 1.7B (Base)",
        kind="tts",
        engine="qwen3_tts",
        description=L("Qwen3-TTS 의 큰 모델. 0.6B 보다 음색 유사도와 운율이 좋고, 대신 VRAM 을 더 씁니다.",
                      "The larger Qwen3-TTS: closer timbre and better prosody than 0.6B, for more VRAM."),
        repos=(RepoFiles("Qwen/Qwen3-TTS-12Hz-1.7B-Base", exclude=("README.md", ".gitattributes")),),
        download_gb=4.5,
        vram_gb=6.0,
        host_gb=2.5,
        load_peak_gb=4.6,
        license=_QWEN_LICENSE,
        languages=_QWEN_LANGS,
        features=("clone",),
        params=_QWEN_PARAMS,
        homepage="https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    ),
    ModelSpec(
        id="cosyvoice3-0.5b",
        name="Fun-CosyVoice3 0.5B (2512)",
        kind="tts",
        engine="cosyvoice3",
        description=L("FunAudioLLM 의 CosyVoice3. 제로샷 복제, 다른 언어로 말하기, 지시문(감정·속도·사투리) 제어를 지원합니다.",
                      "FunAudioLLM's CosyVoice3: zero-shot cloning, speaking other languages, and instructions "
                      "(emotion, pace, dialect)."),
        repos=(
            RepoFiles(
                "FunAudioLLM/Fun-CosyVoice3-0.5B-2512",
                # The RL LLM, the batch tokenizer and the TensorRT estimator are not used by this runtime.
                exclude=("llm.rl.pt", "speech_tokenizer_v3.batch.onnx", "flow.decoder.estimator.fp32.onnx",
                         "asset/*", "README.md", ".gitattributes"),
            ),
        ),
        download_gb=5.4,
        vram_gb=5.6,
        host_gb=3.9,
        load_peak_gb=7.5,
        license=License(name=APACHE, url="https://github.com/FunAudioLLM/CosyVoice/blob/main/LICENSE",
                        summary=_APACHE_SUMMARY),
        languages=("auto", "ko", "en", "zh", "ja", "de", "es", "fr", "it", "ru"),
        features=("clone", "cross_lingual", "instruct", "tags"),
        params=(
            Param("speed", L("속도", "Speed"), "float", 1.0, 0.5, 2.0, 0.05, advanced=False),
            Param("mode", L("복제 방식", "Cloning mode"), "choice", "zero_shot", choices=("zero_shot", "cross_lingual"),
                  help=L("zero_shot: 레퍼런스 전사를 함께 씁니다(권장). cross_lingual: 전사 없이 음색만 가져와 다른 언어로 "
                         "말할 때 씁니다.",
                         "zero_shot uses the reference's transcript too (recommended); cross_lingual takes the timbre "
                         "alone, for speaking another language.")),
        ),
        homepage="https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512",
        notes=(L("지시문 예: '천천히, 부드럽게 말해 주세요.' (지시문이 있으면 instruct 모드로 생성합니다)",
                 "Instruction example: 'Please speak slowly and softly.' (an instruction switches to instruct mode)"),
               L("문장 안에 [breath], [laughter], <strong>강조</strong> 같은 태그를 쓸 수 있습니다.",
                 "Tags like [breath], [laughter] and <strong>emphasis</strong> work inside the text."),
               L("레퍼런스와 다른 언어로 말하게 하면 발음이 흐려지는 경우가 있습니다 (한국어 레퍼런스 → 영어 문장에서 측정).",
                 "Speaking another language than the reference can blur the pronunciation (measured: Korean "
                 "reference → English text).")),
    ),
    ModelSpec(
        id="omnivoice",
        name="OmniVoice",
        kind="tts",
        engine="omnivoice",
        description=L("k2-fsa 의 비자기회귀(diffusion LM) TTS. 600개 이상 언어, 목소리 복제와 목소리 설계(지시문으로 새 목소리 "
                      "만들기)를 지원하고 빠릅니다.",
                      "k2-fsa's non-autoregressive (diffusion LM) TTS: 600+ languages, voice cloning and voice design "
                      "(a new voice from an instruction), and fast."),
        repos=(RepoFiles("k2-fsa/OmniVoice", exclude=("README.md", ".gitattributes", "audio_tokenizer/.gitattributes")),),
        download_gb=3.3,
        vram_gb=2.9,
        host_gb=2.1,
        load_peak_gb=3.7,
        license=License(
            name="Apache-2.0 (code) + Boson Higgs Audio 2 Community License (audio tokenizer)",
            url="https://huggingface.co/k2-fsa/OmniVoice/blob/main/audio_tokenizer/LICENSE",
            summary=(
                L("코드는 Apache-2.0 입니다. 모델 본체 가중치에는 Hugging Face 상 별도 라이선스 표기가 없습니다.",
                  "The code is Apache-2.0. The main model weights carry no separate license on Hugging Face."),
                L("함께 받는 오디오 토크나이저는 Boson Higgs Audio 2 Community License (Meta Llama 3 라이선스 기반) 를 따릅니다.",
                  "The audio tokenizer downloaded with it is under the Boson Higgs Audio 2 Community License (based on "
                  "the Meta Llama 3 license)."),
                L("이 모델로 만든 결과물을 다른 대형 언어 모델 개선(학습)에 쓰면 안 됩니다.",
                  "Its output must not be used to improve (train) other large language models."),
                L("서비스의 연간 활성 사용자가 10만 명을 넘으면 Boson AI 에 별도 라이선스를 받아야 합니다.",
                  "A service with more than 100,000 annual active users needs a separate license from Boson AI."),
                L("배포·서비스 시 'Built with Higgs Materials' 류의 출처 표기와 NOTICE 파일이 필요하고, Llama 3 이용 정책"
                  "(Acceptable Use Policy) 을 지켜야 합니다.",
                  "Distribution or a service needs attribution (\"Built with Higgs Materials\") and the NOTICE file, "
                  "and must follow the Llama 3 Acceptable Use Policy."),
                _CONSENT,
            ),
            attribution="Meta Llama 3 is licensed under the Meta Llama 3 Community License, Copyright © Meta Platforms, "
                        "Inc. All Rights Reserved. Boson Higgs Audio 2 is licensed under the Boson Community License, "
                        "Copyright © Boson AI USA, Inc. All Rights Reserved.",
            commercial=L("조건부 허용 (연간 활성 사용자 10만 명 이하, 이용 정책 준수)",
                         "Allowed with conditions (≤ 100,000 annual active users, the use policy followed)"),
        ),
        languages=("auto", "ko", "en", "zh", "ja", "de", "es", "fr", "it", "ru", "pt", "vi", "th", "id"),
        features=("clone", "design", "auto_voice", "tags"),
        params=(
            Param("speed", L("속도", "Speed"), "float", 1.0, 0.5, 2.0, 0.05, advanced=False),
            Param("num_step", L("디퓨전 스텝", "Diffusion steps"), "int", 32, 4, 64, 1,
                  help=L("많을수록 품질이 좋고 느립니다. 16 이면 약 두 배 빠릅니다.",
                         "More: better and slower. 16 is about twice as fast.")),
            Param("guidance_scale", L("guidance", "guidance"), "float", 2.0, 0.0, 5.0, 0.1),
            Param("t_shift", L("t_shift", "t_shift"), "float", 0.1, 0.0, 1.0, 0.05),
            Param("denoise", L("레퍼런스 잡음 제거", "Denoise the reference"), "bool", True),
            Param("duration", L("길이 고정(초)", "Fixed length (s)"), "float", 0.0, 0.0, 120.0, 0.5,
                  help=L("0 이면 자동. 값을 주면 그 길이에 맞춰 말합니다.", "0: automatic. Otherwise it speaks to that length.")),
        ),
        homepage="https://huggingface.co/k2-fsa/OmniVoice",
        notes=(L("목소리 설계 예: 'female, low pitch, british accent' (영어·중국어 지시문으로 학습됨)",
                 "Voice design example: 'female, low pitch, british accent' (trained on English and Chinese "
                 "instructions)"),),
    ),
    ModelSpec(
        id="whisper-large-v3-turbo",
        name="Whisper large-v3-turbo (STT)",
        kind="stt",
        engine="whisper",
        description=L("OpenAI Whisper 의 빠른 large 모델. 메이트가 듣는 말(채팅 음성 입력·통화)과 레퍼런스 전사에 씁니다.",
                      "OpenAI Whisper's fast large model: what your mate hears (voice input, calls) and reference "
                      "transcripts."),
        repos=(RepoFiles("openai/whisper-large-v3-turbo", include=("*.json", "*.txt", "model.safetensors")),),
        download_gb=1.6,
        vram_gb=2.0,
        host_gb=1.8,
        load_peak_gb=2.4,
        license=License(
            name="MIT",
            url="https://huggingface.co/openai/whisper-large-v3-turbo",
            summary=(L("MIT 라이선스입니다. 상업적 사용, 수정, 재배포가 가능합니다.",
                       "MIT license: commercial use, modification and redistribution are allowed."),
                     L("재배포할 때는 저작권 고지와 라이선스 문구를 함께 둬야 합니다.",
                       "A redistribution must carry the copyright notice and the license text.")),
        ),
        languages=("auto", "ko", "en", "zh", "ja", "de", "es", "fr", "it", "ru", "pt", "vi", "th", "id"),
        features=("transcribe",),
        homepage="https://huggingface.co/openai/whisper-large-v3-turbo",
        sample_rate=16000,
    ),
)

BY_ID: dict[str, ModelSpec] = {m.id: m for m in CATALOG}

LANGUAGE_NAMES = {
    "auto": L("자동", "Automatic"), "ko": "한국어", "en": "English", "zh": "中文", "ja": "日本語", "de": "Deutsch",
    "es": "Español", "fr": "Français", "it": "Italiano", "ru": "Русский", "pt": "Português",
    "vi": "Tiếng Việt", "th": "ไทย", "id": "Bahasa Indonesia",
}


def get(model_id: str) -> ModelSpec:
    try:
        return BY_ID[model_id]
    except KeyError:
        raise KeyError(f"unknown model: {model_id}") from None


def clean_params(spec: ModelSpec, raw: dict[str, Any] | None) -> dict[str, Any]:
    """Defaults merged with the user's values, clamped to the declared ranges; unknown keys dropped."""
    raw = raw or {}
    out: dict[str, Any] = {}
    for p in spec.params:
        v = raw.get(p.name, p.default)
        if v is None or v == "":
            v = p.default
        try:
            if p.type == "float":
                v = float(v)
            elif p.type == "int":
                v = int(round(float(v)))
            elif p.type == "bool":
                v = v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes", "on")
            elif p.type == "choice":
                v = str(v) if str(v) in p.choices else p.default
        except (TypeError, ValueError):
            v = p.default
        if p.type in ("float", "int"):
            if p.min is not None:
                v = max(p.min, v)
            if p.max is not None:
                v = min(p.max, v)
            v = int(v) if p.type == "int" else v
        out[p.name] = v
    return out
