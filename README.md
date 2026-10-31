# My Mate Geny

*(formerly hr-harnessor — repo, directories, app ids and storage keys keep that name.)*

A self-hosted **agent harness service** — chat-driven, provider-pluggable, runs on your
local **2223** server and can operate folders on remote servers (2222 / 2224) too.

> [한국어 README](README_ko.md)

## What it is

My Mate Geny turns coding agents into a chat service you control:

- **Engines** — Claude Code (`claude` CLI) and Codex (`codex` CLI), switchable mid-chat with
  the conversation handed over. Claude runs as a **persistent engine** per chat (background
  tasks, Claude's own follow-up turns, live interrupt / model / permission-mode changes);
  Codex runs one `exec` per turn. Output is normalized to one event schema.
- **Workspaces** — a local folder on 2223, or a folder on a remote SSH host (2222 / 2224 /
  2223 itself). The runtime stays on 2223; remote work goes through an SSH-backed MCP
  bridge (`remote_bash/read/write/list`) for both engines. Extra folders per chat.
- **Agent UX** — prose and tool activity kept apart (folded tool groups, diffs, subagent
  nesting), exact per-turn file changes from git snapshots with diff viewer and undo,
  background-tasks panel, steering a running turn, queueing, `/` commands and `@` files,
  photos/files/clipboard attachments, images the agent produced, notifications.
- **Explorer + file tabs** — a VS Code-style explorer (right side, local or remote host) and
  file tabs next to the chat. Paths the agent prints (`inline code`, links, bare absolute
  paths, `file.py:42`) open on click. Viewers: code (highlighting, line jump), markdown
  (rendered/source), CSV/TSV (sortable table; UTF-8/CP949/UTF-16), Excel (sheet tabs), Word,
  PowerPoint (outline), PDF (pdf.js), notebooks, HTML (sandboxed), images/audio/video.
  Rules live in `frontend/src/lib/fileView.ts`; the harness's own credentials are never served.
- **Clients** — the web console (desktop + mobile layouts), a **desktop app** (Electron:
  Windows / macOS / Linux) and an **Android app** (Capacitor). The apps load the live console,
  so UI updates reach them instantly; app builds are produced by CI and offered on the
  console's **Download** page.
- **Context** — a context meter in the composer (the last model call's input + cache tokens
  against the window and auto-compact point the CLI itself reports), compaction dividers,
  "Compact now", and a configurable auto-compact window (global default + per chat, passed
  as `CLAUDE_CODE_AUTO_COMPACT_WINDOW`): every model call re-reads the whole context, so a
  smaller window spends less plan usage per call at the cost of summarised history.
- **Operations** — multi-account load balancing (plan-usage aware, live rate-limit aware),
  admin console (error logs, system, security), revocable sessions, IP bans. Chats are
  **sticky** to the account they ran on (the prompt cache is per account; idle engines are
  closed after 30 min and respawn with `--resume` on the same account, so closing one costs
  no cache). A chat moves only when its account is unusable or near a limit (5h ≥ 90%,
  7d ≥ 95% by default) while another has headroom; an account that hits its limit cools down
  until its reset and the running turn continues once on another account, with a notice.
  The machine's own login can be excluded or kept as a fallback.

```
 Web console      Desktop app (Electron)      Android app (Capacitor)
        └──────────────────┬───────────────────────┘   REST + WS (same origin)
                           ▼
        Cloudflare tunnel → FastAPI backend (2223 = runtime)
                           ├─ Engines       claude (persistent) | codex (per turn)
                           ├─ Workspaces    local | remote SSH (MCP bridge)
                           ├─ Changes       git snapshots per turn
                           ├─ Vault         OAuth/tokens + SSH keys (encrypted)
                           └─ Store         sessions, events, tasks, logs (SQLite)
```

Two orthogonal axes compose a session: **Engine × Workspace × conversation**.

## Mate

On top of the chats sits the **Mate**: an avatar you talk to (video, photo or Live2D body,
persona, voice in and out). It does not do the work itself — it is a secretary that hands
work to the chat sessions the way you would, follows up and reports back. In the console it
is the **Mate** item above **Chat**; the desktop app also puts it on the desktop (a
transparent always-on-top avatar with a hover action bar, a quick chat card on
**Ctrl/Cmd+Shift+G**, a mate chat window, tray and start at login), and the Android app
runs it in-page with the microphone. Design contract: [docs/mate.md](docs/mate.md).

## Quick start (dev)

```bash
# backend
cd backend
uv pip install -e .            # or: pip install -e .
cp ../.env.example ../.env     # adjust if needed
uvicorn app.main:app --reload --port 8080

# frontend (separate shell)
cd frontend
npm install
npm run dev                    # http://localhost:5173 (proxies /api + /ws to :8080)
```

Then open the web UI, connect the Claude provider (uses your `claude` subscription auth),
pick a local folder as the workspace, and chat.

## Apps & releases

- `desktop/` — Electron shell (see [desktop/README.md](desktop/README.md)).
- `mobile/` — Capacitor Android shell (see [mobile/README.md](mobile/README.md)).
- `.github/workflows/apps.yml` — on every push touching the apps (or on demand) builds Windows
  NSIS, macOS dmg (arm64 + x64), Linux AppImage + deb and a signed APK, then updates the
  rolling `apps-latest` release that the console's Download page serves.

Plan & verification log: [docs/PLAN-apps-agent-ux.md](docs/PLAN-apps-agent-ux.md).

Deployment & auth: [docs/deploy.md](docs/deploy.md). Full design:
[docs/architecture.md](docs/architecture.md).

Architecture patterns are adapted from the local `geny-executor` (provider argv / stream-json),
`geny-executor-web` (FastAPI + React + WS), and GAPT (asyncssh + encrypted vault).
