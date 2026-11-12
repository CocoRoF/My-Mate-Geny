# Third-party notices

My Mate Geny's own source code is licensed under Apache-2.0 (see `LICENSE`,
`NOTICE`). This file lists what the repository bundles, what it downloads or
installs at build/run time, and what it only talks to. Bundled **content**
(characters, models, voices) is not covered by the Apache License.

Status of this inventory: 2026-10-31. Licences of dependencies were read from
the lockfiles / installed package metadata; re-check before each release.

## 1. Bundled content

| Content | Path | Owner / licence | Notes |
|---|---|---|---|
| Built-in mates **Chaerin** and **Seoa** — persona and life text, cover/still images (`.webp`), idle/reaction video clips (`.mp4`), place art, rig files | `backend/app/mate/builtin/{mates,personas,life}/{chaerin,seoa}*.json`, `backend/app/mate/builtin/assets/{chaerin,seoa}/` | CocoRoF / Ailism — **all rights reserved**, no licence granted by this repository | Produced for the Ailism mate apps. Images/videos/voices were AI-generated with third-party services (e.g. Higgsfield); their output terms apply to the owner, not to downstream users. Forks must not reuse these characters without the owner's permission. |
| Chaerin's reference voice clip | `backend/app/mate/builtin/voices/chaerin/ref.wav` | CocoRoF / Ailism — all rights reserved | Synthetic voice (Higgsfield Seed Audio, per `voice.json`), not a recording of a real person. Seoa's voice is an ElevenLabs voice id in her `mates/seoa.json` (no audio in the repository). |
| Anime face detector `lbpcascade_animeface.xml` (finds the face for Avatar Create's expression stills) | `backend/app/avatar/lbpcascade_animeface.xml` | © 2011 nagadomi — **MIT** (the licence text is at the top of the file) | Used unchanged, as the ailism mate pipeline did. |
| **Geny logo** (hooded girl with headphones + "Geny" lettering) and every icon generated from it — favicons, PWA/maskable icons, in-app logo, desktop and Android app icons | master `assets/geny-logo.png`; generated into `assets/`, `frontend/public/`, `desktop/build/`, `mobile/assets/` (+ Android `mipmap-*`) by `scripts/make-icons.py` | CocoRoF — project artwork, **all rights reserved** unless the owner states otherwise | Same owner decision as the characters. Forks should rebrand: replace the master (square, transparent PNG) and run `python3 scripts/make-icons.py`. |

### 1.1 Live2D sample models (e.g. Mao) — not bundled, obligations when you import one

The repository does **not** contain any Live2D sample model: the Free Material
License forbids redistributing "all or part of the Material to third parties"
(art. 4.1.1; "Redistribute" includes putting copies on an internet-accessible
server). Earlier development snapshots carried *Niziiro Mao (PRO)*; it is no
longer part of the source tree, and its paths stay gitignored
(`backend/app/mate/builtin/assets/mao/`, `mates/mao.json`, `personas/mao.json`)
for installs that keep a local copy.

Users who download a sample model from
[Live2D's sample page](https://www.live2d.com/en/learn/sample/) and import it
(Mate settings → Avatar → Import, see [docs/mate.md](docs/mate.md#using-live2ds-free-sample-models))
accept the [Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)
and the [Terms of Use for Live2D Cubism Sample Data](https://www.live2d.com/eula/live2d-sample-model-terms_en.html)
themselves. In summary (read the originals; the Japanese text prevails):

- **Who may use it commercially:** "General Users" (individuals, groups) and
  "Small-Scale Enterprises" (latest annual sales under 10 million JPY, not
  controlled by a larger company). Larger organisations may use it only for
  internal / supervision purposes.
- **Credit:** works that use it must show the notice
  *"This content uses sample data owned and copyrighted by Live2D Inc."*
  (long form adds: *"The sample data are utilized in accordance with terms and
  conditions set by Live2D Inc."* and *"This content itself is created at the
  author's sole discretion."*). Do not remove or change `ReadMe.txt` or other
  copyright notices.
- **Redistribution:** don't redistribute the model files (e.g. by committing
  them to a public fork or shipping them inside an app); use, alteration and
  distribution of *works* made with Original Characters are allowed.
- **Prohibited:** use with middleware competing with Live2D, content Live2D
  deems sexual/violent/discriminatory/political, implying the work is official
  Live2D content, selling/distributing models derived from the material.

### 1.2 LivLiv models — not bundled, obligations when you import one

LivLiv Player (above) plays `.livliv` packages (LivLiv's own format, not Live2D: it reads no
`.moc3` and uses no Cubism SDK). The repository contains **no** LivLiv model: LivLiv's featured
characters are free for non-commercial use only and may not be used to train AI or make other
characters ([their licence](https://github.com/livliv-dev/player/blob/main/characters/LICENSE.md)),
so they are not shipped. A user who imports a package (Mate settings → Avatar → Import) uses it
under that package's own licence, shown there from its `meta.license` (packages made on
livliv.ai: [livliv.ai/terms](https://livliv.ai/terms)). The player draws the mark a package asks
for (`meta.watermark`, part of its licence) and the app never hides it. "LivLiv" and its logos are
LivLiv's; this project is not affiliated with LivLiv or with Live2D Inc. ("Live2D" is a trademark
of Live2D Inc.).

### 1.3 Not bundled (downloaded or installed separately)

| Component | How it gets there | Licence |
|---|---|---|
| **Live2D sample models** (Mao, Hiyori, …) | Downloaded by the user from [live2d.com](https://www.live2d.com/en/learn/sample/) and imported into a mate (stored under `~/.hr-harnessor/mates/<id>/assets/`) | Live2D Free Material License + Sample Data Terms (section 1.1) — never commit them |
| **LivLiv models** (`.livliv`) | Made by the user (e.g. on livliv.ai) and imported into a mate (stored under `~/.hr-harnessor/mates/<id>/assets/lv-*/`) | Each package's own licence (section 1.2) — never commit them |
| **Live2D Cubism Core** (`live2dcubismcore.min.js`) | Downloaded by the server from `cubism.live2d.com` only after the user ticks the licence checkbox in Mate settings; stored under `~/.hr-harnessor/mates/_runtime/` | Live2D Proprietary Software License Agreement — never commit it |
| **Claude Code CLI** (`@anthropic-ai/claude-code`) | `npm install -g` in the Dockerfile, or installed by the user | Anthropic commercial terms. Building an image is fine; **publishing a prebuilt image** redistributes it — check Anthropic's terms first |
| **OpenAI Codex CLI** (`@openai/codex`) | `npm install -g` in the Dockerfile | Apache-2.0 |
| **OmniVoice** TTS service + model weights | Separate service ([geny-audio-services](https://github.com/CocoRoF/geny-audio-services)), reached over HTTP (`omnivoice_url`) | Service code: Apache-2.0. Model weights: non-commercial licence (CC BY-NC per upstream model card) — users running it are bound by it |
| **Avatar Create processing venv** (numpy, SciPy, `opencv-python-headless` <5, Pillow, `imageio-ffmpeg`) | Installed by the server on the user's request (Avatar Create → Install) into `~/.hr-harnessor/avatar-venv/` from PyPI | BSD-3 (numpy, SciPy), Apache-2.0 (OpenCV), MIT-CMU (Pillow), BSD-2 (imageio-ffmpeg; its bundled **ffmpeg build is GPL** — run as a separate program, not linked) |
| Whisper STT / other HTTP TTS | Optional services the user points the mate at | Their own licences |
| Google Fonts (Inter, JetBrains Mono, Noto Sans KR) | Loaded by the browser from `fonts.googleapis.com` | SIL Open Font License 1.1 (browser fetch also discloses the visitor's IP to Google) |

## 2. Services the app talks to

Anthropic (Claude OAuth, `claude.ai`, `platform.claude.com`), OpenAI
(Codex device login, optional TTS/STT API), ElevenLabs (optional TTS),
GitHub (git remotes, release downloads for the Download page), Live2D
(Cubism Core download). Their terms apply to the accounts users connect.

## 3. Dependencies

### Backend (Python, `backend/pyproject.toml`)

| Package | Licence |
|---|---|
| fastapi, pydantic, pydantic-settings, pydantic-core | MIT |
| uvicorn, starlette, websockets, python-dotenv, httpx (dev) | BSD-3-Clause |
| cryptography | Apache-2.0 OR BSD-3-Clause |
| python-multipart, pytest-asyncio (dev) | Apache-2.0 |
| Pillow | MIT-CMU (HPND) |
| **asyncssh** | **EPL-2.0 OR GPL-2.0-or-later** — weak copyleft; used unmodified as a dependency, compatible with distributing this project under Apache-2.0. Modifications to asyncssh itself would have to be published under EPL-2.0 |
| pytest, ruff (dev) | MIT |

Transitive: MIT / BSD / Apache / PSF / MIT-0 only.

### Web console (`frontend/package-lock.json`, 381 packages)

MIT 354, ISC 13, Apache-2.0 7, BSD-3-Clause 4, CC-BY-4.0 1 (caniuse-lite
data, build-time only), `MIT OR GPL-3.0-or-later` 1 (jszip — used under MIT),
`MIT AND Zlib` 1 (pako).

Direct runtime dependencies: react, react-dom, react-markdown, remark-gfm,
zustand, react-icons, lowlight, hast-util-to-text, unist-util-visit,
qrcode-generator, pixi.js 7, pixi-live2d-display (MIT) — all MIT;
**@livliv-dev/player** 0.3.0 (LivLiv Player, **Apache-2.0**, © 2026 LivLiv; its NOTICE:
*"This product includes software developed by LivLiv (https://livliv.ai)."*; lazy-loaded
only for a LivLiv mate);
highlight.js (BSD-3-Clause); pdfjs-dist, docx-preview (Apache-2.0); **xlsx**
0.20.3 (SheetJS Community Edition, Apache-2.0) vendored as
`frontend/vendor/xlsx-0.20.3.tgz` because SheetJS no longer publishes to npm.
pixi-live2d-display needs the proprietary Cubism Core at runtime (above).

### Desktop app (`desktop/package-lock.json`, 417 packages, all dev/build-time)

electron, electron-builder (MIT). Transitive: MIT / ISC / Apache-2.0 /
BlueOak-1.0.0 / BSD / Python-2.0; `truncate-utf8-bytes` is WTFPL (permissive).
Electron binaries ship Chromium's own third-party notices inside the built app.

### Android app (`mobile/package-lock.json`, 225 packages)

Capacitor 8 (MIT). Transitive: MIT / ISC / Apache-2.0 / BlueOak / BSD / 0BSD
/ Unlicense; `@trapezedev/*` ("SEE LICENSE", dev-only tooling of
@capacitor/assets). The Android project pulls AndroidX / Google libraries via
Gradle (Apache-2.0).

## 4. Notes for forks and redistributors

1. The built-in characters (Han Chaerin, Seoa) and the Geny logo are
   **all rights reserved**: they are in this repository so My Mate Geny works
   out of the box, not under the Apache License. A fork that publishes its own
   builds should remove or replace them (`backend/app/mate/builtin/`,
   `assets/geny-logo.png` + `python3 scripts/make-icons.py`) unless the owner
   agreed.
2. Never commit `live2dcubismcore*.js`, Live2D sample models, OmniVoice
   weights, or push a Docker image containing Claude Code to a public registry
   without checking their terms.
3. Re-check the dependency licences (section 3) before each release.
