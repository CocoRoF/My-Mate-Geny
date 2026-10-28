# hr-harnessor

A self-hosted **agent harness service** — chat-driven, provider-pluggable, runs on your
local **2223** server and can operate folders on remote servers (2222 / 2224) too.

> [한국어 README](README_ko.md)

## What it is

hr-harnessor turns coding agents into a chat service you control:

- **Providers** — Claude Code (`claude` CLI) is wired and working; Codex (`codex` CLI) has an
  interface stub ready to connect. Each provider is spawned as a subprocess in stream-json
  mode and its output is normalized to a single event schema.
- **Workspaces** — pick *where* an agent runs: a local folder on 2223, or a folder on a
  remote SSH host (2222 / 2224). The runtime always stays on 2223; remote folders are
  mounted (sshfs) and remote commands are proxied over SSH.
- **Web + Mobile** — a React/Vite web UI and an Expo (React Native) app talk to the same
  FastAPI backend over REST + WebSocket.

```
 Web (React/Vite)        Mobile (Expo/RN)
        └───────────┬──────────┘   REST + WS
                    ▼
         nginx  →  FastAPI backend (2223 = runtime)
                    ├─ Provider layer   claude | codex   (CLI, stream-json)
                    ├─ Workspace layer  local(2223) | remote_ssh(2222/2224)
                    ├─ Secret Vault     OAuth/tokens + SSH keys (encrypted SQLite)
                    └─ Session store    chat & event history (SQLite)
```

Two orthogonal axes compose a session: **Provider × Workspace × conversation**.

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

## Status

| Area | State |
|---|---|
| Backend core (config/db/vault) | ✅ |
| Claude Code provider | ✅ working (local + remote) |
| Codex provider | ✅ wired (`codex exec --json`); needs `codex login` to run |
| Local workspace | ✅ |
| Remote SSH workspace (2222/2224) | ✅ working E2E (sshfs mount + asyncssh bash bridge) |
| Web UI | ✅ chat E2E |
| Mobile (Expo) | ✅ buildout (login/sessions/new/chat); not yet device-tested |
| Auth + IP ban + tunnel | ✅ live at https://agent.hrletsgo.me |
| Docker / nginx deploy | ✅ compose (host-run deploy is live) |

Deployment & auth: [docs/deploy.md](docs/deploy.md). Full design:
[docs/architecture.md](docs/architecture.md).

Architecture patterns are adapted from the local `geny-executor` (provider argv / stream-json),
`geny-executor-web` (FastAPI + React + WS), and GAPT (asyncssh + encrypted vault).
