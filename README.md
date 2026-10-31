<p align="center"><img src="assets/geny-logo.png" width="240" alt="Geny logo"></p>

<h1 align="center">My Mate Geny</h1>

<p align="center">
  A self-hosted console for coding agents (Claude Code, Codex) — with an avatar secretary who hands them the work.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="Python 3.11+" src="https://img.shields.io/badge/python-3.11%2B-3776AB">
  <img alt="React 18" src="https://img.shields.io/badge/react-18-61DAFB">
  <img alt="Docker" src="https://img.shields.io/badge/docker-compose-2496ED">
  <img alt="Apps" src="https://img.shields.io/badge/apps-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-555">
</p>

<p align="center"><a href="README_ko.md">한국어</a></p>

---

My Mate Geny turns the **Claude Code** and **Codex** CLIs into a chat service you run on
your own machine or server: open it in a browser, the desktop app or the Android app, start
chats in local or remote (SSH) folders, watch every tool call and file change, and let
several subscription accounts share the load. On top of the chats sits the **Mate** — an
avatar you talk to (video, photo or Live2D body, voice in and out) that delegates work to
those chats, follows up and reports back.

*(Formerly "hr-harnessor": some internal identifiers — the `~/.hr-harnessor` state
directory, cookie/storage keys, the app ids — keep that name so existing installs update in
place.)*

<!-- Screenshots: add docs/images/console.png, docs/images/mate.png, docs/images/desktop-mate.png -->
| Console | Mate | Desktop mate |
|---|---|---|
| _screenshot: chat + explorer_ | _screenshot: mate stage_ | _screenshot: desktop overlay_ |

## Features

- **Engines** — Claude Code (`claude`) and Codex (`codex`), switchable mid-chat with the
  conversation handed over. Claude runs as a persistent engine per chat (background tasks,
  follow-up turns, live interrupt / model / permission-mode changes); Codex runs one `exec`
  per turn. Both stream into one normalized event schema.
- **Workspaces** — a folder on the server, or a folder on a remote SSH host through an
  SSH-backed MCP bridge (`remote_bash/read/write/list`). Clone Git repos as workspaces.
  Extra folders per chat.
- **Agent UX** — prose and tool activity kept apart (folded tool groups, diffs, subagent
  nesting), exact per-turn file changes from git snapshots with diff viewer and undo,
  background-task panel, steering a running turn, queueing, `/` commands and `@` files,
  photo/file/clipboard attachments, notifications.
- **Explorer + viewers** — VS Code-style explorer (local or remote) and file tabs: code,
  markdown, CSV/TSV, Excel, Word, PowerPoint, PDF, notebooks, HTML (sandboxed),
  images/audio/video. Paths the agent prints open on click. The server's own credentials are
  never served.
- **Context & usage** — context meter, compaction dividers, "Compact now", configurable
  auto-compact window, per-chat cost and plan-usage views.
- **Accounts** — several Claude / Codex logins in a pool with plan-usage-aware balancing,
  sticky chats (prompt cache per account), cool-down on rate limits and automatic hand-over.
- **Operations** — admin console (error logs, system, security), revocable sessions,
  per-IP login bans.
- **Mate** — persona, memory, voice (browser, OpenAI, ElevenLabs, OmniVoice or any HTTP
  TTS; Whisper-compatible STT), video / photo / Live2D bodies with emotion tags and
  lip-sync, delegation to chats. On the desktop app it lives on your desktop (transparent
  always-on-top avatar, quick chat on **Ctrl/Cmd+Shift+G**).
- **Clients** — web console (desktop + mobile layouts), desktop app (Electron: Windows /
  macOS / Linux), Android app (Capacitor). The apps load your server's console, so UI
  updates reach them without a new build.

## Quick start (Docker)

Requirements: Docker with Compose v2.24+, ~3 GB disk for the image.

```bash
git clone <this repo> my-mate-geny && cd my-mate-geny
docker compose up -d
```

Open **http://localhost:8080** and sign in with **`admin` / `geny-admin`**. Change the
password right away in **Admin → Security** (see [docs/auth.md](docs/auth.md)).

Everything the server keeps (database, encrypted vault, account logins, mates, uploads,
cloned repos) lives in the `geny-home` Docker volume. Optional knobs (port, bind address,
uid, a host folder for workspaces) are in [.env.example](.env.example); copy it to `.env`.

### Connect Claude Code / Codex

The image already contains both CLIs. Log them in from the console — no terminal needed:

1. **Providers** → Claude → **Add account** → **Sign in**: open the link, approve, paste the
   code back. Add more accounts to pool them.
2. Add a **Codex** account → open the device link and enter the shown code (or save an
   OpenAI API key).

Alternatively reuse the logins of your host user: run `claude` / `codex login` on the host
once, then uncomment the `~/.claude`, `~/.claude.json`, `~/.codex` mounts in
[docker-compose.yml](docker-compose.yml).

### Pick folders to work in

Agents work in `/workspaces` inside the container. By default that is a Docker volume; to
work on host folders set `GENY_WORKSPACES=/path/to/projects` (and `GENY_UID`/`GENY_GID` to
the folder owner's `id -u` / `id -g`) in `.env`, then `docker compose up -d --build`.
Remote machines: **Connections** → add an SSH host (key stored encrypted).

Then start a chat: choose engine, workspace and folder, and talk.

### Set up the Mate

1. Open **Mate**. Built-in mates are ready to pick; or create your own (persona, greeting,
   language) and give it a body — video clips / photos (zip or server folder import) or a
   **Live2D** model.
2. **Live2D runtime**: Live2D bodies need the Cubism Core, which is not redistributable.
   In the Mate view's **Global settings → Live2D**, read and accept the Live2D licence; the server
   then downloads the Core from live2d.com once.
3. **Voice**: keys and service URLs go in **Global settings → Voice services**; each mate's
   **Voice** tab picks the TTS engine — `browser` (free, built in),
   `openai` or `elevenlabs` (API key, stored in the vault), `omnivoice` (self-hosted, see
   [geny-audio-services](https://github.com/CocoRoF/geny-audio-services); its model weights
   are non-commercial) or any `http` TTS — and optionally a Whisper-compatible STT URL for
   voice input.
4. Ask the mate to do something in a project; it opens or reuses a chat, delegates, and
   reports back.

Design and API: [docs/mate.md](docs/mate.md).

## Production deployment

Put HTTPS in front (Caddy / nginx examples) or use a Cloudflare tunnel:
[docs/deploy.md](docs/deploy.md) and [deploy/](deploy/). For a non-Docker run on a host,
`deploy/start-backend.sh` starts the backend as your user.

## Apps

- **Desktop** (`desktop/`, Electron) and **Android** (`mobile/`, Capacitor) are thin shells
  that load *your* server's console: on first launch enter your server URL. See
  [desktop/README.md](desktop/README.md) and [mobile/README.md](mobile/README.md).
- [.github/workflows/apps.yml](.github/workflows/apps.yml) builds Windows / macOS / Linux
  installers and a signed APK into a GitHub release; the console's **Download** page lists
  the release named by `APPS_REPO` / `APPS_RELEASE_TAG`.
- **Forks publishing their own apps**: change the app id (`appId` in
  `desktop/package.json`, `appId` in `mobile/capacitor.config.json`, `applicationId` /
  `namespace` in `mobile/android/app/build.gradle` and the Java package), set your own
  Android signing secrets (`HRH_KEYSTORE_B64`, `HRH_KEYSTORE_PASSWORD`, `HRH_KEY_ALIAS`,
  `HRH_KEY_PASSWORD`) and point `APPS_REPO` at your repo. The upstream id
  `me.hrletsgo.harnessor` is kept only so existing installs keep updating.

## Configuration

Every backend setting, with defaults and comments: [backend/.env.example](backend/.env.example)
(copy to `backend/.env`). Compose-level settings: [.env.example](.env.example) and
[deploy/.env.example](deploy/.env.example).

## Development

```bash
# backend (Python 3.11+)
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
cp .env.example .env                   # then edit (COOKIE_SECURE=false for http://localhost)
uvicorn app.main:app --reload --port 8080
pytest -q                              # tests

# web console (Node 22)
cd frontend
npm ci
npm run dev                            # http://localhost:5173, proxies /api + /ws to :8080
npx tsc -p . --noEmit                  # typecheck
```

You need `claude` and/or `codex` on `PATH` for real turns
(`npm i -g @anthropic-ai/claude-code @openai/codex`). The tests don't.

## Architecture

```
 Web console      Desktop app (Electron)      Android app (Capacitor)
        └──────────────────┬───────────────────────┘   REST + WebSocket (same origin)
                           ▼
        (HTTPS proxy / tunnel) → FastAPI backend — serves the console, API, WS, login
                           ├─ Engines       claude (persistent) | codex (per turn)
                           ├─ Accounts      pooled CLI logins, balancing
                           ├─ Workspaces    local | remote SSH (MCP bridge)
                           ├─ Changes       git snapshots per turn
                           ├─ Mate          persona, voice, avatar, delegation
                           ├─ Vault         OAuth tokens, API keys, SSH keys (Fernet)
                           └─ Store         sessions, events, tasks, logs (SQLite)
```

A chat is **engine × workspace × conversation**. More: [docs/architecture.md](docs/architecture.md),
[docs/providers.md](docs/providers.md), [docs/remote.md](docs/remote.md),
[docs/mate.md](docs/mate.md).

## Branding (forks)

All icons are generated from one master image, `assets/geny-logo.png`. To rebrand,
replace it (square, transparent PNG) and run `python3 scripts/make-icons.py` (needs
Pillow); it rewrites the favicons, PWA icons, in-app logo, desktop icon and Android icon
sources. The logo and the built-in characters are project artwork, not covered by the
Apache licence — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Contributing, security, licence

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to propose changes.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability (please don't open a public issue).
- Code: [Apache-2.0](LICENSE) (see [NOTICE](NOTICE)). Bundled characters, the Live2D
  sample model and the logo have their own terms: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

My Mate Geny is not affiliated with Anthropic, OpenAI or Live2D. Use of Claude Code, Codex
and connected accounts is subject to their providers' terms.
