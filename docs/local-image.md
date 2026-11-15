# Local image models (this machine's own GPU)

My Mate Geny runs picture and clip models on the GPU of the machine it runs on — a server or the computer of a desktop
install. It is part of the app (`backend/app/imagehost`), next to the [voice models](local-voice.md):

- **Image Studio** (Settings → **로컬 모델 호스팅** → **Image Studio**) is where it is set up. It shows the engine and the
  GPU, downloads the models, lets the user try each recipe by hand, keeps every result, and holds the settings
  ([below](#image-studio)).
- The **avatar maker** is where the models are used. Each stage of making an avatar can run on this computer for
  0 credits instead of on Higgsfield; the user chooses per stage on the estimate ([below](#the-avatar-maker)).

As with voice, the app provides the framework that runs the models: the engine, its locked environment, the installer,
the graphs, the finishing and the GPU sharing. **No model weights are shipped.** Each model is downloaded by the user
from where its authors publish it, after reading and accepting its license in the model's card. The card shows the
license, what it allows, the model page, and every file with its repository and pinned revision.

## Who can run it

The engine is [ComfyUI](https://github.com/Comfy-Org/ComfyUI) 0.45.0 (GPL-3.0). It is fetched from upstream at a pinned
commit and run as a program of its own, spoken to over HTTP and WebSocket on `127.0.0.1`. It is never copied into this
repository nor imported by the server. Its Python environment is torch 2.14.1:

| Platform | GPU | Lock file (`app/imagehost/runtimes/`) |
|---|---|---|
| Linux x86-64 | NVIDIA, CUDA 13.0: driver **580+**, compute capability **7.5+** (Turing … Blackwell), 8 GB+ | `comfy.txt` (the environment the recipes were measured in, on an RTX 5070 12 GB) |
| Windows x86-64 | the same | `comfy.windows-x86_64.txt`: the same pins without the Linux-only CUDA wheels, plus `colorama` (resolved with uv for `win_amd64`) |
| macOS 14+ on Apple Silicon | the Mac's GPU through Metal, 16 GB+ unified memory | `comfy.macos-arm64.txt`: the same pins with PyPI's torch (resolved for `macosx_14_0_arm64`) |

Why CUDA 13.0 when voice uses 12.8: torch 2.14.1 is published for CUDA 12.6 and 13.0 only, and only the 13.0 build has
Blackwell (RTX 50) kernels.

`app/imagehost/gate.py` refuses an unsuitable machine up front. The models are still listed, but their buttons say why
they can't be used. The codes are `no_gpu`, `gpu_not_passed`, `old_driver`, `old_gpu`, `small_gpu`, `old_os`,
`platform` and `python`.

`IMAGE_ENGINE_MODE` sets how the engine runs:
- `real` (default): runs ComfyUI.
- `fake`: draws plain pictures and frames on the CPU through the same finishing steps (tests and the E2E).
- `off`: switches local image models off.

## Models

`app/imagehost/catalog.py` describes each model. Every file in it has:
- its repository, its pinned revision and its exact byte size;
- the ComfyUI model folder it goes into;
- its role in the graph: `model`, `text_encoder`, `vae`, `lora`, `remover`, …

Memory and time are measured, not guessed ([Measured](#measured)).

| Model | Use | License | Download |
|---|---|---|---|
| Anima Turbo 1.1 (`anima-turbo`) | drafts: anime / illustration characters from words, 10 steps | CircleStone Labs Non-Commercial (+ NVIDIA Open Model License): **the weights are non-commercial, the pictures may be used commercially** | 5.6 GB |
| Anima 1.0 (`anima-base`) | the same, 30 steps, more range | the same | 5.6 GB |
| FLUX.2 [klein] 4B (`flux2-klein-4b`) | changing a picture by words: an expression, clothes, a prop; several reference pictures | Apache-2.0 | 12.5 GB |
| Wan 2.2 Fun InP 5B (`wan22-fun-5b`) | loops: a clip that starts and ends on the base picture | Apache-2.0 | 18.1 GB |
| Lucida (`lucida`), BiRefNet (`birefnet`) | background removal, for pictures and for every frame of a clip | MIT | 0.9 / 0.4 GB |

Files shared by several models (Anima's text encoder and VAE) are downloaded once. Removing a model keeps the files
another installed model still needs.

Considered and left out:
- **Ailism Studio's models.** Qwen-Image 2.1 is research-only. MiniMax H3's license excludes Korea. We don't use Gemma.
- **Wan 2.2 I2V A14B with the Lightning 4-step LoRAs** (Apache-2.0). It works on 12 GB only by streaming two 14.3 GB
  experts from disk at every step. On the test machine (HDD, 13 GB memory cap) it was still loading after 35 minutes,
  with I/O pressure at 70%. It needs NVMe and 32 GB+ of free RAM. It may come back as an option for such machines
  (미확인).

### Installing

1. **The user accepts the license** in the model's card. The license, its URL and the time are kept
   (`image_licenses`). No license, no download.
2. **The engine, with the first model:**
   - ComfyUI's source: `codeload.github.com/Comfy-Org/ComfyUI/tar.gz/<commit>`, unpacked without links or `..` paths,
     with an `UPSTREAM.json` naming its repository, commit and license.
   - A venv made with uv from the backend's own CPython 3.12, filled from this platform's lock with `--no-deps`. Torch
     comes from the PyTorch CUDA 13.0 index when the lock pins a `+cu130` build.
   - The environment's marker is the hash of the lock and the commit: a new lock re-installs the environment.
   - About 6.5 GB.
3. **The weights:** one file at a time, each in a child process (`huggingface_hub`, the pinned revision). A transfer
   with no progress for 90 s is killed and retried, up to 5 times. Each file is moved into its ComfyUI folder only when
   complete. A model counts as installed when every file is there at its exact size.
4. Disk is checked first (2 GB kept free). Install runs one at a time. Cancel stops the running process.

The lock leaves out ComfyUI's workflow-template and embedded-docs packages (about 650 MB). The API never serves them;
ComfyUI logs that they are missing and runs.

## How it runs

- **One process, started for a job.** ComfyUI starts on a free port on `127.0.0.1` when a job needs it. It stops after
  `IMAGE_IDLE_STOP_SECONDS` (default 120 s, Image Studio → 설정) without a job, so its GPU memory goes back.
  - Its model folders are ours, through `extra_model_paths.yaml`; its input and output folders are under
    `<image home>/work`.
  - Flags: `--disable-pinned-memory` (pinned buffers of 1 GB+ have broken CUDA on the test machine) and
    `--reserve-vram`, worked out at each start (next item).
  - **Room for speech.** While the engine runs, it leaves this much of the GPU to the voice models: its own 1 GB, plus
    the models a phone call holds, plus the default speech model (`VoiceHost.room_for_speech`). So a mate can still
    speak while a clip is made. ComfyUI offloads what doesn't fit, which makes a big job slower but keeps it running.
    Image Studio → 설정 → 음성 모델에 남겨 둘 자리 can set a fixed amount instead (0–6 GB).
  - `TORCH_DISABLE_NATIVE_JIT=1`: torch 2.14's own Triton kernels compile a C stub on first use with the machine's gcc
    and Python headers. Most machines lack those headers, and the job fails.
- **It dies with the backend.**
  - On Linux the child asks for `SIGTERM` when its parent dies (`PR_SET_PDEATHSIG`). Measured: the backend killed with
    `SIGKILL` takes ComfyUI with it.
  - A pid file lets the next start stop one that a crash left behind, after checking that it is ours (`main.py` in our
    ComfyUI folder).
- **One job at a time.** Jobs queue in the image host. Progress (step, n / m) comes over ComfyUI's WebSocket, and the
  result is read from `/history`.
  - Each job is recorded in `image_jobs`: what was asked, the model, for whom, how long it took, what it made.
  - Its files are in `<image home>/history/<job id>/`, inputs as `in-*`.
  - A restart marks unfinished jobs failed; their caller asks again.
- **Sharing the GPU with the voice models:**
  - Before a job, idle voice models step aside until the job's measured peak, less the room for speech, is free:
    parked when the host has RAM for them, else stopped. A model a phone call holds stays.
  - When a voice model can't fit, it asks the image engine to stop if it is idle.

  (`EngineManager.make_room_for`, `EngineManager.others`, `ImageHost.release_gpu`.)

## Recipes

The graphs are in `app/imagehost/graphs.py`. They are pure, use only ComfyUI's core nodes, and are built from each
official template's settings.

| Kind | Graph | Finishing (`media.py`) |
|---|---|---|
| `draft` | Anima: text encoder through `CLIPLoader` type `stable_diffusion`. The model card's prefix (`masterpiece, best quality, score_7, safe,`) and negative. `er_sde` sampler; Turbo 10 steps CFG 1, base 30 steps CFG 5 | none |
| `edit` | FLUX.2 Klein (distilled): the picture scaled to about 1 MP is the `ReferenceLatent` of both the prompt and the empty negative. Up to 3 more pictures are chained on as references. 4 steps, CFG 1, euler | **colour match**: the edit at the original's size, its colours fitted per channel to the original's where the edit left it alone. Without it, the face put back by the avatar's stills step would show a darker patch |
| `loop` | Wan 2.2 Fun InP 5B, `WanFunInpaintToVideo` with the base picture first and last. Shift 8, 20 steps, CFG 6, `uni_pc`, 24 fps, 4k+1 frames. **Frames saved as pictures** | **the loop** (below) |
| `cutout` | `LoadBackgroundRemovalModel` → `RemoveBackground` → the mask | the cut-out: the picture with the mask as its alpha (only the alpha comes from the model) |
| `matte` | `LoadVideo` → `GetVideoComponents` → `RemoveBackground` on every frame | the subject on black, the same file a hosted video background remover returns |

### Loops

A clip the avatar plays starts and ends on the base picture, so its seam must be exact:

- **Colours.** Wan's decoder comes out a few levels darker: frame 1 against the base differs by 9.9 on average, and by
  2.45 after a per-channel fit. The fit of the first frame and the fit of the last are measured against the base. Every
  frame gets the fit blended between those two by its place in the clip.
- **The ends.**
  - The first and last frames *are* the base picture, at the clip's full resolution.
  - The 3 frames next to each end are eased into it (75 %, 50 %, 25 % base), at full resolution, so the switch from
    the sharp picture to the model's frames is a fade, not a jump.
  - Measured on the test loop: the frame next to each end differs from the base by 3.2.
- **A crop.** The model can see only a crop of the picture (`box`): the character with 12 % of her size around her. The
  avatar maker passes the box from where it placed her.
  - That puts more of the model's pixels on her. The size is a pixel budget (640 × 640 by default, the measured cost),
    spent in the crop's own shape. A tall crop of her gets 528 × 784 instead of a 432 × 640 slice of a square.
  - Its frames go back into the whole picture with a soft edge, so the flat gray around her hides it.
- The clip is encoded as H.264 at CRF 12 (PyAV in the engine's environment, else ffmpeg) at the base picture's size.

`media.py` runs as a script with the engine environment's Python (`python -I media.py <cmd> <json>`). It never imports
the app, and the server process stays light.

## Image Studio

| Page | What |
|---|---|
| 개요 | the engine (running, idle, stopped; the GPU memory it holds; stop now), the job running with its progress and those waiting, what the avatar maker can run here stage by stage (and which model), the latest results |
| 모델 | the engine card; each model by use: measured GPU / RAM / time, the license (summary, commercial use, attribution, links, every file with its repository@revision), accept → download with progress and log, remove, "use for …" |
| 시험 | each recipe by hand, with the settings the avatar maker uses: a draft from words (size, count, seed), a picture changed by words (+ reference pictures), a loop from a picture (length), a cut-out. A result goes straight on as the next step's input (draft → change it → animate it → cut it out) |
| 기록 | every result, made here or for the avatar maker (`avatar:<project>`): filter by kind, source, star; open one (all its files, what it was made from, the words, the time); download, star, delete, use as the next input |
| 설정 | the model each use takes; each recipe's knobs; where each avatar stage starts (this computer / Higgsfield); the idle time; the room left for the voice models; how many results the history keeps; the paths |

The page is in the address (`/?view=settings&tab=image-studio&page=history`). The server pushes `image.changed` on
`/ws/sessions` whenever a job moves or a model changes; the studio refetches once per burst.

## The avatar maker

`app/avatar/local.py` maps each stage to an image job. Every stage makes the very file the hosted job would have made,
so the processing after it (`pipeline.py`), the checks and the export are unchanged.

| Stage | Plan line | Image job | File |
|---|---|---|---|
| design | `local:design` | `draft` (Anima: the hosted prompt behind Anima's framing tags `1girl, solo, upper body, looking at viewer, simple background, grey background`, 864×1152). With a reference picture (redraw, outfit, a candidate changed): `edit` (Klein, the pictures as references) | `design/c<n>.png` |
| home | `local:cutout` | `cutout` of `candidate.cutin.jpg` | `masters/candidate.cut.png` |
| stills | `local:edit` | `edit` of `candidate.ref.jpg` with the hosted face prompt, colours matched | `stills/<name>.raw.png` |
| clips | `local:loop` | `loop` of `home-gray.jpg`, the crop from `place.json`, the clip's own length | `clips/<id>.mp4` |
| matte | `local:matte` | `matte` of the clip | `clips/<id>.nobg.mp4` |

**The estimate.**
- Image Studio → 설정 says where each stage starts. A stage starts local only when its model is installed now (a
  design with reference pictures needs the edit model).
- On the estimate card the user can switch any stage that can run here: `POST /api/avatar/projects/{id}/engines`. A
  new estimate follows, and the plan changes.
- A local line costs 0 credits and is never quoted. Its time comes from the measured minutes, one job at a time, plus
  reading the model once.
- A plan with no hosted line needs no Higgsfield account, and its quotes never go stale.
- Confirm refuses a local stage that can no longer run here (`local_unavailable`) before anything starts.

**Running.**
- Local jobs pass the same spending gate (at 0 credits) and are recorded and retried like hosted ones.
- One GPU runs one job at a time. An item whose image job is still waiting behind another is shown on the canvas as
  waiting, not running (`gpu_queued` in the project's view).
- The job's id is kept in the item, so a restart waits for it or tries again.
- A job refused for good (no model, no GPU) is not retried. A job the GPU ran out of memory for is reported, not
  retried.

## Settings and files

- `IMAGE_HOME` (default `<app home>/image`) holds:
  - `models/<folder>/` (`IMAGE_MODELS_DIR`);
  - `engine/` (ComfyUI and its venv);
  - `work/` (ComfyUI's input and output);
  - `history/<job id>/`;
  - `tmp/`.

  Keep the models on a fast disk: a model is read whenever the engine starts. On the HDD of the test machine the first
  job took 88 s, the next ones 2.8 s.
- Other settings: `IMAGE_ENGINE_MODE`, `IMAGE_DEVICE`, `IMAGE_IDLE_STOP_SECONDS`, `IMAGE_HF_ENDPOINT`.

## API (`/api/image`, signed in)

| Route | |
|---|---|
| `GET /status?lang=ko` | the gate, the engine, the GPUs, RAM, disk, every model (catalog + install state, license accepted), the recipes (the model each uses now, their values), the queue, what the avatar maker can run here |
| `POST /models/{id}/install` `{accept_license}` · `POST /models/{id}/cancel` · `DELETE /models/{id}` | install, cancel, remove |
| `GET/PUT /settings` | `idle_stop_seconds`, `history_max_entries`, `voice_room_gb` (−1: automatic), `models` (use → model), `recipes` (recipe → values), `avatar` (stage → `local` / `higgsfield`) |
| `POST /engine/stop` | stop ComfyUI now |
| `POST /jobs` (multipart) | `kind`, `prompt`, `negative`, `params` (JSON), `model_id`, `image` / `end_image` / `clip` / `refs` as files, or `image_from` / `clip_from` / `refs_from` = `<job id>/<file>` |
| `GET /jobs?kind&source&starred&limit&offset` · `GET /jobs/{id}` · `POST /jobs/{id}/cancel` · `PATCH /jobs/{id}` `{starred}` · `POST /jobs/delete` `{ids}` · `GET /jobs/{id}/files/{name}?download=1` | the history |

## Measured

On the test machine: RTX 5070 12 GB, driver 580.159, models on an HDD (~180 MB/s), each run inside a 12–13 GB
memory cap. The numbers are the GPU's memory at its highest (nvidia-smi, sampled every 0.5 s) and ComfyUI's resident
memory at its highest.

| Recipe | Size | Time | GPU | RAM |
|---|---|---|---|---|
| Anima Turbo, draft | 768×1024, 10 steps | **2.8 s** (first: 88.6 s, reading the model) | 5.9 GB | 2.6 GB |
| Anima 1.0, draft | 768×1024, 30 steps | **14.8 s** (first: 87.3 s) | 6.0 GB | 2.6 GB |
| FLUX.2 Klein 4B, edit | 1024×1024, 4 steps | 59–82 s (first: 190 s) — the 8 GB text encoder and the model take turns on the card and, inside the cap, are re-read from disk | 11.0 GB | 2.7 GB |
| Wan 2.2 Fun InP 5B, loop | 640×640, 81 frames, 20 steps | **341 s** (the first step: 115 s, reading 17 GB) | 11.3 GB | 3.1 GB |
| Lucida / BiRefNet, cut-out | 1080×1080 | 15.6 s / 7.8 s (with loading) | 2.1 GB | 2.1 GB |
| Through the product's installer and `ImageHost`, from a cold engine | draft ×2 864×1152 · edit 1080² · cut-out · loop 93 frames on a 432×640 crop · its matte | 217 s · 138 s · 46 s · 374 s · 60 s (each includes reading its model from the HDD) | – | – |
| Loop finishing | 81 frames → 1080×1080 H.264 | 20 frames encoded in 1.7 s | – | 0.5 GB |

Quality, judged on the pictures:
- **Turbo drafts** keep the asked framing (waist-up, flat gray) and clothes.
- **Klein expressions** keep her identity and stay in place (best shift 0 px), so the face can be put back.
- **Wan loops** move naturally (a lean and a blink, back to the start). Her features soften and drift a little
  between frames at this resolution, which is why the crop and the pixel budget exist.
  - On the real loop the ends meet the base picture exactly: 0.4 at the ends, which is encoding loss; neighbouring
    frames differ by about 1 throughout.
  - The picture outside the crop is untouched (0.0), and the crop's edge band differs by 0.12.
  - Faint blotches the model leaves in the gray around her are taken away by the matte.
- **Both cut-outs** are clean on the hair and the hood (Lucida and BiRefNet differ by 0.3 levels on this picture).

## Not yet

- Windows and macOS: the locks resolve for their platforms, but the engine was not run on them (미확인).
- AMD / Intel GPUs: no locks.
- Wan 2.2 A14B as an option for machines with NVMe and 32 GB+ of free RAM (미확인).
- An upscaler for clips made below the canvas size.
- A face-only edit (crop → edit → paste) for higher detail in the expressions.

## Tests

- `backend/tests/test_imagehost.py`:
  - the gate (driver, GPU generation, memory);
  - the catalog (every model has the files its graph takes, a license and measurements; shared files agree);
  - the graphs' wiring;
  - the colour fit; a loop's ends being the base picture; the cut-out's alpha;
  - the license before a download; a file counting only at its exact size; shared files staying on removal;
  - every job kind through the stand-in engine into the history; cancel; a restart; the model a use takes and what the
    avatar maker sees;
  - the GPU hand-over both ways; the room the engine leaves for speech.
- `backend/tests/test_avatar_local.py`:
  - the plan with local stages (0 credits, no quotes, measured minutes, a mixed plan);
  - the draft prompt and the clip's crop;
  - a whole run with no Higgsfield at all (each stage's image job and the file it fills);
  - the engine per stage being the user's, but only where it can run, and refused at Confirm when it no longer can;
  - a failed local job being retried;
  - a local job waiting for the GPU being shown as waiting.
- On the test machine's GPU, a scratch script (not in the repo) ran the product's installer and every job kind through
  `ImageHost` ([Measured](#measured)).
