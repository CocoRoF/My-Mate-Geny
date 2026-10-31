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
| Built-in mates **Estelle, Chaerin, Seoa** — persona text, cover/still images (`.webp`), idle/reaction video clips (`.mp4`), rig files | `backend/app/mate/builtin/mates/{estelle,chaerin,seoa}.json`, `backend/app/mate/builtin/assets/{estelle,chaerin,seoa}/` (~39 MB) | CocoRoF / Ailism — **all rights reserved**, no licence granted by this repository | Produced for the Ailism mate apps. Images/videos/voices were AI-generated with third-party services (e.g. Higgsfield); their output terms apply to the owner, not to downstream users. Forks must not reuse these characters without the owner's permission. |
| Chaerin's reference voice clip | `backend/app/mate/builtin/voices/chaerin/ref.wav` | CocoRoF / Ailism — all rights reserved | Synthetic voice (Higgsfield Seed Audio, per `voice.json`), not a recording of a real person. Estelle/Seoa only carry OmniVoice voice-design prompts. |
| Live2D sample model **Niziiro Mao (PRO)** | `backend/app/mate/builtin/assets/mao/` (`runtime/*.moc3`, textures, motions, expressions, `ReadMe.txt`) | Live2D Inc. — [Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) + [Terms of Use for Live2D Cubism Sample Data](https://www.live2d.com/eula/live2d-sample-model-terms_en.html) | See section 1.1. |
| **Geny logo** (hooded girl with headphones + "Geny" lettering) and every icon generated from it — favicons, PWA/maskable icons, in-app logo, desktop and Android app icons | master `assets/geny-logo.png`; generated into `assets/`, `frontend/public/`, `desktop/build/`, `mobile/assets/` (+ Android `mipmap-*`) by `scripts/make-icons.py` | CocoRoF — project artwork, **all rights reserved** unless the owner states otherwise | Same owner decision as the characters. Forks should rebrand: replace the master (square, transparent PNG) and run `python3 scripts/make-icons.py`. |

### 1.1 Live2D sample model (Mao) — obligations

Mao is a *Live2D Original Character*. Using it requires accepting both the Free
Material License Agreement and the Sample Data Terms of Use. In summary (read
the originals; the Japanese text prevails):

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
- **Redistribution:** the agreement forbids redistributing "all or part of the
  Material to third parties" (art. 4.1.1; "Redistribute" includes putting
  copies on an internet-accessible server), while allowing use, alteration and
  distribution of *works* made with Original Characters. Shipping the raw
  model files inside a public repository is therefore at best a grey zone.
- **Prohibited:** use with middleware competing with Live2D, content Live2D
  deems sexual/violent/discriminatory/political, implying the work is official
  Live2D content, selling/distributing models derived from the material.

The model was taken from the owner's Geny project
(`backend/static/live2d-models/mao_pro`); `live2d.json` and our copy of
`mao_pro.model3.json` add motion-group names (an alteration).

### 1.2 Not bundled (downloaded or installed separately)

| Component | How it gets there | Licence |
|---|---|---|
| **Live2D Cubism Core** (`live2dcubismcore.min.js`) | Downloaded by the server from `cubism.live2d.com` only after the user ticks the licence checkbox in Mate settings; stored under `~/.hr-harnessor/mates/_runtime/` | Live2D Proprietary Software License Agreement — never commit it |
| **Claude Code CLI** (`@anthropic-ai/claude-code`) | `npm install -g` in the Dockerfile, or installed by the user | Anthropic commercial terms. Building an image is fine; **publishing a prebuilt image** redistributes it — check Anthropic's terms first |
| **OpenAI Codex CLI** (`@openai/codex`) | `npm install -g` in the Dockerfile | Apache-2.0 |
| **OmniVoice** TTS service + model weights | Separate service ([geny-audio-services](https://github.com/CocoRoF/geny-audio-services)), reached over HTTP (`omnivoice_url`) | Service code: Apache-2.0. Model weights: non-commercial licence (CC BY-NC per upstream model card) — users running it are bound by it |
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

## 4. Publishing checklist (content)

1. Decide whether Estelle / Chaerin / Seoa ship in the public repo at all.
   If yes, state their licence explicitly (e.g. "all rights reserved, for use
   with My Mate Geny only" or a CC licence) in this file and in
   `backend/app/mate/builtin/`. If no, remove them before the first public
   commit (they are also in git history, see the release notes of the audit).
2. Decide on Mao: keep it (accepting the redistribution grey zone, keeping the
   credit line visible in the UI/README), or drop the files and let users
   download the model from Live2D and import it (Mate settings > Avatar >
   import zip / server folder).
3. Decide the licence of the Geny logo/icons (all rights reserved = forks
   must rebrand; or a permissive licence / trademark-style usage policy).
4. Never commit `live2dcubismcore*.js`, OmniVoice weights, or a Docker image
   containing Claude Code to a public registry without checking their terms.
