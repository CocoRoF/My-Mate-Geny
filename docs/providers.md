# Providers

A provider implements `app/providers/base.py::Provider`:

```python
class Provider(ABC):
    name: str
    async def auth_status(self, *, api_key=None) -> AuthStatus: ...
    def run_turn_stream(self, request: TurnRequest) -> AsyncIterator[ProviderEvent]: ...
```

## Claude Code — `app/providers/claude_code.py` (working)

Spawns `claude` in stream-json mode. Argv (non-root, CLI ≥ 2.1.x):

```
claude --print --verbose
  --input-format stream-json --output-format stream-json --include-partial-messages
  --model <alias|id>
  --settings '{"permissions":{"allow":[...]}}'    # pre-allow tools (no bypassPermissions as non-root)
  [--bare]                                         # ONLY on the api_key path
  [--resume <cli_session_id>]                      # continue a prior turn
  [--mcp-config <json> --strict-mcp-config]        # remote-bash bridge for remote workspaces
```

- **OAuth (subscription)**: no `--bare`, no `ANTHROPIC_API_KEY` in env. Auth is
  detected from `~/.claude`.
- **API key**: `--bare` + `ANTHROPIC_API_KEY` injected into the scrubbed child env.
- stdin: the latest user message as a single stream-json envelope. History
  continuity comes from `--resume`.
- `_stream_json.py` converts wire lines into normalized events; usage/cost and
  `session_id` are captured from the terminal `result` line.

Verified E2E: a turn runs `ls` via the Bash tool and returns a result with
`usage`, `cost_usd`, and a resumable `cli_session_id`.

## Codex — `app/providers/codex.py` (installed & wired)

`codex` CLI 0.165 is installed. The provider spawns:

```
codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox
  -C <cwd> [-m <model>] "<latest user message>"
# resume:  codex exec resume <thread_id> --json ...
```

and normalizes its JSONL events (`_codex_json.py`): `thread.started` →
resumable id, `item.*` (agent_message → text, reasoning → thinking,
command_execution → tool.use/result), `turn.completed` → usage, `error` → error.

**Auth needed to run** (one of):
```bash
codex login                 # ChatGPT OAuth, stored under ~/.codex
# or export OPENAI_API_KEY=... (or save it via the Providers tab)
```
Verified: unauthenticated turns stream a clean `error` event (no hang); auth
status reports installed/not-logged-in correctly. The `item.*` field names
should be reconfirmed on the first authenticated run (the parser is defensive).

## Higgsfield — `app/higgsfield/` (a provider of tools, not an engine)

Not an agent engine: a Higgsfield account (Settings → Providers → Higgsfield) gives every chat's agent, on either
engine, the official `higgsfield` CLI already signed in with an access token the server controls. See
[higgsfield.md](higgsfield.md).

## Adding a provider

1. Subclass `Provider`, implement `auth_status` + `run_turn_stream`.
2. Register it in `app/providers/registry.py`.
3. It appears automatically in `/api/config`, `/api/providers`, and the UI.
