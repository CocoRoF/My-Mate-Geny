# Architecture

hr-harnessor is a chat-driven agent harness. The runtime runs on the **2223**
server; it can operate local folders and (via SSH) folders on remote hosts.

```
 Web (React/Vite)        Mobile (Expo/RN)
        └───────────┬──────────┘   REST + WebSocket
                    ▼
         nginx  (reverse proxy, :58080)
                    ▼
        FastAPI backend  (app/main.py) — the runtime on 2223
        ├─ providers/    claude (working) | codex (stub)   — CLI subprocess, stream-json
        ├─ workspaces/   local (working)  | remote_ssh (scaffold)
        ├─ vault/        Fernet-encrypted secrets in SQLite
        ├─ services/     provider · connection · workspace · session
        ├─ routers/      /api/* REST
        └─ ws/stream.py  /ws/chat/{sid} streaming
                    │
        SQLite (data/harnessor.db): sessions, messages, events, connections, provider_auth, secrets
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
