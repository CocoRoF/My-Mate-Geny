"""Image Studio's ways of making a picture or a clip, as ComfyUI graphs (API format: node id → {class_type, inputs};
an input that is another node's output is ``[id, index]``). Pure — no ComfyUI here: each builder takes the files and the
settings and returns the graph and the name of the node whose output is the result (docs/local-image.md "Recipes").

The nodes are ComfyUI's own (core nodes of the pinned version; no custom node packs), so a graph runs on any ComfyUI
the app installed. Sizes snap to what each model takes (multiples of 16), clip lengths to 4k+1 frames.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any

Graph = dict[str, dict[str, Any]]


def ref(node: int | str, index: int = 0) -> list[Any]:
    return [str(node), index]


def node(class_type: str, **inputs: Any) -> dict[str, Any]:
    return {"class_type": class_type, "inputs": inputs}


def snap(n: int, step: int = 16, lo: int = 256, hi: int = 2048) -> int:
    """a side a model takes: within [lo, hi], a multiple of `step`"""
    return max(lo, min(hi, int(round(n / step)) * step))


def frames(seconds: float, fps: int) -> int:
    """a clip's length in frames, as Wan takes it (4k+1)"""
    n = max(5, int(round(seconds * fps)))
    return (n - 1) // 4 * 4 + 1


def seed_of(seed: int | None) -> int:
    return int(seed) if seed is not None and seed >= 0 else random.randint(0, 2**48)


@dataclass
class Built:
    graph: Graph
    #: the node whose output is the result (SaveImage / SaveVideo)
    output: str
    #: what it was made with (kept with the result)
    recipe: dict[str, Any] = field(default_factory=dict)


# ── a picture from words: Anima (anime / illustration) ──

# (the model card's: lowercase tags with spaces, the human and aesthetic quality tags)
ANIMA_PREFIX = "masterpiece, best quality, score_7, safe, "
ANIMA_NEGATIVE = ("worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, "
                  "chromatic aberration, extra fingers, bad hands, watermark, signature, text")


def anima_txt2img(prompt: str, *, model: str, text_encoder: str, vae: str, width: int = 832, height: int = 1216,
                  steps: int = 30, cfg: float = 5.0, sampler: str = "er_sde", negative: str = "", seed: int | None = None,
                  prefix: str = "studio/anima", batch: int = 1) -> Built:
    """Anima's text to image (its own text encoder through CLIPLoader type stable_diffusion, the Qwen Image VAE)."""
    w, h, s = snap(width), snap(height), seed_of(seed)
    g: Graph = {
        "1": node("UNETLoader", unet_name=model, weight_dtype="default"),
        "2": node("CLIPLoader", clip_name=text_encoder, type="stable_diffusion", device="default"),
        "3": node("VAELoader", vae_name=vae),
        "4": node("CLIPTextEncode", text=ANIMA_PREFIX + prompt.strip(), clip=ref(2)),
        "5": node("CLIPTextEncode", text=negative.strip() or ANIMA_NEGATIVE, clip=ref(2)),
        "6": node("EmptyLatentImage", width=w, height=h, batch_size=max(1, min(4, batch))),
        "7": node("KSampler", seed=s, steps=max(4, min(80, steps)), cfg=cfg, sampler_name=sampler, scheduler="simple",
                  denoise=1.0, model=ref(1), positive=ref(4), negative=ref(5), latent_image=ref(6)),
        "8": node("VAEDecode", samples=ref(7), vae=ref(3)),
        "9": node("SaveImage", images=ref(8), filename_prefix=prefix),
    }
    return Built(g, "9", {"model": model, "width": w, "height": h, "steps": steps, "cfg": cfg, "sampler": sampler, "seed": s})


# ── a loop: the same picture first and last (Wan 2.2 Fun InP) ──

WAN_NEGATIVE = ("色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，"
                "残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，杂乱的背景，三条腿，背景人很多，"
                "camera movement, zoom, pan, background change")


def wan_loop(image: str, prompt: str, *, model: str, text_encoder: str, vae: str, width: int = 640, height: int = 640,
             seconds: float = 5.0, fps: int = 24, steps: int = 20, cfg: float = 6.0, shift: float = 8.0,
             sampler: str = "uni_pc", negative: str = "", seed: int | None = None, prefix: str = "studio/loop",
             end_image: str | None = None) -> Built:
    """A clip that starts on `image` and ends on it again (or on `end_image`): Wan's first-and-last-frame conditioning
    (WanFunInpaintToVideo, the official template's settings). Its frames are saved as lossless pictures: the app puts the
    base picture itself on the first and last frame (the loop's seam is exact, not a model's near copy) and encodes the
    clip (docs/local-image.md "Loops")."""
    w, h, s = snap(width, lo=256, hi=1280), snap(height, lo=256, hi=1280), seed_of(seed)
    n = frames(seconds, fps)
    g: Graph = {
        "1": node("UNETLoader", unet_name=model, weight_dtype="default"),
        "2": node("CLIPLoader", clip_name=text_encoder, type="wan", device="default"),
        "3": node("VAELoader", vae_name=vae),
        "4": node("CLIPTextEncode", text=prompt.strip(), clip=ref(2)),
        "5": node("CLIPTextEncode", text=negative.strip() or WAN_NEGATIVE, clip=ref(2)),
        "6": node("LoadImage", image=image),
        "7": node("LoadImage", image=end_image or image),
        "8": node("WanFunInpaintToVideo", positive=ref(4), negative=ref(5), vae=ref(3), width=w, height=h, length=n,
                  batch_size=1, start_image=ref(6), end_image=ref(7)),
        "9": node("ModelSamplingSD3", model=ref(1), shift=shift),
        "10": node("KSampler", seed=s, steps=steps, cfg=cfg, sampler_name=sampler, scheduler="simple", denoise=1.0,
                   model=ref(9), positive=ref(8, 0), negative=ref(8, 1), latent_image=ref(8, 2)),
        "11": node("VAEDecode", samples=ref(10), vae=ref(3)),
        "12": node("SaveImage", images=ref(11), filename_prefix=prefix),
    }
    return Built(g, "12", {"model": model, "width": w, "height": h, "frames": n, "fps": fps, "steps": steps,
                           "cfg": cfg, "shift": shift, "seed": s})


def wan_flf_a14b(image: str, prompt: str, *, model: str, model_low: str, lora: str, lora_low: str, text_encoder: str,
                 vae: str, width: int = 640, height: int = 640, seconds: float = 5.0, fps: int = 16, steps: int = 4,
                 split: int | None = None, cfg: float = 1.0, shift: float = 5.0, negative: str = "",
                 seed: int | None = None, prefix: str = "studio/loop", end_image: str | None = None) -> Built:
    """Wan 2.2 I2V A14B's first-and-last-frame clip with the Lightning (lightx2v) 4-step LoRAs — the official
    template: the high-noise expert takes the first half of the steps and hands its leftover noise to the low-noise
    one (KSamplerAdvanced twice), CFG 1, euler, shift 5. Frames saved as pictures, as wan_loop."""
    w, h, s = snap(width, lo=256, hi=1280), snap(height, lo=256, hi=1280), seed_of(seed)
    n = frames(seconds, fps)
    steps = max(2, min(40, steps))
    half = max(1, min(steps - 1, split if split is not None else steps // 2))
    g: Graph = {
        "1": node("UNETLoader", unet_name=model, weight_dtype="default"),
        "2": node("UNETLoader", unet_name=model_low, weight_dtype="default"),
        "3": node("LoraLoaderModelOnly", model=ref(1), lora_name=lora, strength_model=1.0),
        "4": node("LoraLoaderModelOnly", model=ref(2), lora_name=lora_low, strength_model=1.0),
        "5": node("ModelSamplingSD3", model=ref(3), shift=shift),
        "6": node("ModelSamplingSD3", model=ref(4), shift=shift),
        "7": node("CLIPLoader", clip_name=text_encoder, type="wan", device="default"),
        "8": node("VAELoader", vae_name=vae),
        "9": node("CLIPTextEncode", text=prompt.strip(), clip=ref(7)),
        "10": node("CLIPTextEncode", text=negative.strip() or WAN_NEGATIVE, clip=ref(7)),
        "11": node("LoadImage", image=image),
        "12": node("LoadImage", image=end_image or image),
        "13": node("WanFirstLastFrameToVideo", positive=ref(9), negative=ref(10), vae=ref(8), width=w, height=h,
                   length=n, batch_size=1, start_image=ref(11, 0), end_image=ref(12, 0)),
        "14": node("KSamplerAdvanced", model=ref(5), add_noise="enable", noise_seed=s, steps=steps, cfg=cfg,
                   sampler_name="euler", scheduler="simple", positive=ref(13, 0), negative=ref(13, 1),
                   latent_image=ref(13, 2), start_at_step=0, end_at_step=half, return_with_leftover_noise="enable"),
        "15": node("KSamplerAdvanced", model=ref(6), add_noise="disable", noise_seed=0, steps=steps, cfg=cfg,
                   sampler_name="euler", scheduler="simple", positive=ref(13, 0), negative=ref(13, 1),
                   latent_image=ref(14), start_at_step=half, end_at_step=10000, return_with_leftover_noise="disable"),
        "16": node("VAEDecode", samples=ref(15), vae=ref(8)),
        "17": node("SaveImage", images=ref(16), filename_prefix=prefix),
    }
    return Built(g, "17", {"model": model, "width": w, "height": h, "frames": n, "fps": fps, "steps": steps,
                           "split": half, "shift": shift, "seed": s})


# ── what is in front: a foreground mask (BiRefNet / Lucida); the cut-out itself is composed by the app ──

def foreground_mask(image: str, *, model: str, prefix: str = "studio/mask") -> Built:
    """The foreground mask of a picture (white = keep), saved as an image: the app composes the cut-out from it, so
    nothing but the alpha comes from the model (docs/local-image.md "Cut-outs")."""
    g: Graph = {
        "1": node("LoadBackgroundRemovalModel", bg_removal_name=model),
        "2": node("LoadImage", image=image),
        "3": node("RemoveBackground", bg_removal_model=ref(1), image=ref(2, 0)),
        "4": node("MaskToImage", mask=ref(3)),
        "5": node("SaveImage", images=ref(4), filename_prefix=prefix),
    }
    return Built(g, "5", {"model": model})


def video_mask(video: str, *, model: str, prefix: str = "studio/vmask") -> Built:
    """Every frame's foreground mask of a clip, saved as pictures in order: the app turns them into the subject-on-black
    clip the avatar's matte step reads (the same file a hosted video background remover gives)."""
    g: Graph = {
        "1": node("LoadBackgroundRemovalModel", bg_removal_name=model),
        "2": node("LoadVideo", file=video),
        "3": node("GetVideoComponents", video=ref(2)),
        "4": node("RemoveBackground", bg_removal_model=ref(1), image=ref(3, 0)),
        "5": node("MaskToImage", mask=ref(4)),
        "6": node("SaveImage", images=ref(5), filename_prefix=prefix),
    }
    return Built(g, "6", {"model": model})


# ── a picture changed by words: FLUX.2 Klein (the picture itself is the reference) ──

def klein_edit(image: str, prompt: str, *, model: str, text_encoder: str, vae: str, refs: tuple[str, ...] = (),
               megapixels: float = 1.0, steps: int = 4, cfg: float = 1.0, seed: int | None = None,
               prefix: str = "studio/edit") -> Built:
    """FLUX.2 Klein's image edit (the official template, distilled: 4 steps, CFG 1): the picture, scaled to about
    `megapixels`, is the reference latent of both the prompt and the empty negative, and the output keeps its size.
    `refs`: more pictures it may take from (clothes, a second character), each a reference latent too."""
    s = seed_of(seed)
    g: Graph = {
        "1": node("UNETLoader", unet_name=model, weight_dtype="default"),
        "2": node("CLIPLoader", clip_name=text_encoder, type="flux2", device="default"),
        "3": node("VAELoader", vae_name=vae),
        "4": node("LoadImage", image=image),
        "5": node("ImageScaleToTotalPixels", image=ref(4, 0), upscale_method="lanczos",
                  megapixels=max(0.25, min(2.0, megapixels)), resolution_steps=16),
        "6": node("GetImageSize", image=ref(5)),
        "7": node("CLIPTextEncode", text=prompt.strip(), clip=ref(2)),
        "8": node("ConditioningZeroOut", conditioning=ref(7)),
        "9": node("VAEEncode", pixels=ref(5), vae=ref(3)),
        "10": node("ReferenceLatent", conditioning=ref(7), latent=ref(9)),
        "11": node("ReferenceLatent", conditioning=ref(8), latent=ref(9)),
        "12": node("EmptyFlux2LatentImage", width=ref(6, 0), height=ref(6, 1), batch_size=1),
        "13": node("Flux2Scheduler", steps=max(1, min(50, steps)), width=ref(6, 0), height=ref(6, 1)),
        "14": node("KSamplerSelect", sampler_name="euler"),
        "15": node("RandomNoise", noise_seed=s),
    }
    pos, neg = "10", "11"
    for i, extra in enumerate(refs[:3]):  # (each further picture: loaded, scaled, encoded, chained onto both)
        b = 20 + i * 5
        g[str(b)] = node("LoadImage", image=extra)
        g[str(b + 1)] = node("ImageScaleToTotalPixels", image=ref(b, 0), upscale_method="lanczos",
                             megapixels=max(0.25, min(1.0, megapixels)), resolution_steps=16)
        g[str(b + 2)] = node("VAEEncode", pixels=ref(b + 1), vae=ref(3))
        g[str(b + 3)] = node("ReferenceLatent", conditioning=ref(pos), latent=ref(b + 2))
        g[str(b + 4)] = node("ReferenceLatent", conditioning=ref(neg), latent=ref(b + 2))
        pos, neg = str(b + 3), str(b + 4)
    g["16"] = node("CFGGuider", model=ref(1), positive=ref(pos), negative=ref(neg), cfg=cfg)
    g["17"] = node("SamplerCustomAdvanced", noise=ref(15), guider=ref(16), sampler=ref(14), sigmas=ref(13),
                   latent_image=ref(12))
    g["18"] = node("VAEDecode", samples=ref(17, 0), vae=ref(3))
    g["19"] = node("SaveImage", images=ref(18), filename_prefix=prefix)
    return Built(g, "19", {"model": model, "steps": steps, "cfg": cfg, "megapixels": megapixels, "seed": s,
                           "refs": len(refs[:3])})
