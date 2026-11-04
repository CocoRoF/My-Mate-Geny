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

When a run ends (a turn, or one Claude starts by itself after background work),
the session keeps how (`last_result`: ok | error | stopped) and when
(`last_result_at`); `last_seen_at` is when someone last had the chat open, and
the list reports `result_unseen` while the result is newer. The sidebar shows
Complete / Failed / Stopped for those (working — a turn or background tasks —
wins). Seen = a chat socket says the chat is on screen (`attach` with
`visible: true`; `{"type": "view", "visible": false}` when the page is hidden),
or `POST /api/sessions/{sid}/seen`; a run that ends while its chat is on screen
is seen as it ends. Every change moves the list version on `/ws/sessions`, so
every device follows without polling. Mate conversations keep none.

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

## Task drawer and right sidebar

`GET /api/sessions/{sid}/tasks/page` returns completed task metadata for the latest two
conversation turns, plus every still-running task independently of its launch turn.
It uses the same user/automatic-turn anchors as chat history. Earlier two-turn windows
are requested explicitly through an opaque, session-bound cursor. A single large window
is additionally capped at 50 finished tasks per request, using `(started_at, task_id)`
keyset pagination. The oldest window includes pre-turn/legacy rows. No tasks or output
files are deleted; expanding a row continues to fetch its output separately. The legacy
list endpoints remain available for old clients. SQLite indexes cover the task time range
and active statuses. Snapshot timestamps prevent older fetches from overwriting newer
socket updates; a reconnect clears outdated running badges.

The task store loads only this first page on initial connection. The drawer's “more” button
loads additional metadata while preserving expanded row state. Its all-chats tab keeps its
existing cross-session behavior. Tests: `test_task_page.py`, `task-paging.test.ts`, and real
Electron fixture `tasks-sidebar.cjs` (1,200 finished tasks and pinned old work).

Explorer and Session panel share one `RightSidebar` shell and one atomic `sidePanel` state,
with one device-local width (340px default, 220–640px adjustable). Existing explorer width,
expanded folders and file tabs migrate through workbench persistence v2. The two bodies
remain mounted after first use; switching changes only which body is shown. This retains
scroll and section state and avoids intermediate double panels and chat-width changes.
Only an active explorer fetches roots or refreshes after a completed turn; cached content
remains visible during refresh. Both views share pointer/keyboard resizing and the same
mobile drawer/backdrop. Native application code does not change.
