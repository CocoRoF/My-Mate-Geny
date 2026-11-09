# API-key engines — Anthropic, OpenAI, Google (`app/harness`)

Claude Code and Codex are CLIs that run their own agent loop. A model used with an **API key** has no CLI, so the app
runs that loop itself: `backend/app/harness` is an agent harness that calls the vendor's API, runs the tools the model
calls, keeps the conversation, and produces the same normalized events a CLI turn does. From the session layer, the
chat UI, the Usage page, rewind and copy, an Anthropic / OpenAI / Google chat is one more provider (`anthropic`,
`openai`, `google`; `providers/api_engine.py`, registered in `providers/registry.py`).

It runs wherever the backend runs: on the server (web) and in the desktop app's bundled local backend, on local and
SSH workspaces.

## Settings → Providers → Anthropic / OpenAI / Google

- **Keys** are accounts of the provider's pool (`provider_accounts`, `auth_mode = api_key`, secret in the vault). Add
  as many as you like (`POST /api/providers/{p}/keys`); each is **tested** when added and on demand
  (`POST …/accounts/{id}/test`): the vendor's model list (does it accept the key) plus a tiny generation (can it
  actually generate: a key with no credit lists models fine). The result updates the key's health like a turn would.
- **Load balancing** is always on for these providers (there is no machine login to fall back on): the pool's strategy
  places a new chat on a key, and the chat stays there (its prompt cache lives on that key). A key that is rate
  limited, out of credit or refused is **swapped within the turn** (`services/harness_keys.py`): the next model call
  goes out on another key; the failed one cools down / expires as for the CLIs.
- **Models** (`app/harness/models.py`, tables `api_models`, `api_catalog_state`): the vendor's own list, fetched with a
  key (`POST …/models/refresh`; the first key fills it). Only chat models an agent can drive are kept
  (`vendors.chat_model`). The first time, the vendor's current main models are switched on; later additions start off.
  Per model: on/off, display name, context window (OpenAI doesn't report one), price. Only switched-on models appear
  in New chat, the composer and a mate's engine settings (`providers/catalog.py` → `/api/config`). A change is pushed
  to open pages (`providers.changed` on `/ws/sessions`).
- **Prices** (`app/harness/pricing.py`): the vendors' published standard prices per million tokens (input, output,
  cached input, cache writes, long-context tiers), used to give every turn its cost. A model without a known price
  gets none (its turns show tokens, `cost_kind: "none"`); any price can be set per model.

## The loop (`engine.py`)

One turn: the model answers; the tools it called run (calls marked parallel together, the rest in order); results go
back; until it answers without a call. Each model call (`llm/`) streams through the vendor's official SDK:

| Vendor | API | Carries over between calls |
|---|---|---|
| Anthropic | Messages (`anthropic`), adaptive thinking with summaries, `output_config.effort`, prompt caching on the system prompt and the conversation, `eager_input_streaming` tools | thinking blocks with their signatures (same model only) |
| OpenAI | Responses (`openai`), `store: false`, `reasoning.summary`, `prompt_cache_key` | encrypted reasoning items (`reasoning.encrypted_content`, same model only) |
| Google | Gemini `generateContent` streaming (`google-genai`), `thinking_level` / budget, manual function calling | `thought_signature` on every part (same model only) |

Along the way the turn:

- streams `text.delta`, `thinking.*`, `tool.use` / `tool.result` (a subagent's under its call: `parent`),
  `subagent.text`, `task.update`, `context.update` (the real window from the catalog), notices;
- takes a message the user adds mid-turn (`TurnInbox`) at the next step; tells the model about background work that
  finished (`<task-notification>`), at the next step or — when no turn runs — by starting one (`SessionService._harness_wake`);
- **compacts** the conversation into a summary near the window (`auto_compact_window` of the pool, or the chat's own),
  on a context-length error, and on `/compact` (notice `context.compacted`);
- **retries** an overloaded / unreachable vendor with backoff, waits out a rate limit when there is no other key;
- **Stop** cancels the call and the tools (process groups killed), answers unanswered calls with "Interrupted by user",
  and reports what was spent (`TurnRequest.on_usage` → the `turn.interrupted` event keeps usage and cost);
- ends with `turn.complete`: the final text, usage (`input_tokens` not cached, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `output_tokens`, `reasoning_output_tokens`), `cost_usd` + `cost_kind`, and where the
  conversation stands: `cli_session_id` (the harness conversation) + `cli_at` (its length).

## Conversations (`store.py`)

A conversation (`hs_…`, tables `harness_sessions`, `harness_entries`) is a list of neutral messages (`llm/base.py`).
`cli_at` is a position in it, so the session layer's resume / fork works unchanged: rewind and copy fork the
conversation up to a turn (`fork(id, at)`), exactly what Claude's `--fork-session --resume-session-at` and Codex's
`thread/fork` give the CLIs (docs/session-timeline.md). A compaction appends a summary entry; the model sees the
conversation from the last one on, everything before stays for forks to earlier points. Deleting a chat deletes its
conversations.

## Tools (`tools/`)

Claude Code's names and input shapes, so models know them and the chat draws the same cards:

| Tool | |
|---|---|
| `Bash` | a fresh shell per command in its own process group; the working directory carries over (`cd` sticks); 2-minute default timeout (≤ 10 min); 30k-character output (middle cut); `run_in_background` → a task in the chat's task list, `BashOutput`, `KillShell`, and a notification when it ends |
| `Read` | numbered lines (offset / limit), images shown to the model (downscaled), PDFs as text per page (`pypdf`), notebooks cell by cell |
| `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | a file that exists must have been read first, and not changed since |
| `Glob`, `Grep` | ripgrep when installed, else a Python search over the files git knows (or all but .git / node_modules), same options and output |
| `WebFetch` | the page as text, answered by a side call to the chat's model |
| `WebSearch` | the vendor's own search (Anthropic web_search, OpenAI web_search, Gemini Google Search) in a side call, with sources |
| `TodoWrite` | the to-do list the chat shows |
| `Task` | a subagent with its own context and the same tools (no `Task`), foreground or background |
| `Skill` | installed skills (a session's plugins, e.g. Higgsfield; the project's and the user's `.claude/skills`) |
| `mcp__<server>__<tool>` | every MCP server of the turn's configuration (`--mcp-config` for the CLIs): the chat's MCP connections, a remote workspace's SSH bridge (`remote_bash` …), screen sharing, a mate's own tools — connected with the MCP SDK and kept open between turns (`tools/mcp.py`) |

Per turn, like the CLIs: plan mode keeps only tools that change nothing; a sealed chat (a mate, Avatar Create) gets its
own system prompt (`system_prompt(_file)`) and only the MCP tools its `allowed_tools` name. Background shells,
subagents, MCP connections, the files read so far and the shell's directory live in one runtime per chat
(`runtime.py`), ended on rewind, /clear, delete, shutdown, or after 30 idle minutes (12 h with background work).

## The system prompt (`prompts.py`)

How to work and answer, the environment (working directory, folders, platform, date, model), the chat's folder note
and environment notes (Higgsfield, screen), installed skills, and the instruction files the CLIs read: `CLAUDE.md`
(`.claude/CLAUDE.md`, `CLAUDE.local.md`) and `AGENTS.md` from the working directory up to the repository root, plus
`~/.claude/CLAUDE.md`. Nothing in it changes between turns of a chat, so the vendors' prompt caches keep hitting.

## Mates

A mate can think on an API key (Settings of the mate → Language model): the same sealed engine as on Claude Code —
her prompt file, only the mate MCP tools — run by the harness. Her background jobs (memory consolidation, diary) take
a key from the same pool. Default model: the vendor's mid model when it is switched on (`vendors.MATE_MODELS`).

## Tests

- `backend/tests/test_harness_engine.py`: the loop against `tests/fake_vendors.py`, stand-ins of the three APIs in
  their real streaming formats — events, tools, what goes back to the model (signatures, encrypted reasoning,
  thought signatures), resume and fork, key failover, retries, steering, Stop, compaction, subagents, background work,
  plan mode, MCP, images.
- `backend/tests/test_harness_sessions.py`: through the session layer — pool keys, rewind and copy, Stop keeps the
  cost, the task list, a mate on an API key, the Settings endpoints.
- Browser: `desktop/test/e2e/api-providers-browser.js` (server: `api-providers-server.py`).

`HRH_ANTHROPIC_BASE_URL` / `HRH_OPENAI_BASE_URL` / `HRH_GOOGLE_BASE_URL` point a vendor elsewhere (a proxy, a gateway,
the fakes).
