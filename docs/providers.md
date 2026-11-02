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
## CLI versions — `app/services/cli_tools/` (Settings → Providers → CLI versions)

Claude Code, Codex and the Higgsfield CLI, **as the backend launches them**:
`<binary> --version` of the binary sessions run (`CLAUDE_BINARY` /
`CODEX_BINARY` / `HIGGSFIELD_BINARY`, looked up on the backend's own `PATH` —
inside the container when it runs in one) against the npm registry's
`dist-tags` (`/-/package/<pkg>/dist-tags`, no auth; Claude: the `latest` or
`stable` channel, defaulting to `autoUpdatesChannel` in `~/.claude/settings.json`),
cached `CLI_CHECK_TTL_H` (6 h; **Check now** refreshes; `CLI_UPDATE_CHECK=false`
turns lookups off). Release notes: Claude's `CHANGELOG.md` (the versions between
installed and target), Codex / Higgsfield GitHub releases. "Update available"
(and the Settings badge, `frontend/src/lib/attention.ts`) only for a strictly
newer version that can be installed here and isn't already being handled.

How an upgrade is done depends on how the binary in use was installed (from its
real path, `versions.detect_install`):

| Install | Detected by | Upgrade |
|---|---|---|
| Claude native installer | `…/share/claude/versions/<v>` (`~/.local/bin/claude` links there) | `claude install <version>` |
| npm prefix this process can write | `<prefix>/lib/node_modules/<pkg>/…` | `npm install -g --prefix <prefix> <pkg>@<version>` (the prefix's own npm, e.g. an nvm node's) |
| read-only copy (the Docker image's `/usr/lib/node_modules`), unknown, or missing | — | installs **the app's own copy** with npm into `CLI_MANAGED_PREFIX` (`~/.hr-harnessor/cli`) and uses it from then on (`~/.hr-harnessor/cli-state.json`; **Use the configured copy** under More options switches back) |

So in Docker the upgrade lands on the persistent home volume, not in the
image: it survives restarts and image rebuilds, and every launch site
(`ClaudeCodeProvider._binary`, `CodexProvider._binary`, the Codex login, Admin →
System) resolves the binary through `tools.effective_binary`. Rebuilding the
image is the other way to move the bundled copies forward.

One upgrade at a time; optionally **when idle** (waits until no chat turn runs).
It runs under the host's memory cap (`capped -m CLI_UPGRADE_MEM --`) when a
systemd user session is reachable (not inside a container: logged), with a
timeout (`CLI_UPGRADE_TIMEOUT_S`), its output pushed over `/ws/sessions`
(`cli.log`, `cli.changed`), and counts as done only if `--version` then reports
the target. A specific version (pin / roll back to the previous one) goes
through the same updater. Codex and Higgsfield apply from the next turn; Claude's
persistent engines restart once idle (`EngineManager.retire_stale`, the
conversation continues with `--resume`). **Upgrade automatically** (per CLI,
off by default) does the same "when idle" after each check.

Real check against temp prefixes (never the CLIs in use):
`backend/tests/manual_cli_upgrade.py`; the browser run:
`desktop/test/e2e/cli-versions-browser.js`.

## Adding a provider

1. Subclass `Provider`, implement `auth_status` + `run_turn_stream`.
2. Register it in `app/providers/registry.py`.
3. It appears automatically in `/api/config`, `/api/providers`, and the UI.
