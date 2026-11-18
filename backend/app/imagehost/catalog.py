"""What Image Studio can download and run (docs/local-image.md "Models").

My Mate Geny ships the framework that runs these models — never the weights: each entry names the exact files it needs
(pinned to a revision of the repo they come from, put into ComfyUI's model folders, each with the role it plays in the
graph), what it is for, what it took on a 12 GB card as measured, and the license the user is shown — with links — and
must accept before the download starts. Files several models share (a text encoder, a VAE) are downloaded once and
kept while any model needs them.

Recipes are the ways of making something (graphs.py): each names the use it serves and the models that can do it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.voicehost.catalog import L, License, Param, _t

MIT = "MIT License"
APACHE = "Apache License 2.0"
_CONSENT = L("다른 사람의 얼굴이나 캐릭터를 쓸 때는 권리를 확인하세요. 사칭·사기 등 불법 사용은 금지됩니다.",
             "Check the rights before using someone else's face or character. Impersonation and other unlawful use are "
             "not allowed.")
_APACHE_SUMMARY = (L("Apache-2.0: 상업적 사용, 수정, 재배포가 가능해요.",
                     "Apache-2.0: commercial use, modification and redistribution are allowed."), _CONSENT)
_MIT_SUMMARY = (L("MIT: 상업적 사용, 수정, 재배포가 가능해요.",
                  "MIT: commercial use, modification and redistribution are allowed."),)


@dataclass(frozen=True)
class FileSpec:
    repo: str
    revision: str
    path: str      # in the repo
    folder: str    # ComfyUI's model folder (diffusion_models, text_encoders, vae, loras, background_removal)
    size: int      # bytes (Hugging Face's listing)
    role: str = "model"  # what the graph uses it as: model | model_low | text_encoder | vae | lora | lora_low | remover

    @property
    def name(self) -> str:
        return self.path.rsplit("/", 1)[-1]

    @property
    def key(self) -> str:
        return f"{self.folder}/{self.name}"

    @property
    def url(self) -> str:
        return f"https://huggingface.co/{self.repo}/blob/{self.revision}/{self.path}"


@dataclass(frozen=True)
class ImageModel:
    id: str
    name: str
    kind: str                 # image | edit | video | cutout
    description: L
    files: tuple[FileSpec, ...]
    vram_gb: float            # the GPU's memory at its highest during a job, measured on an RTX 5070 (12 GB)
    ram_gb: float             # ComfyUI's resident memory at its highest with it, measured
    license: License
    uses: tuple[str, ...]     # draft | edit | loop | cutout
    homepage: str
    seconds: L = L("", "")    # what a typical job took, measured (shown on its card)
    defaults: dict[str, Any] = field(default_factory=dict)  # the graph settings it is made for
    notes: tuple[L, ...] = ()

    def file(self, role: str) -> str:
        return next((f.name for f in self.files if f.role == role), "")

    @property
    def download_bytes(self) -> int:
        return sum(f.size for f in self.files)

    def to_dict(self, lang: str = "en") -> dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "kind": self.kind, "description": self.description.get(lang),
            "files": [{"name": f.name, "folder": f.folder, "size": f.size, "url": f.url, "repo": f.repo,
                       "revision": f.revision, "role": f.role} for f in self.files],
            "download_gb": round(self.download_bytes / 1e9, 2), "vram_gb": self.vram_gb, "ram_gb": self.ram_gb,
            "uses": list(self.uses), "homepage": self.homepage, "seconds": self.seconds.get(lang),
            "defaults": dict(self.defaults), "notes": _t(self.notes, lang),
            "license": {"name": self.license.name, "url": self.license.url, "summary": _t(self.license.summary, lang),
                        "attribution": self.license.attribution, "commercial": self.license.commercial.get(lang),
                        "noncommercial": self.license.noncommercial},
        }


# ── the files (exact sizes from each repo's listing at the pinned revision) ──
_ANIMA, _ANIMA_REV = "circlestone-labs/Anima", "6e0b2da211"
_ANIMA_TE = FileSpec(_ANIMA, _ANIMA_REV, "split_files/text_encoders/qwen_3_06b_base.safetensors", "text_encoders",
                     1_192_135_096, "text_encoder")
_QWEN_VAE = FileSpec(_ANIMA, _ANIMA_REV, "split_files/vae/qwen_image_vae.safetensors", "vae", 253_806_246, "vae")
_WAN, _WAN_REV = "Comfy-Org/Wan_2.2_ComfyUI_Repackaged", "ee6f4a4073"
_UMT5 = FileSpec(_WAN, _WAN_REV, "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", "text_encoders",
                 6_735_906_897, "text_encoder")
_BIREF, _BIREF_REV = "Comfy-Org/BiRefNet", "884af709e9"
_KLEIN, _KLEIN_REV = "Comfy-Org/Flux-2-Klein-4B", "5b3abca5c0"

_ANIMA_LICENSE = License(
    name="CircleStone Labs Non-Commercial License (+ NVIDIA Open Model License)",
    url="https://huggingface.co/circlestone-labs/Anima",
    summary=(
        L("모델(가중치)은 비상업적 용도로만 쓸 수 있어요. 모델을 API로 올려 돈을 받는 것도 상업적 사용이에요.",
          "The model (its weights) is for non-commercial use only; hosting it behind a paid API is commercial use."),
        L("만든 그림(결과물)은 상업적으로 써도 돼요 — 비상업 조건은 모델에만 적용돼요.",
          "The pictures it makes may be used commercially: the non-commercial terms apply to the model only."),
        L("NVIDIA Cosmos 기반 파생 모델이라 NVIDIA Open Model License도 함께 적용돼요.",
          "It is a derivative of NVIDIA Cosmos: the NVIDIA Open Model License applies too."),
        _CONSENT,
    ),
    attribution="Built on NVIDIA Cosmos.",
    commercial=L("모델은 비상업 전용 · 만든 그림은 상업적 사용 가능", "Model non-commercial only · its pictures may be used commercially"),
    noncommercial=True,
)
_FIRST_LOAD = L("첫 작업은 모델을 디스크에서 읽어 오는 시간이 더해져요 (HDD에서 약 1~2분, NVMe면 훨씬 짧아요).",
                "The first job adds reading the model from disk (about 1–2 min from a hard disk, far less from NVMe).")

CATALOG: tuple[ImageModel, ...] = (
    ImageModel(
        id="anima-turbo",
        name="Anima Turbo 1.1",
        kind="image",
        description=L("애니·일러스트 그림체의 캐릭터 시안을 빠르게 (10스텝). 그림체가 안정적이고, 대신 다양성은 조금 덜해요.",
                      "Anime / illustration character drafts, fast (10 steps): a steadier style, a little less variety."),
        files=(FileSpec(_ANIMA, _ANIMA_REV, "split_files/diffusion_models/anima-turbo-v1.1.safetensors",
                        "diffusion_models", 4_182_230_656), _ANIMA_TE, _QWEN_VAE),
        vram_gb=5.9, ram_gb=2.6,
        license=_ANIMA_LICENSE,
        uses=("draft",),
        homepage="https://huggingface.co/circlestone-labs/Anima",
        seconds=L("768×1024 한 장 2.8초", "2.8 s for a 768×1024 picture"),
        defaults={"steps": 10, "cfg": 1.0, "sampler": "er_sde"},
        notes=(_FIRST_LOAD,),
    ),
    ImageModel(
        id="anima-base",
        name="Anima 1.0",
        kind="image",
        description=L("애니·일러스트 그림체의 기본 모델 (30스텝). 표현의 폭이 넓고 그림체 지시를 잘 따라요.",
                      "The anime / illustration base model (30 steps): more range, follows style prompts closely."),
        files=(FileSpec(_ANIMA, _ANIMA_REV, "split_files/diffusion_models/anima-base-v1.0.safetensors",
                        "diffusion_models", 4_182_218_328), _ANIMA_TE, _QWEN_VAE),
        vram_gb=6.0, ram_gb=2.6,
        license=_ANIMA_LICENSE,
        uses=("draft",),
        homepage="https://huggingface.co/circlestone-labs/Anima",
        seconds=L("768×1024 한 장 14.8초", "14.8 s for a 768×1024 picture"),
        defaults={"steps": 30, "cfg": 5.0, "sampler": "er_sde"},
        notes=(_FIRST_LOAD,),
    ),
    ImageModel(
        id="flux2-klein-4b",
        name="FLUX.2 [klein] 4B",
        kind="edit",
        description=L("그림을 말로 고쳐요: 표정, 옷, 소품, 자세를 바꾸고 나머지는 그대로 둬요 (4스텝). 아바타의 표정 그림을 만들어요.",
                      "Changes a picture by words — an expression, clothes, a prop, a pose — and leaves the rest alone "
                      "(4 steps): the avatar's expression pictures."),
        files=(
            FileSpec("black-forest-labs/FLUX.2-klein-4b-fp8", "5b4408e593", "flux-2-klein-4b-fp8.safetensors",
                     "diffusion_models", 4_070_624_520),
            FileSpec(_KLEIN, _KLEIN_REV, "split_files/text_encoders/qwen_3_4b.safetensors", "text_encoders",
                     8_044_982_048, "text_encoder"),
            FileSpec(_KLEIN, _KLEIN_REV, "split_files/vae/flux2-vae.safetensors", "vae", 336_211_292, "vae"),
        ),
        vram_gb=11.0, ram_gb=2.7,
        license=License(name=APACHE, url="https://huggingface.co/black-forest-labs/FLUX.2-klein-4B",
                        summary=_APACHE_SUMMARY),
        uses=("edit",),
        homepage="https://huggingface.co/black-forest-labs/FLUX.2-klein-4B",
        seconds=L("1024×1024 편집 한 장 약 1분", "about 1 min for a 1024×1024 edit"),
        defaults={"steps": 4, "cfg": 1.0, "megapixels": 1.0},
        notes=(_FIRST_LOAD,),
    ),
    ImageModel(
        id="wan22-fun-5b",
        name="Wan 2.2 Fun InP 5B",
        kind="video",
        description=L("기준 그림에서 시작해 같은 그림으로 끝나는 움직임 영상 (첫·마지막 프레임 지정, 20스텝). 가벼운 쪽이에요.",
                      "Motion clips that start on the base picture and end on it again (first and last frame set, 20 "
                      "steps): the lighter one."),
        files=(
            FileSpec(_WAN, _WAN_REV, "split_files/diffusion_models/wan2.2_fun_inpaint_5B_bf16.safetensors",
                     "diffusion_models", 10_000_937_656),
            _UMT5,
            FileSpec(_WAN, _WAN_REV, "split_files/vae/wan2.2_vae.safetensors", "vae", 1_409_400_960, "vae"),
        ),
        vram_gb=11.3, ram_gb=3.1,
        license=License(name=APACHE, url="https://huggingface.co/alibaba-pai/Wan2.2-Fun-5B-InP", summary=_APACHE_SUMMARY),
        uses=("loop",),
        homepage="https://huggingface.co/alibaba-pai/Wan2.2-Fun-5B-InP",
        seconds=L("640×640 81프레임 (24fps 3.4초) 약 4분", "about 4 min for 81 frames at 640×640 (3.4 s at 24 fps)"),
        defaults={"steps": 20, "cfg": 6.0, "shift": 8.0, "sampler": "uni_pc", "fps": 24, "size": 640},
        notes=(_FIRST_LOAD,
               L("모델 출력은 몇 단계 어둡게 나와요: 색은 기준 그림에 맞춰 되돌리고, 첫·마지막 프레임은 기준 그림 그대로 넣어요.",
                 "Its frames come out a few levels darker: the colours are brought back to the base picture's, and "
                 "the first and last frames are the base picture itself.")),
    ),
    ImageModel(
        id="lucida",
        name="Lucida (BiRefNet)",
        kind="cutout",
        description=L("그림에서 인물만 남기는 배경 제거. 일러스트의 가는 선과 머리카락에 강해요. 영상의 배경 제거에도 써요.",
                      "Background removal that keeps the character: good at the thin lines and hair of illustrations. "
                      "Also removes a clip's background."),
        files=(FileSpec(_BIREF, _BIREF_REV, "background_removal/lucida.safetensors", "background_removal",
                        884_878_856, "remover"),),
        vram_gb=2.1, ram_gb=2.1,
        license=License(name=MIT, url="https://huggingface.co/Comfy-Org/BiRefNet", summary=_MIT_SUMMARY),
        uses=("cutout",),
        homepage="https://huggingface.co/Comfy-Org/BiRefNet",
        seconds=L("1080×1080 한 장 몇 초", "a few seconds for a 1080×1080 picture"),
    ),
    ImageModel(
        id="birefnet",
        name="BiRefNet",
        kind="cutout",
        description=L("일반적인 배경 제거 (실사에 가까운 그림에 알맞아요). 영상의 배경 제거에도 써요.",
                      "General background removal (for semi-real pictures). Also removes a clip's background."),
        files=(FileSpec(_BIREF, _BIREF_REV, "background_removal/birefnet.safetensors", "background_removal",
                        444_473_596, "remover"),),
        vram_gb=2.1, ram_gb=2.1,
        license=License(name=MIT, url="https://huggingface.co/Comfy-Org/BiRefNet", summary=_MIT_SUMMARY),
        uses=("cutout",),
        homepage="https://huggingface.co/Comfy-Org/BiRefNet",
        seconds=L("1080×1080 한 장 몇 초", "a few seconds for a 1080×1080 picture"),
    ),
)

BY_ID: dict[str, ImageModel] = {m.id: m for m in CATALOG}
USES = ("draft", "edit", "loop", "cutout")


def get(model_id: str) -> ImageModel:
    return BY_ID[model_id]


@dataclass(frozen=True)
class Recipe:
    """a way of making something: its use, the models that can do it (in order of preference), its knobs"""
    id: str
    use: str
    label: L
    description: L
    models: tuple[str, ...]
    params: tuple[Param, ...] = ()

    def to_dict(self, lang: str = "en") -> dict[str, Any]:
        return {"id": self.id, "use": self.use, "label": self.label.get(lang), "description": self.description.get(lang),
                "models": list(self.models), "params": [p.to_dict(lang) for p in self.params]}


RECIPES: tuple[Recipe, ...] = (
    Recipe("draft", "draft", L("캐릭터 시안", "Character drafts"),
           L("말로 설명한 캐릭터를 그려요. 아바타 만들기의 후보 시안이 이걸로 나와요.",
             "Draws a character from a description: the avatar maker's candidates."),
           ("anima-turbo", "anima-base"), (
               Param("steps", L("스텝", "Steps"), "int", 0, 0, 60, 1,
                     help=L("0: 모델에 맞게 (Turbo 10, 기본 30)", "0: the model's own (Turbo 10, base 30)")),
               Param("cfg", L("CFG", "CFG"), "float", 0.0, 0.0, 10.0, 0.5,
                     help=L("0: 모델에 맞게 (Turbo 1, 기본 5)", "0: the model's own (Turbo 1, base 5)")),
           )),
    Recipe("edit", "edit", L("그림 바꾸기", "Change a picture"),
           L("그림을 말로 고쳐요: 표정, 옷, 소품. 아바타의 표정 그림과 시안 수정이 이걸로 나와요.",
             "Changes a picture by words — an expression, clothes, a prop: the avatar's expressions and its "
             "candidates' changes."),
           ("flux2-klein-4b",), (
               Param("megapixels", L("해상도 (메가픽셀)", "Resolution (megapixels)"), "float", 1.0, 0.5, 2.0, 0.25),
           )),
    Recipe("loop", "loop", L("반복 영상", "Loops"),
           L("기준 그림에서 시작해 같은 그림으로 끝나는 움직임 영상. 아바타의 대기·말하기·반응 영상이 이걸로 나와요.",
             "A motion clip that starts on the base picture and ends on it: the avatar's idle, talk and react clips."),
           ("wan22-fun-5b",), (
               Param("steps", L("스텝", "Steps"), "int", 0, 0, 40, 1, help=L("0: 모델에 맞게", "0: the model's own")),
               Param("size", L("해상도 (N×N 화소만큼)", "Resolution (as many pixels as N×N)"), "int", 0, 0, 1024, 16,
                     help=L("0: 모델에 맞게 (640×640 만큼, 그림의 비율대로). 클수록 선명하지만 화소 수만큼 오래 걸려요.",
                            "0: the model's own (as many pixels as 640×640, in the picture's shape). Larger is "
                            "sharper and takes longer, by the pixels.")),
           )),
    Recipe("cutout", "cutout", L("배경 제거", "Background removal"),
           L("그림과 영상에서 인물만 남겨요. 아바타의 기준 그림과 영상의 투명 배경이 이걸로 나와요.",
             "Keeps only the character, in pictures and clips: the avatar's base picture and its clips' "
             "transparency."),
           ("lucida", "birefnet")),
)
RECIPE_BY_ID = {r.id: r for r in RECIPES}


def clean_params(recipe: Recipe, raw: dict[str, Any] | None) -> dict[str, Any]:
    """a recipe's settings: its defaults with the given values, clamped to their ranges; unknown keys dropped"""
    raw = raw or {}
    out: dict[str, Any] = {}
    for p in recipe.params:
        v = raw.get(p.name, p.default)
        try:
            v = int(round(float(v))) if p.type == "int" else float(v) if p.type == "float" else v
        except (TypeError, ValueError):
            v = p.default
        if p.type in ("int", "float"):
            if p.min is not None:
                v = max(p.min, v)
            if p.max is not None:
                v = min(p.max, v)
        out[p.name] = v
    return out
