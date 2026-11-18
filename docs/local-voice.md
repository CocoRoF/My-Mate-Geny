# Local voice models (this machine's own GPU)

My Mate Geny serves speech (TTS) and speech-recognition (STT) models on the NVIDIA GPU of the machine it runs on — a
server (`docker compose`, [deploy](deploy.md)) or the computer of a desktop install. It is part of the app
(`backend/app/voicehost`), not a separate service: Settings → **로컬 모델 호스팅** → **Voice Studio** shows the GPU and
who is using it, downloads and serves the models, builds voice profiles and makes lines with them ([below](#voice-studio));
a mate's Voice tab then offers the engine **로컬 (이 서버의 GPU)** for her voice and for hearing the user, and her
phone calls use it too.

What the app provides is the framework that serves the models: the engines' environments, the installer, the GPU
placement, the voices. **No model weights are shipped.** Each model is downloaded by the user from its authors' Hugging
Face repository at a pinned commit, after reading and accepting its license in the model's card (the license, what it
allows, what it asks to be shown, the model page and the exact repositories are all there). What comes with the app is
the built-in voices' trained adapters, fetched once their model is installed ([below](#training-a-voice)).

The design and much of the code come from [geny-audio-module](https://github.com/CocoRoF/geny-audio-module) (the test
bed of these engines, same author, Apache-2.0): the worker engines, the runtime lock files and the GPU placement were
copied and adapted into the app (THIRD-PARTY-NOTICES.md).

## Who can run it

A server, or the desktop app's **local mode** (the app's own backend, on the computer it runs on): the same code and
the same Voice Studio either way, on that machine's own GPU. The engines are torch 2.8 —

| Platform | GPU | Engine environments |
|---|---|---|
| Linux x86-64 | NVIDIA, CUDA 12.8 | `runtimes/<name>.txt` (benchmarked on an RTX 5070) |
| Windows x86-64 | NVIDIA, CUDA 12.8 | `runtimes/<name>.windows-x86_64.txt`: the same pins without the Linux-only CUDA wheels (`nvidia-*`, `triton`: torch for Windows carries its CUDA libraries), plus `colorama` / `win32-setctime` |
| macOS on Apple Silicon | the Mac's GPU through Metal (`mps`), in its unified memory | `runtimes/<name>.macos-arm64.txt`: the same pins with PyPI's torch; macOS 14+ |

Anything short of what they need is refused before a download starts — the models list still shows what could be had,
and the card says why not (`app/voicehost/gate.py`, checked in this order, `GET /api/voice/status` → `gate.code`):

| Code | Refused when | |
|---|---|---|
| `off` | `VOICE_ENGINE_MODE=off` | switched off by the admin |
| `platform` | not one of the three above | an Intel Mac (no torch for it any more), Windows / Linux on ARM |
| `old_os` | macOS < 14 | MPS with bf16, and the onnxruntime the engines pin |
| `gpu_not_passed` | in a container that sees no NVIDIA device | the host has none, or it wasn't given to the container: [`deploy/docker-compose.gpu.yml`](../deploy/docker-compose.gpu.yml) |
| `no_gpu` | no NVIDIA GPU / `nvidia-smi` | |
| `old_driver` | driver < 570 | CUDA 12.8 |
| `old_gpu` | compute capability < 7.0 | the wheels carry sm_70 – sm_120 (Volta … Blackwell) |
| `small_gpu` | GPU memory < 4 GB (a Mac: < 8 GB of memory) | the smallest useful set (Whisper + OmniVoice) with headroom |
| `python` | the backend isn't CPython 3.12 | the engines' environments are made from its interpreter (the Docker image has 3.12; without Docker, run the backend on 3.12) |
| `packages` | the server lacks numpy, soundfile, soxr or huggingface_hub | part of the backend's dependencies; checked last, so a machine without a GPU says that |

Refused, every install / load / speak / transcribe answers 409 with the gate (`code`, `message`, the requirements);
the mate engine `local` is "not available" with that reason (her voice falls back to the browser's, below).

**In Docker** the image needs nothing more: give the container the GPU (NVIDIA Container Toolkit on the host) —
`docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d`. The engines and models then go into the
`geny-home` volume (`<data home>/voice`), so they survive rebuilds.

**Desktop (local mode)**: the bundled CPython 3.12 has everything the backend needs (uv included: it makes the engine
environments); a desktop has no ffmpeg, so nothing needs it — MP3 is written by libsndfile (the soundfile wheels bundle
1.2), and a browser recording (WebM) or another format the server can't read (M4A, a video's sound) is decoded in the
page and sent as WAV. On Windows no probe or worker opens a console window, and a worker gets 3 minutes to start (the
virus scanner reads torch's DLLs on the first start after an install). On a Mac the engines run on Metal in bf16, Whisper in
fp32 (in fp16 there it only repeats a token; `GENY_VOICE_DTYPE` for another), the few ops Metal lacks fall back to the CPU (`PYTORCH_ENABLE_MPS_FALLBACK`), the
models may take 60 % of the machine's memory by default and are never parked (the same memory either way); Voice
Studio's overview shows the GPU as unified memory, what this app's workers hold (each measures itself: no driver lists
per-process memory there — nor does Windows' WDDM mode), and the rest as other programs and the system.

## Models

`app/voicehost/catalog.py`. Sizes as downloaded; GPU memory as measured on an RTX 5070 (the card shows the estimate,
placement uses the measurement).

| Model | Kind | Engine (runtime) | Download | GPU | License |
|---|---|---|---|---|---|
| OmniVoice | TTS: cloning, voice design from a description, its own voice; 600+ languages | `omnivoice` (omni) | 3.3 GB | 2.4 GB | **Model weights CC-BY-NC (non-commercial)**: its model card ("The pre-trained model is licensed under the CC-BY-NC due to constraints from its training data (e.g., Emilia)"); code Apache-2.0; the audio tokenizer under the Boson Higgs Audio 2 Community License (Llama 3 based: no training other LLMs on its output, "Built with Higgs Materials" attribution) |
| VoxCPM2 | TTS: cloning that goes on from a clip and its words (its timbre, pace and way of talking), voice design and instructions, its own voice; 30 languages, 48 kHz | `voxcpm` (vox) | 5.0 GB | 6.4 GB | Apache-2.0 |
| Qwen3-TTS 1.7B (Base) | TTS: cloning from ~3 s, 10 languages | `qwen3_tts` (qwen) | 4.5 GB | 4.8 GB | Apache-2.0 |
| Qwen3-TTS 0.6B (Base) | TTS: cloning, lighter | `qwen3_tts` (qwen) | 2.5 GB | 2.9 GB | Apache-2.0 |
| Fun-CosyVoice3 0.5B | TTS: cloning, other languages, instructions, tags in text | `cosyvoice3` (cosy) | 5.4 GB | 3.6 GB | Apache-2.0 (its source, fetched at install: CosyVoice Apache-2.0, Matcha-TTS MIT) |
| Whisper large-v3-turbo | STT | `whisper` (qwen) | 1.6 GB | 2.0 GB | MIT |

The default speaking model is the first installed of OmniVoice → VoxCPM2 → Qwen3-TTS 1.7B → 0.6B → CosyVoice3;
hearing is Whisper. Every repository is pinned to a commit (`RepoFiles.revision`): what is installed is what was
measured, and a trained adapter fits it.

**VoxCPM2** (OpenBMB, `openbmb/VoxCPM2`) is tokenizer-free: its LM writes continuous audio latents that a diffusion
transformer refines, and with a clip *and its words* it goes on from the clip ("ultimate" cloning), so the line keeps
the clip's pace, pitch movement and way of talking rather than its timbre alone. Without the words it clones the timbre
from the clip; a description (`(calm, low, slow)` before the line) designs a voice or steers the clip's. Slower than
the others (RTF ~0.5 – 0.6 on an RTX 5070 without `torch.compile`, which needs a C compiler and Python's headers: off
unless the model's load options turn it on). Its LoRA is VoxCPM's own (not peft), switched per line like the others'.

### Installing

`POST /api/voice/models/{id}/install {accept_license: true}` — the license must be accepted first (recorded once per
model: `voice_licenses` — license, URL, when; a reinstall doesn't ask again). Then, in the background, with progress
on the card (`progress.state`):

1. **runtime** — the engine's Python environment, once per runtime (qwen serves Qwen3-TTS and Whisper): a venv made
   from the backend's own interpreter (CPython 3.12), filled with `uv` from the locked list
   (`app/voicehost/runtimes/{qwen,omni,cosy,vox}.txt`, `--no-deps`, torch from the PyTorch CUDA 12.8 index). All runtimes
   share one uv cache on that disk and are hard-linked from it: torch and the CUDA libraries are downloaded once
   (~5 GB the first time, seconds for the next runtime).
2. **source** — CosyVoice only: its source and Matcha-TTS's at pinned commits, as GitHub archives.
3. **weights** — the files of the model's repositories at their current commit (resolved first, every file from that
   commit, the commit recorded: `revisions` on the card), each in a child process that is killed and retried when it
   stalls for 90 s. `VOICE_HF_ENDPOINT` points at a mirror.

There must be room for it plus 2 GB on the disk (else 409 `no_room` before anything starts). `cancel` stops it;
`DELETE /api/voice/models/{id}` removes the files (and a runtime no model uses any more).

## How it is served

- **The server process never imports torch.** Each loaded model runs in a worker process of its own
  (`python -s -m app.voicehost.worker --engine X` in its runtime), talking JSON lines over a socket on 127.0.0.1 with
  a one-off token. A crash or a CUDA error takes down that worker only. Where `capped` exists (this project's servers),
  each worker gets its own memory scope (no `RLIMIT_AS`: CUDA needs a large address space).
- **GPU placement** (`host.py` `EngineManager`): a model is loaded when it is first needed; what it really takes on the
  GPU is measured, and resident models may fill `VOICE_VRAM_BUDGET` (85 %) of the memory — what other programs use is
  left to them. Room is made from the least recently used model: parked (weights kept in RAM, `VOICE_PARK_RAM_GB`,
  back on the GPU in a moment) or stopped. A model leaves the GPU after `VOICE_IDLE_UNLOAD_SECONDS` (10 min) unused; a
  parked one's process stops after `VOICE_PARKED_TTL_SECONDS` (30 min). A **pinned** model (a call's) is never moved
  out or idled out.
- **One GPU job at a time** (`GpuQueue`), by priority: a mate's line or the user's words first, the studio's lines
  next, loads, warm-ups and batches last. Every job keeps a record — what (`speak`, `hear`, `load`, `warm`), which
  model, for whom (`source`: `mate:<name>`, `call:<name>`, `studio`, `compare`, `seed`, `batch`, `settings`), how long
  it waited and took, the audio's length and real-time factor — the last 120 are in the studio's 개요.
- Where it lives: `<data home>/voice/` (`VOICE_HOME`) — `models/` (`VOICE_MODELS_DIR`; a fast local disk: loading is
  mostly reading it), `runtimes/` (`VOICE_RUNTIMES_DIR`), `references/` (the users' clips), `history/` (the studio's
  lines, by day), `tmp/`. About 26 GB for all six models and their four runtimes.
- The GPU limits and idle times above, the history's limits and the default models can also be set in Voice Studio →
  설정 (kept in `voice_settings`; "back to the server's value" removes the override).

## Voices

A voice (a **profile** in Voice Studio) is reference clips **by feeling** — `neutral`, `joy`, `sadness`, `anger`,
`surprise`, `fear`, `disgust`, `smile` — each with its exact words, plus a description, tags, a default model and its
parameters, and a voice description (`instruct`) for when there is no clip. A cloning model speaks a line like the clip
of its feeling; a feeling without one falls back along a chain, then to neutral, then to the first clip
(`voices.py` `_CHAIN`):

| A mate's tag / the feeling asked | Clips tried |
|---|---|
| `joy`, `laugh` | joy |
| `smile`, `greet` | smile → joy |
| `shy` | smile |
| `surprised`, `surprise` | surprise |
| `sad`, `sadness` | sadness |
| `worried`, `fear`, `scared` | fear → sadness |
| `angry`, `anger` | anger |
| `disgust` | disgust → anger |

- **Built in** (`backend/app/mate/builtin/voices/<key>/voice.json`, id `builtin:<key>`, read-only): **한채린**
  (`builtin:chaerin`) and **서아** (`builtin:seoa`), five clips each (8 – 12 s, 24 kHz mono, levelled to −20 dBFS;
  the other three feelings fall back as above). Duplicate one to make your own version.
  Made by the owner with their own ElevenLabs voices (each line generated twice, the take whose transcript matched the
  line kept); the owner holds all rights to them (`rights` in `voice.json`; THIRD-PARTY-NOTICES.md).
- **The user's own**: Voice Studio → 프로필 → +, then a clip per feeling — uploaded (WAV / MP3 / M4A / WebM …,
  ≤ 50 MB), recorded in the browser, or a line made in the studio — cut to the stretch kept (the editor suggests the
  best 5 – 15 s; without a cut the silence is trimmed; at most 30 s, at least 0.5 s kept). A new clip of a feeling
  replaces the one it had. Leave the words empty and the local Whisper writes them. Each clip is checked: too short
  (< 3 s), too long (> 20 s), clipped, very quiet or mostly silence is said on the clip (5 – 15 s of one speaker with
  little noise clones best). Stored in `voice_voices` / `voice_refs` and `references/`.
- **No voice**: OmniVoice speaks in a voice of its own, or one made from a description (`instruct`, e.g.
  `female, low pitch, calm` — it was trained on English and Chinese descriptions).

## Laughs, sighs and yawns

People write the sounds they make — 헤헤, ㅋㅋ, 하하에헤, 하암~, 후우…, 헉!, 흥 — and a model that reads them as words says
the syllables. Every line here (Voice Studio, a mate's local voice, a batch) goes through `nonverbal.py` first: the
sounds are found (whole words only — 아하, 하키, 휴가, 흥미, 이리 와 are words; tags a person writes count too:
`[웃음]`, `(한숨)`, `*하품*`, `[laugh]`, an engine's own `[laughter]`), then given to the engine the way it makes them.
Off (Voice Studio's 의성어를 소리로, `nonverbal: false`): read as written — but ㅋㅋ is still said 크크, ㅠㅠ and another
engine's tags are still not read out.

**Measured** (`tools/nonverbal_bench.py`; RTX 5070, 2026-11-15, 한채린's clip; an AudioSet classifier (AST) for whether a
laugh / sigh happens — a real recording of someone laughing mid-sentence scores 0.1 – 0.4, a line without one ~0.01 —
and Whisper for whether the words are all still there):

| | OmniVoice | CosyVoice3 | Qwen3-TTS 1.7B |
|---|---|---|---|
| 헤헤 / 하하 read as written | 0.01 | 0.02 – 0.05 | 0.00 – 0.07 |
| with the engine's laugh tag | `[laughter] 헤헤`: a laugh in **38%** of lines (16 / 42), 0.2 on average | `[laughter]`: no change in its cloning mode (0.01 – 0.05); `<laughter>` neither | none: `[laughter]` is read out ("라우터") |
| a tag in place of the syllables | swallows the words after it (2 of 3 takes) | — | — |
| a laughing reference clip | no better | words lost (75%) | no laugh |
| **the voice's own laugh put in** | **0.44 – 0.61** | **0.34 – 0.35** | **0.38 – 0.54** |
| sigh (후우…) | `[sigh] 후우…` 0.56 – 0.85 | as written 0.41 – 0.87 | as written 0.68 – 0.89 |
| yawn (하암~) | `[sigh] 하암~`: a breathy 하암 (no tag, no class to measure it) | as written | as written |

Again on 2026-11-18, with the voices' trained adapters and VoxCPM2 (서아's clip; 4 takes of 4 lines that laugh, as
written): a laugh as written 0.00 – 0.08 on OmniVoice, 0.01 – 0.25 on VoxCPM2 (one line in three of four takes with
서아's adapter, the others never), 0.00 – 0.11 on Qwen3-TTS 1.7B, 0.00 – 0.01 on CosyVoice3 — trained or not. The
adapters had nothing to learn it from: the ElevenLabs takes the built-in voices were trained on read 헤헤 as syllables
(0.01 in all 11 of 서아's lines that say it), and ElevenLabs' own `[laughs]` / `[giggles]` tags (v3 and v4) didn't laugh
in these voices either (0.01 – 0.10). A sigh as written comes out on every model (0.3 – 0.8). A laugh on its own —
the whole line a laugh — is another matter: OmniVoice with 서아's adapter in 67 – 100% of takes, VoxCPM2 with hers in
33 – 67%, Qwen3-TTS in 0 – 67%.

So:

- **Laughs**: no engine laughs reliably inside a line, but a laugh made on its own, the best of many takes, laughs
  every time. A voice keeps a few clips of **its own laugh** (`sounds.py`), and a line that laughs gets one put in where
  it laughs — the words before and after made as their own parts, the clip levelled to them, faded, a short breath of
  silence on each side. A short laugh (하하, ㅋㅋㅋ, 헤헤) takes a **giggle**: the strongest second of a laugh, faded out.
  CosyVoice3 makes up words for a part of two or three syllables (“왜 그래” came out as “잠시만요” in 2 of 6 takes), so
  there a laugh that would leave such a part beside it stays in the line.
- **A voice's 의성어 clips** (프로필 → 의성어: recorded or uploaded, label `laugh`, `sigh`, `yawn`, `gasp` or `sob`,
  several of each, never cloned from): a line that makes one of those sounds gets the voice's clip of it there; a sound
  it has no clip of is made by the engine as written (below).
- **Which laugh a line gets**, the first found: the clips recorded for its profile (the person laughing); the laughs **the line's
  own model** made in the line's voice — with that voice's trained adapter there, where it has one — for the models
  that laugh on their own (`sounds.LAUGHS_ALONE`: OmniVoice, VoxCPM2; `<home>/sounds/<clip key>.<model>.<run>/`), so a
  VoxCPM2 line of 서아 laughs with VoxCPM2's laugh in her trained voice; a built-in voice's (`sounds/` beside its clips:
  48 takes made with OmniVoice, the best 3 kept — 한채린 0.42 / 0.39 / 0.35, 서아 0.51 / 0.45 / 0.43); any other model's
  made for the clip. Qwen3-TTS and CosyVoice3, which seldom laugh on their own, take one of those. **Made**: 16 takes of
  the lines its model laughs best with (`nonverbal.BANK_TEXTS`: `[laughter] 아하하하` on OmniVoice, `아하하하하!` /
  `Hahahaha!` on VoxCPM2), each heard by the AudioSet classifier (`catalog.SOUND_CHECK`,
  MIT/ast-finetuned-audioset-10-10-0.4593, BSD-3-Clause, 350 MB, fetched the first time), the 3 that laugh most kept
  (at least 0.2; none: not tried again for a day). Made by itself, in the background, the first time a line of a voice
  laughs on a model that hasn't made one in that voice (Voice Studio → 설정 → 의성어; until then the line takes another's,
  or the model's own laugh when there is none), or with 프로필 → 의성어 → "<model>로 만들기". 한채린's laugh was in
  9 of 48 OmniVoice takes, 서아's in 17: 16 takes leave about three.
- **The rest** in the line, as each engine makes it best (`RECIPES`): OmniVoice gets its tags *before* the written sound
  — `[laughter] 헤헤` (when the voice has no laugh yet), `[sigh] 후우…`, `[sigh] 하암~`, `헉! [surprise-ah]`,
  `[surprise-wa] 우와`, `흥 [dissatisfaction-hnn]`; CosyVoice3 and Qwen3-TTS the syllables alone. Everywhere: a bare tag
  gets its sound's syllables (`[웃음]` → 하하하: a tag needs syllables to carry it), ㅋㅋ → 크크, ㅎㅎ → 흐흐, ㅠㅠ not read.
- **Yawns**: no engine here has one, and nothing measures one. A profile's yawn clip is put in when it has one; without
  it 하암~ is said (with OmniVoice's sigh).
- **A mate on another engine** (`app/mate/voice.py`): ElevenLabs v3 / v4 (`eleven_v3*`, `eleven_v4*`, the default
  `eleven_v4_turbo`) get audio tags — `[laughs] 헤헤`, `[giggles]`, `[sighs]`, `[yawns]`, `[gasps]` (measured: laugh
  0.11 against 0.05 as written, sigh 0.61; a tag alone, with no words, is refused); an OmniVoice server its own tags; the
  others only what can be said. The version of these rules is in the speech cache's key: a line made before is made
  again.

## Voice Studio

Settings → 로컬 모델 호스팅 → **Voice Studio** (`frontend/src/components/voicestudio/`; the page is in the address,
`/?view=settings&tab=voice-studio&page=history`). Its pages say little: what a card, a field or a setting is waits
behind a (?) beside its title or label (`ui/HelpTip.tsx` — on hover with a mouse, on a tap or a click; a sheet on a
phone), as in Image Studio. Its pages:

| Page | What |
|---|---|
| 개요 | each GPU — load, temperature, power, clock, fan — and **whose its memory is**: this app's models (each worker's process, measured by the driver), other programs (`nvidia-smi --query-compute-apps`), and what no process here accounts for (the host's display, other containers); the last 30 minutes (sampled every 5 s while someone looks, else every 30 s); the models on the GPU (park, unload, load); the GPU queue — running, waiting, the last jobs and for whom; engine events; the machine's RAM and disk |
| 모델 | the gate, each model's card (license, install, load / unload, default model), its default parameters (what every line made with it starts from: a mate's, the studio's, a batch's), the engines' environments |
| 학습 | a profile taught its voice from recordings of the person: drop them in, start — the rest is the run's ([below](#training-a-voice)); each run's steps, progress, how much of the recordings it kept, before / after, A/B samples, on / off, delete |
| 프로필 | the profiles (search, mine / built-in, ★), its LoRA adapters, a chip each (`LoRA · OmniVoice`; a built-in voice's for a model not installed yet faint: it speaks with it once the model is), the eight clips (play, upload, record, trim, words and language), its 의성어 (its own clips of each kind — laugh, sigh, yawn, gasp, sob —, each model's made laughs with how much each laughs, make with a model, delete — [above](#laughs-sighs-and-yawns)), details (description, tags, default model and parameters, voice description; a built-in voice's rights and source in the page's language), duplicate, delete |
| 생성 | a line: profile, model, mode (자동 / 복제 / 설계 — what the model and the profile allow), feeling (a dot where the profile has the clip), language, description presets, parameters, seed (random, or kept to make the same line again), 의성어를 소리로 (on: the sounds written in it — 헤헤, ㅋㅋ, 하암~, 후우… — made as sounds) → waveform, timings, what became a sound, download (WAV / MP3 / OGG / FLAC), ★, same seed again, save as a profile's clip; the recent lines under it |
| 일괄 생성 | text (a line each, `[joy] …`), CSV (`text` + any of `profile`, `feeling`, `seed`, `language`, `instruct`, `model`) or JSON, ≤ 500 lines, shared settings (a line's own columns win), one seed for all or one each; run at the lowest priority, one line at a time; progress, cancel, retry failed, resume one a restart stopped (`interrupted`), each line playable, a ZIP in a format with `manifest.json` |
| 히스토리 | every line made here with everything that made it: search, filter (profile, model, where from, ★), play, download, make again (opens 생성 with its settings and seed), save as a clip, delete (one or many). Over `history_max_entries` (2000) or `history_max_gb` (5) the oldest go first; ★ lines and batches' lines stay |
| 도구 | A/B comparison (one line, up to five settings, the same seed), seed search (one line, 2 – 12 seeds), a clip's analysis (format, level, silence, warnings, the best stretches → add one to a profile, its words and language), transcription |
| 설정 | GPU share, idle unload, parked time, parking RAM, history limits; the default speech / recognition model and the profile the studio starts with; whether a voice's laugh is made by itself; paths and engine mode (from the environment) |

## Training a voice

Voice Studio → **학습** (`frontend/src/components/voicestudio/TrainPage.tsx`; the server: `app/voicehost/training.py`,
the run: `app/voicehost/train/`). Cloning from a clip copies a voice; a profile taught by recordings of the person
speaks more like her from a short clip — and, on OmniVoice, VoxCPM2 and Qwen3-TTS, with no clip at all. Every speech
model learns: **OmniVoice, VoxCPM2, Qwen3-TTS 0.6B / 1.7B and CosyVoice3** — each its own LoRA adapter. **What the user does: give the
recordings** (any audio or video — a talk, a stream, voice notes — up to 12 files of 300 MB at once, one person) and
start; the installed models are all ticked to begin with. Everything else is the runs': one per model, one after
another, the recordings heard once (the first run's utterances and words are the others' — `group_id`, `shared_data`):

| Stage | |
|---|---|
| prepare | each recording at 24 kHz, cut into utterances at its pauses (1.5 – 12 s, `train/segment.py`) |
| transcribe | each utterance's words by Whisper large-v3-turbo; the language found by Whisper's detector unless given |
| screen | only her: an utterance unlike the rest (CAM++ speaker embeddings, below the median − 0.18) is someone else; words that can't be right for its length, or the same words over and over; clipping, too quiet. At most 90 minutes are kept, at least 60 s must be |
| tokens | the utterances in the model's own terms (`train/<model>.py`): OmniVoice's audio tokens (25 a second); VoxCPM2's text ids and the 16 kHz audio its VAE encodes as it trains (6.25 latent patches a second); Qwen3-TTS's codes (12.5 frames a second × 16 codebooks) and speaker embeddings; CosyVoice3's speech tokens (25 a second) and its words |
| baseline | the profile as it clones now, measured on new sentences in her language with a long clip (her own neutral clip, else her best 5 – 12 s utterance), a short one (~3 s) and none (OmniVoice, VoxCPM2: its own voice; Qwen3-TTS: her mean speaker embedding, no clip; CosyVoice3 can't speak without a clip — not measured): how alike (CAM++ cosine to the centroid of her kept utterances) and how intelligible (Whisper's character error rate) |
| train | LoRA (r 16, α 32), AdamW 1e-4 with warm-up and cosine, bf16, gradient checkpointing, about 50 passes over her data (200 – 1500 steps), measured six times along the way — on each model's own way of speaking (below) |
| done | the best checkpoint — the most alike over the references, never less intelligible than before (CER at most +0.03 in each) — kept as an adapter with A/B samples, and put on the profile for that model when it is better |

What each model learns (`train/recipe.py`: one recipe each, in the model's own runtime):

- **OmniVoice** (`train/omni.py`): LoRA on the LLM's attention and MLP projections, its audio embedding and heads in
  full, with OmniVoice's own masked-token objective; fp32 weights under bf16. Adapter ~54 MB.
- **VoxCPM2** (`train/vox.py`): VoxCPM's own LoRA (r 16, α 32 — `engines/voxcpm.py` `LORA`, the layers the engine
  loads an adapter into) on its LM and its diffusion transformer, on VoxCPM2's own objective (the diffusion loss on
  the audio latents and the stop loss, from its packer); half the samples with another of her utterances as the
  reference, as a clip is used when she speaks. The frozen weights in bf16, the LoRA in fp32 under bf16 autocast, the
  audio VAE in fp32 as upstream keeps it; its packer is loaded on its own (`voxcpm.training` wants the datasets stack,
  which the vox runtime doesn't carry); each transformer layer recomputed in the backward pass (upstream has
  no gradient checkpointing, and a batch's activations alone outgrow a 12 GB GPU), and the model made on the GPU in
  bf16 rather than in fp32 on the CPU (~9 GB of RAM, the checkpoint on top). Adapter ~18 MB.
- **Qwen3-TTS** (`train/qwen.py`): LoRA on the talker's layers only — the code predictor, which the engine runs as a
  CUDA graph, stays as it was; its loss (the 15 other codebooks, 0.3 ×) still teaches the talker. Trained in the
  layouts the engine speaks in: after another of her clips (in context: the clip's words then the line's, its codes,
  the line's words fed a frame at a time) and from her voice alone (the speaker embedding only — her mean embedding is
  kept beside the adapter, `voice.safetensors`, so the trained voice speaks without a clip). Not upstream's
  finetuning script, whose loss doesn't match generation (its text projection missing, labels shifted twice, the
  code predictor fed the frame it predicts — QwenLM/Qwen3-TTS #371, #278, #384). bf16 weights. Adapter ~35 – 70 MB.
- **CosyVoice3** (`train/cosy.py`): both halves of it, one adapter (`engines/cosyvoice3.py`: `Learned`). Its LLM
  (how her words go): LoRA on the Qwen2 layers, the speech-token decoder and embedding in full, on CosyVoice3LM's own
  sequence ([sos, instruction + words, task, speech tokens] → the tokens and eos); half the samples put after another
  of her utterances, as zero-shot inference puts a line after the clip. Its flow (her timbre — mel from the tokens,
  with the clip's embedding and mel): LoRA on the DiT's attention and feed-forward, on its own flow-matching loss (a
  random start of her mel as the prompt, as upstream trains it; her mel padded to whole tokens, 2 frames each). The
  LLM alone hardly moved how like her it sounds (+0.00 / +0.01 — the flow carries the timbre); with the flow +0.02
  with both clips. HiFT is left as it is. Adapter ~50 MB.

- **On the profile**: a trained profile speaks with each model's adapter on that model — in the studio, in batches,
  as a mate's voice (her speech cache's key includes the adapter: new lines for a new one) — `voice_adapters` (voice,
  model → run); the models it wasn't trained for clone from its clips as before. The worker switches adapters per
  line on one loaded model (peft, in place; the last four kept; off for a voice without one — VoxCPM2's own LoRA: the
  adapter's weights copied into its layers when another is asked for, the layers off for none). A run's card turns its
  adapter on and off; deleting the run takes it off and removes it; a newer run of the same model is put on instead.
  On 학습 the latest training's runs (and any still going) are open; older ones fold to a line — how like her each got,
  before → after — and open again with 자세히.
  An adapter is for the model it was made with (the revision in `geny.json`): after a new version the profile speaks
  without it. A new profile gets her clearest utterance as its neutral clip. 프로필 marks a trained profile
  (a `LoRA · <model>` chip for each adapter), and 생성 / 히스토리 a line made with one (`OmniVoice · LoRA`, the history's
  `adapter`).
- **The built-in voices** (한채린, 서아) learn like any profile — what they are trained into here goes before what they
  came with — and **they come trained, on every speech model**: their adapters, trained with 학습 on the owner's own
  recordings of their voices (made with the owner's ElevenLabs voices, which the owner holds every right to), are
  published as release assets (`voice-adapters-v1`; not in the repository) and listed with their SHA-256 in
  `app/voicehost/shipped.py`. A model's are fetched as soon as it is installed (and 30 s after the server starts, or
  the first time a built-in voice speaks on it — that line still without), checked, and unpacked under
  `<voice home>/adapters/<voice>/<model>/`; only the adapter's own files are taken from the zip. Voice Studio → 설정 →
  "기본 목소리는 학습된 어댑터로 말하기" turns them off (`shipped_adapters`; on again, what is missing is fetched); under
  it each model's line says whether its are here, coming, or come once the model is installed.
  An OmniVoice asset says it is for non-commercial use only — OmniVoice's weights are CC-BY-NC, and the adapter is an
  adaptation of them (credited to k2-fsa OmniVoice; `…-v2.zip`; the v1 zips, the same adapters, stay in the release
  for older versions but lack that notice) — and carries the notices the Boson Higgs Audio 2 Community License asks of
  a model made with OmniVoice's tokenizer and made available ("Higgs Audio 2" at the start of its name, the agreement
  and Meta Llama 3's with it); the others the Apache License 2.0 and a `NOTICE.md` (what was trained, on what, the base model's
  weights not included).
  v1 (2026-11-17), from ~18 / 19 minutes of speech made with the owner's ElevenLabs voices (`eleven_v4_turbo`, 174 /
  175 lines written for each character) and their five clips. Through the worker as the app speaks (8 new sentences,
  CAM++ similarity to her recordings), without → with the adapter:

  | Model | 한채린, from her five feeling clips (mean) | 서아 | With no clip (한채린 / 서아) | Asset |
  |---|---|---|---|---|
  | OmniVoice (서아's at half the learning rate, 5e-5: it kept her clips' likeness) | 0.841 → 0.852 | 0.837 → 0.846 | 0.23 → 0.85 / 0.29 → 0.83 | 54 MB |
  | VoxCPM2 | 0.801 → 0.841 | 0.787 → 0.832 | 0.22 → 0.87 / 0.17 → 0.85 | 18 MB |
  | Qwen3-TTS 1.7B | 0.787 → 0.880 | 0.749 → 0.836 | – → 0.88 / 0.85 (Base has no voice of its own) | 35 MB |
  | Qwen3-TTS 0.6B | 0.752 → 0.874 | 0.748 → 0.847 | – → 0.88 / 0.86 | 20 MB |
  | CosyVoice3 | 0.850 → 0.867 | 0.829 → 0.859 | (always from a clip) | 52 MB |

  No clip of either voice came out less like her with its adapter (each of the five, on each model); CER 0 in the
  runs' own measurements. **How she talks** — on 6 new lines each, the pitch range and level, the speaking rate and
  the pauses, each as a distance from her own recordings in units of their own spread, averaged (0: talks like her):
  with her clip, VoxCPM2 with its adapter came closest — 서아 0.32 (OmniVoice with its adapter 0.70, VoxCPM2 without
  1.07), 한채린 0.74 (OmniVoice with its adapter 0.91; VoxCPM2 without one, 0.45, talks more like her but sounds less
  like her: 0.84 against 0.89); with no clip 0.61 / 0.62. Its words were heard back a little less exactly (CER 2 – 4 %,
  OmniVoice's 1 %).
- **What it needs**: the model installed; Whisper large-v3-turbo's weights (MIT) and CAM++'s (`campplus.onnx` from
  `FunAudioLLM/Fun-CosyVoice3-0.5B-2512`, 28 MB, Apache-2.0) — fetched for the first run after the user accepts them
  in the form once; `peft` (VoxCPM2: its own LoRA) and `onnxruntime` in each engine's runtime (in its lock: a runtime from an older lock keeps
  speaking and is brought up to date in place — 30 s after the server starts, or before the run). The GPU, free
  (measured at most, and some room): Qwen3-TTS 0.6B 6 GB, OmniVoice 7 GB (its measurements, a sentence at a
  time after a 10 s clip, need more than its training), Qwen3-TTS 1.7B and CosyVoice3 8 GB, VoxCPM2 10 GB; its
  process is held to 12 GB of RAM (`capped`, where there is one).
- **Sharing the GPU**: one run at a time. It waits while a call holds its models or a mate spoke in the last 20 s, and
  while the GPU hasn't the room. While a mate speaks (an interactive job in the GPU queue) it pauses: compute
  stops, its memory stays. When the memory is wanted — a model that doesn't fit, an image job — it saves where it is
  and leaves (`released`), and goes on from that step when the GPU is free again; a server restart goes on the same
  way (a run cut off without a saved step starts over).
- **What stays**: the recordings (to train again; hard links between a group's runs), the adapter, the samples and the
  report; the cut utterances and the saved steps go when the run ends. Under `<voice home>/training/<run>/`. Nothing
  leaves the machine.
- **License**: Qwen3-TTS, CosyVoice3 and VoxCPM2 are Apache-2.0 (code and weights). **OmniVoice's weights are CC-BY-NC**
  (non-commercial; its model card: because of its training data, e.g. Emilia): a LoRA adapter trained on it — the
  built-in voices' OmniVoice adapters too — is an adaptation of it, for non-commercial use only, with credit to
  k2-fsa OmniVoice and the licence named. Its audio tokenizer is under the
  Boson Higgs Audio 2 Community License (accepted with OmniVoice). Its 1.b.v forbids using its output "to improve any
  other large language model (excluding Boson Higgs Audio 2 or derivative works thereof)", and 1.b.i asks that a model
  fine-tuned with it that is *distributed or made available* be named "Higgs Audio 2 …". Training OmniVoice feeds the
  tokenizer's codes to OmniVoice's own LLM (which was trained on them) and keeps the adapter on this machine; whether
  that falls under 1.b.v is the user's call (not settled here). The adapters are never published by the app.

| | |
|---|---|
| `GET /trainings?voice_id=` | `{runs, kit}`: every run (model, group, state, stage, progress, data — kept, dropped by reason —, result with the conditions it was measured with, samples, applied) and what a run needs (`models` — each that learns: installed, `need_gb` —, `stt`, `speaker` — ready, size, license) |
| `POST /trainings` (multipart `voice_id`, `files`, `language`, `accept_licenses`, `models` — ids, comma-separated; none: every installed one that learns) | `{runs}`: one per model (`queued`). Refused: `no_voice`, `busy` (one of the models is learning the profile already), `not_trainable`, `needs_model`, `license` (the weights aren't accepted), `too_short` (under 60 s of sound), `bad_audio`, `too_many`, `too_large` |
| `GET /trainings/{id}` · `POST /trainings/{id}/cancel` · `POST /trainings/{id}/apply` `{on}` · `DELETE /trainings/{id}` · `GET /trainings/{id}/samples/{name}` | one run, stop it, its adapter on / off, remove it, an A/B sample |
| `GET /voices` | each profile with `adapters` (`{model id: run}`; a built-in voice's shipped one is `shipped-…`) |
| `GET/PUT /settings` | `shipped_adapters` (on / off), `shipped` (each shipped adapter: its voice and model, size, fetched, error) |

Measured (RTX 5070, peft 0.21.3), speaker similarity (CAM++) with a long clip / a short one / none — OmniVoice 0.2.1:

| Data | Steps | Before | After | CER | Time | GPU |
|---|---|---|---|---|---|---|
| KSS, 26 min (one speaker, read speech) | 1500 | 0.79 / 0.73 / 0.34 | 0.79 / 0.75 / 0.76 | 0 → 0 | 13 min | 4.9 GB |
| KSS, 5 min (resumed once mid-run) | 200 | 0.83 / 0.80 / 0.40 | 0.84 / 0.80 / 0.81 | 0 → 0 | – | 4.9 GB |
| KSS joined into one 12-minute recording, through 학습 (7:44 kept, 154 utterances; 4 left out by the speaker check — all hers: 2.5 % lost) | 300 | 0.85 / 0.79 / 0.39 | 0.85 / 0.85 / 0.83 | 0 → 0.008 (long clip) | 5.3 min; 8.5 min from upload with the first fetch of Whisper (2.6 min) | 4.8 GB |

With no clip at all, the trained profile is as like her as the untrained one with a long clip; with a clip, about the
same (the clip already carries most of it). 0.457 s a step; the run's process ~7 GB of RAM. A line in the trained voice afterwards: RTF 0.15 – 0.31, as
before.

The other models, on the same speaker (KSS joined into one 12-minute recording: 166 utterances, 8:29 kept; each run's
best checkpoint, the six sentences it is measured with):

| Model | Steps (best) | Before | After | CER | Time | GPU |
|---|---|---|---|---|---|---|
| Qwen3-TTS 0.6B | 500 (415) | 0.80 / 0.78 / 0.72 | 0.79 / 0.80 / 0.80 | 0.028 / 0.020 / 0 → 0 | 9.4 min | 4.1 GB |
| Qwen3-TTS 1.7B | 500 (415) | 0.81 / 0.78 / 0.68 | 0.80 / 0.79 / 0.81 | 0 / 0 / 0.020 → 0 | 9.0 min | 6.1 GB |
| CosyVoice3 (LLM + flow) | 280 (276) | 0.83 / 0.81 / – | 0.85 / 0.83 / – | 0 → 0 | 8.8 min | 7.0 GB |

VoxCPM2 on 한채린's recordings (the built-in adapter, 17:51 kept): 920 steps (765 best), 0.80 / 0.81 / 0.19 →
0.85 / 0.85 / 0.86, CER 0, 24 min, 8.7 GB of the GPU; its process ~5.5 GB of RAM while it loads.

Qwen3-TTS gains most where a clip says least: without one (her learned embedding, +0.08 / +0.13) and from 3 s; with a
long clip it was already close to her recordings and stays there (a checkpoint may not be more than 0.02 less like
her with any reference). CosyVoice3 (no "none": it always speaks from a clip) gains with both. The worker switches
an adapter on one loaded model in a few seconds the first time, then per line at no cost (OmniVoice, Qwen3-TTS — its
code predictor's CUDA graph untouched — and CosyVoice3 checked on the GPU: none → adapter → none → adapter, and
Qwen3-TTS with no clip).

## A mate on the local engine

Mate settings → Voice → engine **로컬**:

- `tts.model` — her model (empty: the default above). A model that was removed falls back to the default
  (`VoiceHost.model_for`).
- `tts.voice` — a voice id (`builtin:chaerin`, one of the user's). Empty: her built-in voice (a built-in mate), else
  her own reference clip (`tts.ref`, from an imported character), else none (OmniVoice's own / `tts.instruct`).
- `tts.instruct` — for OmniVoice (design) and CosyVoice (instructions); `tts.speed`.
- Her lines are cached like every engine's; the key includes the clip (path, size, time) and its words, so a new clip
  is a new line.
- Not available (refused by the gate, nothing installed): `POST /api/mates/{id}/speech` answers 204 +
  `X-Speech-Fallback: browser` with the reason — she speaks with the browser's voice and the Voice tab says why.
- `stt.engine = "local"` — the user's recordings are transcribed by the local Whisper; it is also the first recording
  fallback (`stt_fallback`) whenever it is installed.
- **Calls** ([mate-calls](mate-calls.md)): with local STT the call listens in `record` mode (the page cuts the
  utterances, each goes to Whisper). Her local models are pinned and warmed while the phone rings — her first words
  don't wait for a load — and released when the call ends.

## API (`/api/voice`, signed in)

| | |
|---|---|
| `GET /status?lang=ko` | the gate, the GPUs, RAM and disk, every model (catalog + what is installed, progress, resident state), runtimes, recent GPU decisions, defaults |
| `POST /models/{id}/install` `{accept_license}` · `/cancel` · `DELETE /models/{id}` | install, cancel, remove |
| `POST /models/{id}/load` · `/unload {park}` | put on / take off the GPU by hand |
| `GET/POST /voices` · `PATCH/DELETE /voices/{vid}` | voices (built-ins are read-only) |
| `POST /voices/{vid}/references` (multipart `file`, `label`, `transcript`) · `PATCH/DELETE /references/{rid}` · `GET /voices/{vid}/references/{rid}/audio` | clips |
| `POST /preview` `{model_id, voice_id?, text, emotion?, language?, instruct?, params?}` | a WAV; `X-Voice-Info`: ready / generate seconds, real-time factor |
| `POST /transcribe` (multipart `file`, `language`) | `{text, language, model_id, seconds, elapsed}` |
| `GET/PUT /models/{id}/defaults` `{params}` | a model's default parameters |
| `POST /voices/{vid}/duplicate` `{name?}` · `POST /references/{rid}/trim` `{start, end}` | a profile's copy (built-ins too) · cut a clip |
| `POST /voices/{vid}/references` + `start`, `end`, `replace` | cut on upload; replace the feeling's clip (default) |
| `GET /overview?lang=` | 개요: GPUs with telemetry and `usage {ours, others, unseen}`, `series`, residents, `queue {running, waiting, recent}`, events, host, history usage, running batches, settings |
| `GET/PUT /settings` | the runtime values (`null`: back to the server's), `default_tts`, `default_stt`, `default_voice`, `auto_sounds` (`sound_maker`: the model that would make a laugh) |
| `POST /generate` `{text, model_id?, voice_id?, feeling?, mode?, language?, instruct?, params?, seed?, source?, nonverbal?}` | a line, kept in the history → the entry (seed, timings, `info` — `sounds`: what became a sound, `clip` where the voice's laugh went in; `spoken`: what the engine was given). `nonverbal: false`: read as written (kept as `params._nonverbal`) |
| `GET/POST/DELETE /voices/{vid}/sounds` · `GET /voices/{vid}/sounds/{name}` | a profile's laughs: `{own, made: {kinds, scores, model_id, checked}, making, maker, auto}` · make them (again; `no_laugh` when no take laughed) · forget the made ones · a made clip's audio |
| `GET /history?q&voice_id&model_id&source&starred&batch_id&limit&offset` · `/history/facets` | the history, its filters |
| `GET /history/{id}/audio?format=wav\|mp3\|ogg\|flac&download=1` · `PATCH /history/{id}` `{starred, note}` · `POST /history/delete` `{ids}` · `POST /history/{id}/save-as-reference` `{voice_id, label, transcript}` | a line's audio, ★, delete, as a clip |
| `POST /analyze` (multipart `file`, `transcribe`, `window`) | a clip's probe, stats, best windows, words |
| `GET/POST /batches` · `GET/DELETE /batches/{id}` · `/cancel` · `/retry {failed_only}` · `GET /batches/{id}/zip?format=` | batches |

Changes (installs, loads, voices, history, batches) are pushed to every open window like other settings
(`mates_changed("voice")`).

## Measured

RTX 5070 (12 GB, driver 580.159, compute 12.0), 2026-11-14, Korean lines of a few seconds, the built-in voices:

| Model | Generation time / audio length | GPU memory |
|---|---|---|
| OmniVoice | 0.18 – 0.25 | 2.1 – 2.4 GB |
| VoxCPM2 (2026-11-17, without `torch.compile`) | 0.5 – 0.6 | 5.7 – 6.4 GB (RAM: 5.5 GB while it loads, 1.9 GB after) |
| Qwen3-TTS 0.6B | 0.33 | 2.9 GB |
| Qwen3-TTS 1.7B | 0.33 | 4.8 GB |
| CosyVoice3 0.5B | 0.5 | 3.6 GB |
| Whisper large-v3-turbo | ~0.1 s per line | 1.8 GB |

A model's first use loads it (OmniVoice ~8 – 10 s); warm, it is ready in 0.1 – 0.3 s. Every TTS model's lines in both
built-in voices were heard back by the local Whisper with a character error rate of 2 – 5 % (numbers written
differently). Installing everything from nothing: the first runtime with Whisper ~2 min, the others ~15 s each.
The same in a container given the GPU (`docker-compose.gpu.yml`, `python:3.12-slim` like the image): the gate passed,
OmniVoice spoke in 서아's joy clip at 0.18, and Whisper heard the line back word for word.

## Not yet

- **GPU telemetry on a Mac**: load, temperature and power need `powermetrics` (root): the overview shows memory only.
- **VoxCPM2 on a Mac**: upstream runs it in fp32 on Metal (bf16 drifts there until the line is garbled), about twice
  the memory of its card's figure (~9 GB of unified memory); not measured on a Mac, and left out of the macOS CI
  smoke (its runner has 7 GB) — its macOS lock is resolved, not run. On Windows CI it runs on the CPU, made in bf16.
- **AMD / Intel GPUs** (ROCm, DirectML, XPU): no lock files for them.
- **Training on a Mac or on Windows**: the run is written for both (on Apple Silicon in fp32 on Metal), and their omni
  locks carry its packages, but it has been measured only on an NVIDIA GPU under Linux.
- **A GPU elsewhere**: a server without a GPU can't use another machine's GPU for these models yet (a remote voice
  node). Until then: run My Mate Geny on the GPU machine, or point the mate at an HTTP service (OmniVoice URL / Whisper
  URL in 이미지 및 음성 공급자 → 직접 호스팅한 음성 서비스).

## Tests

`backend/tests/test_voice_local.py`: the gate on Windows and on Apple Silicon (and what it refuses), a Mac's defaults,
each platform's lock with the benchmarked pins (and the CUDA index only for CUDA builds), MP3 without ffmpeg, the GPU's
owners where the driver can't say, a setting back to the server's own value. **For real** on Windows and macOS:
`.github/workflows/voice-local.yml` installs each engine environment from that platform's lock and makes it speak and
hear through the service (`backend/tools/voice_smoke.py`; those runners have no NVIDIA GPU, so the CPU there — or
Metal on the Mac when the runner offers it). The same script runs on any machine:
`python tools/voice_smoke.py --home /tmp/voice-smoke --model omnivoice --model whisper-large-v3-turbo`.

`backend/tests/test_voice_studio.py` (the same stand-in engine): generate and the history (search, ★, limits, ★ kept),
save as a clip, duplicate and trim, the feelings' chains, settings, the overview's attribution (ours / others /
unseen), batch input, a batch run → ZIP → retry, an interrupted batch resumed, the analysis, a too-short upload refused.

`backend/tests/test_nonverbal.py`: the sounds people write found and words left alone, tags, each engine's rendering
(and no engine reading another's tags), a line in parts, a built-in voice's laugh put in (and read as written when
asked), a profile's laughs made / kept / used / forgotten, made by themselves the first time a line laughs, a line's
laugh its own model's in its voice (VoxCPM2's own once made, Qwen3-TTS a built-in voice's; recorded ones first), the routes,
ElevenLabs' audio tags for a mate. The measurements above: `backend/tools/nonverbal_bench.py` on a real GPU.

`backend/tests/test_voice_training.py` (the stand-in run in its own process, the stand-in engine): recordings cut at
their pauses, how long a run trains, the server's word (pause, resume, release, stop), a run from upload to the adapter
on the profile (the profile and its lines marked, off and on, another revision's adapter not used, removed), every
installed model learning from the same recordings heard once (a run each, one group — VoxCPM2 among them —, each
model speaking with its own adapter, a newer run put on instead, a model that doesn't learn refused), VoxCPM2 a model
like the others (its engine, runtime, strategy, GPU budget, place in the defaults; every repository pinned), the
shipped adapters listed whole (each made from the revision the catalog installs), an OmniVoice adapter from before kept on, a
new profile's clip, what is refused, a mate's words pausing a run and a model sending it away (and back from its step),
the GPU queue's word, a runtime from an older lock brought up to date in place, how far a fetch is. In a browser (the
stand-ins): `desktop/test/e2e/voice-training-browser.js` — the page without a model that learns, a new profile from a
picked recording, the models (all ticked, one unticked), the licenses, a run per model to done, the reports and
samples, a LoRA chip for both models in 프로필 and `· LoRA` in 생성 / 히스토리, one off and on (the other stays), deleting one, CosyVoice3
alone (no "none"), en / ko, a phone. On the GPU: each recipe through `python -m app.voicehost.train` and each engine
switching adapters per line (the measurements above).

`backend/tests/test_voicehost.py` (no GPU, no downloads: `VOICE_ENGINE_MODE=fake` and a stand-in engine in a real
worker process): the gate for each refusal, the license before any download, disk room, placement (LRU, pinned, other
programs), the socket worker speaking and hearing, the priority queue, the built-in voices' clips, the user's voices,
and a mate on the local engine — speech, cache, fallback to the browser, a removed model, transcription, her call's
plan.
