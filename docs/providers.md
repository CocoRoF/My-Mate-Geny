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

## Codex — `app/providers/codex.py` (stub)

Implements the contract so Codex is selectable today; `run_turn_stream` yields
one actionable `error` until the CLI is wired. To finish:

```bash
npm install -g @openai/codex
codex login            # ChatGPT OAuth, or set OPENAI_API_KEY
```

Then map `codex exec --json` (or the `codex proto` stdin/stdout protocol) events
to the normalized schema in a dedicated accumulator — see the TODO in the file.

## Adding a provider

1. Subclass `Provider`, implement `auth_status` + `run_turn_stream`.
2. Register it in `app/providers/registry.py`.
3. It appears automatically in `/api/config`, `/api/providers`, and the UI.
