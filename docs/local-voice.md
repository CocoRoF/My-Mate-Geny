# Local voice models (this machine's own GPU)

My Mate Geny serves speech (TTS) and speech-recognition (STT) models on the NVIDIA GPU of the machine it runs on — a
server (`docker compose`, [deploy](deploy.md)) or the computer of a desktop install. It is part of the app
(`backend/app/voicehost`), not a separate service: Settings → **로컬 모델 호스팅** → **Voice Studio** shows the GPU and
who is using it, downloads and serves the models, builds voice profiles and makes lines with them ([below](#voice-studio));
a mate's Voice tab then offers the engine **로컬 (이 서버의 GPU)** for her voice and for hearing the user, and her
phone calls use it too.

What the app provides is the framework that serves the models: the engines' environments, the installer, the GPU
placement, the voices. **No model weights are shipped.** Each model is downloaded by the user from its authors' Hugging
Face repository, after reading and accepting its license in the model's card (the license, what it allows, what it
asks to be shown, the model page and the exact repositories are all there).

The design and much of the code come from [geny-audio-module](https://github.com/CocoRoF/geny-audio-module) (the test
bed of these engines, same author, Apache-2.0): the worker engines, the runtime lock files and the GPU placement were
copied and adapted into the app (THIRD-PARTY-NOTICES.md).

## Who can run it

The engines are torch 2.8 built for CUDA 12.8. Anything short of what they need is refused before a download starts —
the models list still shows what could be had, and the card says why not (`app/voicehost/gate.py`, checked in this
order, `GET /api/voice/status` → `gate.code`):

| Code | Refused when | |
|---|---|---|
| `off` | `VOICE_ENGINE_MODE=off` | switched off by the admin |
| `platform` | not Linux x86-64 | the lock files are for Linux (Windows needs its own: triton and friends; macOS has no CUDA) |
| `gpu_not_passed` | in a container that sees no NVIDIA device | the host has none, or it wasn't given to the container: [`deploy/docker-compose.gpu.yml`](../deploy/docker-compose.gpu.yml) |
| `no_gpu` | no NVIDIA GPU / `nvidia-smi` | |
| `old_driver` | driver < 570 | CUDA 12.8 |
| `old_gpu` | compute capability < 7.0 | the wheels carry sm_70 – sm_120 (Volta … Blackwell) |
| `small_gpu` | GPU memory < 4 GB | the smallest useful set (Whisper + OmniVoice) with headroom |
| `python` | the backend isn't CPython 3.12 | the engines' environments are made from its interpreter (the Docker image has 3.12; without Docker, run the backend on 3.12) |
| `packages` | the server lacks numpy, soundfile, soxr or huggingface_hub | part of the backend's dependencies; checked last, so a machine without a GPU says that |

Refused, every install / load / speak / transcribe answers 409 with the gate (`code`, `message`, the requirements);
the mate engine `local` is "not available" with that reason (her voice falls back to the browser's, below).

**In Docker** the image needs nothing more: give the container the GPU (NVIDIA Container Toolkit on the host) —
`docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d`. The engines and models then go into the
`geny-home` volume (`<data home>/voice`), so they survive rebuilds.

**Desktop**: the same code runs in the desktop app's local backend; on Linux with a suitable GPU it works as on a
server, on Windows and macOS the gate says `platform` for now.

## Models

`app/voicehost/catalog.py`. Sizes as downloaded; GPU memory as measured on an RTX 5070 (the card shows the estimate,
placement uses the measurement).

| Model | Kind | Engine (runtime) | Download | GPU | License |
|---|---|---|---|---|---|
| OmniVoice | TTS: cloning, voice design from a description, its own voice; 600+ languages | `omnivoice` (omni) | 3.3 GB | 2.4 GB | Apache-2.0 code; the audio tokenizer is under the Boson Higgs Audio 2 Community License (Llama 3 based: no training other LLMs on its output, a licence from Boson AI above 100k annual active users, "Built with Higgs Materials" attribution) |
| Qwen3-TTS 1.7B (Base) | TTS: cloning from ~3 s, 10 languages | `qwen3_tts` (qwen) | 4.5 GB | 4.8 GB | Apache-2.0 |
| Qwen3-TTS 0.6B (Base) | TTS: cloning, lighter | `qwen3_tts` (qwen) | 2.5 GB | 2.9 GB | Apache-2.0 |
| Fun-CosyVoice3 0.5B | TTS: cloning, other languages, instructions, tags in text | `cosyvoice3` (cosy) | 5.4 GB | 3.6 GB | Apache-2.0 (its source, fetched at install: CosyVoice Apache-2.0, Matcha-TTS MIT) |
| Whisper large-v3-turbo | STT | `whisper` (qwen) | 1.6 GB | 2.0 GB | MIT |

The default speaking model is the first installed of OmniVoice → Qwen3-TTS 1.7B → 0.6B → CosyVoice3; hearing is
Whisper.

### Installing

`POST /api/voice/models/{id}/install {accept_license: true}` — the license must be accepted first (recorded once per
model: `voice_licenses` — license, URL, when; a reinstall doesn't ask again). Then, in the background, with progress
on the card (`progress.state`):

1. **runtime** — the engine's Python environment, once per runtime (qwen serves Qwen3-TTS and Whisper): a venv made
   from the backend's own interpreter (CPython 3.12), filled with `uv` from the locked list
   (`app/voicehost/runtimes/{qwen,omni,cosy}.txt`, `--no-deps`, torch from the PyTorch CUDA 12.8 index). All runtimes
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
  lines, by day), `tmp/`. About 20 GB for all five models and their three runtimes.
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
  (`builtin:chaerin`) and **메스가키** (`builtin:seoa`), five clips each (8 – 12 s, 24 kHz mono, levelled to −20 dBFS;
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

## Voice Studio

Settings → 로컬 모델 호스팅 → **Voice Studio** (`frontend/src/components/voicestudio/`; the page is in the address,
`/?view=settings&tab=voice-studio&page=history`). Its pages:

| Page | What |
|---|---|
| 개요 | each GPU — load, temperature, power, clock, fan — and **whose its memory is**: this app's models (each worker's process, measured by the driver), other programs (`nvidia-smi --query-compute-apps`), and what no process here accounts for (the host's display, other containers); the last 30 minutes (sampled every 5 s while someone looks, else every 30 s); the models on the GPU (park, unload, load); the GPU queue — running, waiting, the last jobs and for whom; engine events; the machine's RAM and disk |
| 모델 | the gate, each model's card (license, install, load / unload, default model), its default parameters (what every line made with it starts from: a mate's, the studio's, a batch's), the engines' environments |
| 프로필 | the profiles (search, mine / built-in, ★), the eight clips (play, upload, record, trim, words and language), details (description, tags, default model and parameters, voice description), duplicate, delete |
| 생성 | a line: profile, model, mode (자동 / 복제 / 설계 — what the model and the profile allow), feeling (a dot where the profile has the clip), language, description presets, parameters, seed (random, or kept to make the same line again) → waveform, timings, download (WAV / MP3 / OGG / FLAC), ★, same seed again, save as a profile's clip |
| 일괄 생성 | text (a line each, `[joy] …`), CSV (`text` + any of `profile`, `feeling`, `seed`, `language`, `instruct`, `model`) or JSON, ≤ 500 lines, shared settings (a line's own columns win), one seed for all or one each; run at the lowest priority, one line at a time; progress, cancel, retry failed, resume one a restart stopped (`interrupted`), each line playable, a ZIP in a format with `manifest.json` |
| 히스토리 | every line made here with everything that made it: search, filter (profile, model, where from, ★), play, download, make again (opens 생성 with its settings and seed), save as a clip, delete (one or many). Over `history_max_entries` (2000) or `history_max_gb` (5) the oldest go first; ★ lines and batches' lines stay |
| 도구 | A/B comparison (one line, up to five settings, the same seed), seed search (one line, 2 – 12 seeds), a clip's analysis (format, level, silence, warnings, the best stretches → add one to a profile, its words and language), transcription |
| 설정 | GPU share, idle unload, parked time, parking RAM, history limits; the default speech / recognition model and the profile the studio starts with; paths and engine mode (from the environment) |

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
| `GET/PUT /settings` | the runtime values (`null`: back to the server's), `default_tts`, `default_stt`, `default_voice` |
| `POST /generate` `{text, model_id?, voice_id?, feeling?, mode?, language?, instruct?, params?, seed?, source?}` | a line, kept in the history → the entry (seed, timings, `info`) |
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
| Qwen3-TTS 0.6B | 0.33 | 2.9 GB |
| Qwen3-TTS 1.7B | 0.33 | 4.8 GB |
| CosyVoice3 0.5B | 0.5 | 3.6 GB |
| Whisper large-v3-turbo | ~0.1 s per line | 1.8 GB |

A model's first use loads it (OmniVoice ~8 – 10 s); warm, it is ready in 0.1 – 0.3 s. Every TTS model's lines in both
built-in voices were heard back by the local Whisper with a character error rate of 2 – 5 % (numbers written
differently). Installing everything from nothing: the first runtime with Whisper ~2 min, the others ~15 s each.
The same in a container given the GPU (`docker-compose.gpu.yml`, `python:3.12-slim` like the image): the gate passed,
OmniVoice spoke in 메스가키's joy clip at 0.18, and Whisper heard the line back word for word.

## Not yet

- **Windows / macOS** local mode (`platform`): needs per-OS lock files (Windows CUDA wheels; macOS would need MPS
  engines).
- **A GPU elsewhere**: a server without a GPU can't use another machine's GPU for these models yet (a remote voice
  node). Until then: run My Mate Geny on the GPU machine, or point the mate at an HTTP service (OmniVoice URL / Whisper
  URL in 이미지 및 음성 공급자 → 직접 호스팅한 음성 서비스).

## Tests

`backend/tests/test_voice_studio.py` (the same stand-in engine): generate and the history (search, ★, limits, ★ kept),
save as a clip, duplicate and trim, the feelings' chains, settings, the overview's attribution (ours / others /
unseen), batch input, a batch run → ZIP → retry, an interrupted batch resumed, the analysis, a too-short upload refused.

`backend/tests/test_voicehost.py` (no GPU, no downloads: `VOICE_ENGINE_MODE=fake` and a stand-in engine in a real
worker process): the gate for each refusal, the license before any download, disk room, placement (LRU, pinned, other
programs), the socket worker speaking and hearing, the priority queue, the built-in voices' clips, the user's voices,
and a mate on the local engine — speech, cache, fallback to the browser, a removed model, transcription, her call's
plan.
