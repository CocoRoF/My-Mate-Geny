# Architecture

My Mate Geny (formerly hr-harnessor) is a chat-driven agent harness. One
backend process on your server runs the agent CLIs; it can operate local
folders and (via SSH) folders on remote hosts. The Mate layer on top is
described in [mate.md](mate.md).

```
 Web console (React/Vite)   Desktop app (Electron)   Android app (Capacitor)
        └──────────────────────────┬──────────────────────────┘   REST + WebSocket
                                   ▼
        (optional HTTPS reverse proxy / tunnel)
                                   ▼
        FastAPI backend (app/main.py) — also serves the built console (STATIC_DIR)
        ├─ providers/    claude (persistent engine) | codex (exec per turn) — CLI subprocesses
        ├─ providers/accounts.py   pooled CLI logins + balancing
        ├─ workspaces/   local | remote_ssh (SSH-backed MCP bridge)
        ├─ mate/         persona, voice, avatar, delegation to chats
        ├─ vault/        Fernet-encrypted secrets in SQLite
        ├─ services/     provider · connection · workspace · session · git · logs
        ├─ routers/      /api/* REST
        └─ ws/           /ws/* streaming
                                   │
        SQLite (DB_PATH): sessions, messages, events, tasks, connections, accounts, mates, logs, secrets
```

## Two orthogonal axes

A **session** = `provider × workspace × conversation`.

- **Provider** — *which engine*. `app/providers/`. A `Provider` spawns a CLI in
  stream-json mode and yields **normalized events** (`ProviderEvent`): one of
  `session.start · text.delta · thinking.delta · tool.use · tool.result ·
  turn.complete · error`. The UI never sees provider-specific wire formats.
- **Workspace** — *where it runs*. `app/workspaces/`. A `WorkspaceConnector`
  resolves a local `cwd` the CLI can use and optionally an `mcp_config`.

## Turn flow (`SessionService.run_turn`)

1. persist the user message
2. `connector.resolve_cwd(path)` → local path (or sshfs mount for remote)
3. `connector.mcp_config(path)` → optional remote-bash bridge
4. `provider.resolved_api_key()` → api key (or None for OAuth)
5. stream `provider.run_turn_stream(req)`, persisting each event
6. on `turn.complete`, persist the assistant message and remember
   `cli_session_id` so the next turn resumes (`claude --resume`)

Events are persisted, so reloading a session replays its history
(`/api/history/{sid}`).

## Event schema

```json
{ "type": "text.delta", "seq": 12, "timestamp": "2026-...Z", "data": { "text": "..." } }
```

WebSocket protocol: client sends `{"type":"chat","input":"..."}`; server emits
one event object per frame. The socket stays open across turns.

## Storage & secrets

- `app/db.py` — a single lock-guarded SQLite connection (WAL). Schema is created
  idempotently on startup.
- `app/vault/store.py` — `SecretVault` encrypts values with Fernet. The key is
  `VAULT_KEY` or an auto-generated `~/.hr-harnessor/vault.key` (0600). Plaintext
  is **never** returned by any HTTP endpoint — only `read()` decrypts, server-side.
  Provider API keys and SSH private keys live here; other tables hold only
  references (`secret_ref` / `key_ref`).

## Patterns borrowed

- Provider argv + stream-json parsing — `geny-executor` (`claude_code.py`,
  `translators/_cli.py`, `StreamJsonAccumulator`).
- FastAPI + React + WS layout — `geny-executor-web`.
- `asyncssh` remote exec + encrypted vault + host-auth mounting — GAPT.
