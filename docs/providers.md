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

## Plan usage — `app/providers/plan_fetch.py` (the 5-hour / 7-day bars)

Each account's plan numbers come from the provider's usage endpoint (Claude:
`GET api.anthropic.com/api/oauth/usage`; Codex: `chatgpt.com/backend-api/codex/usage`).
That endpoint is rate limited per account and can answer **429 with
`Retry-After: 3600`**. Every reader — the Providers cards, the composer's account
popover, the load balancer on each turn, the Usage dialog
(`/api/usage/subscription`) — goes through one `PlanFetcher` per account:

- at most one request per account every **2 minutes** (`ttl_s`); the Usage dialog
  may ask sooner (`?refresh=true`, ≥ 30 s after the last one) but never inside a
  backoff; the balancer asks for windows only (no `/api/oauth/profile` call; the
  profile is fetched at most once a day, for the Usage dialog);
- **429**: wait what `Retry-After` says (clamped to 1 min … 6 h), else 2, 4, 8 …
  min; once it keeps refusing, never less than that backoff; 5xx / network: 1, 2,
  4 … min (≤ 30 min); **401** (token refused): not asked again until the
  credentials file changes (or 1 h);
- **no request with an expired access token** (it can only fail): the numbers
  wait until the CLI renews the token on the account's next use, or *Renew
  session*;
- concurrent callers share one request; one that only needs numbers gets the
  last known ones right away while another one is fetching;
- the last good numbers are always shown, with `plan_fetched_at` and why they're
  old (`plan_stale_reason`: rate_limited / token_expired / needs_login / auth /
  network / http, `plan_retry_at`) — the card says "Last checked 25 min ago · the
  usage server asked to wait — checking again at 12:30" instead of "no data";
- numbers + backoff are kept in `provider_plan_cache` (no secrets), so a restart
  neither forgets them nor asks a throttled endpoint again. When nothing was
  ever fetched, the engines' live `rate_limit_event` numbers stand in.

`PLAN_USAGE_FETCH=false` turns the requests off (cached / live numbers only).

## Login sessions — `app/providers/login_session.py`, `session_renew.py`

Every account card has a **Login session** row, read from the CLI's own files —
never a network call, never a token sent to the browser or logged:

| | Claude | Codex |
|---|---|---|
| file | `<config dir>/.credentials.json` → `claudeAiOauth` (on Linux this file *is* the CLI's store) | `<CODEX_HOME>/auth.json` |
| method | subscription OAuth; long-lived token (`setup-token`: no refresh, no expiry; `CLAUDE_CODE_OAUTH_TOKEN`); API key | ChatGPT OAuth; API key |
| who | `oauthAccount` in the CLI's `.claude.json` (`~/.claude.json` for the host login), else the cached profile | `email` in the id token |
| expiry | `expiresAt`, `refreshTokenExpiresAt` | the access token's `exp` |
| last renewed | the file's mtime | `last_refresh` |
| scopes | `scopes` | the access token's `scp` |

Health (`classify`): **valid**; **expiring** (≤ 15 min left — the CLI renews it 5
min before — or the refresh token ends within 3 days); **expired** (the access
token ran out but a refresh token can renew it — the CLI does on the next use:
information, not a problem); **refresh_failed** (expired *and* the last renewal
failed transiently); **needs_login** (no / expired refresh token, the provider
refused the refresh token, or a turn was refused); **no_credentials**.
Only `needs_login` / `refresh_failed` are *actionable*: they light the Settings
badge (`GET /api/providers` → `session_attention`, enabled accounts only) and the
balancer skips them (`ineligible_reason = session_expired`). A background check
(every 5 min, files only) logs an account once when it becomes actionable.

**Renew session** (`POST /api/providers/{p}/accounts/{id}/session/renew`, the host
login's id is `__primary__<p>`):

- *Claude, token due* (within Claude Code's 5-minute window, or past it): run
  `claude auth status --json` with the account's config dir (pooled:
  `CLAUDE_CONFIG_DIR`; host: the CLI's default `~/.claude`). That command makes
  Claude Code renew its own token — its lock, its write; the app touches nothing.
- *Claude, not due yet* (or the CLI didn't renew it): call the same token
  endpoint the CLI calls (`platform.claude.com/v1/oauth/token`, its client id, the
  stored scopes) **while holding both locks Claude Code takes before it renews**
  — `<config dir>/.oauth_refresh.lock` and the legacy `<config dir>.lock` (mkdir
  locks, stale after 60 s, touched every 5 s). Under the locks the file is read
  again: a changed token means someone renewed it meanwhile → nothing is sent.
  After the answer it is read once more and written (atomically, same 0600 mode,
  every other field kept, rotated refresh token + new expiries) only if the
  refresh token on disk is still the one that was sent.
- *Codex*: only the CLI renews — `codex app-server`, `account/read
  {refreshToken: true}` with the account's `CODEX_HOME`.

Why that's safe for the host login ("Primary · this machine", shared with Claude
Code in your terminal / editor): refresh tokens rotate, so two parties renewing
with the same one would leave one of them logged out. The CLI path *is* Claude
Code; the direct path takes Claude Code's own two locks and re-reads before
sending and before writing — exactly what a second Claude Code process does, so a
terminal session waiting on the lock finds the renewed token instead of renewing
again.

`invalid_grant` (revoked / expired refresh token) → **needs_login**; a network /
5xx failure → **refresh_failed** only once the access token has also run out.
**Sign in again** opens the existing sign-in flow (pooled accounts: their own
OAuth; the host login: the provider-level one, which writes `~/.claude` /
`~/.codex`). Tests: `backend/tests/test_login_sessions.py` (fake CLI, fake token
endpoint); browser run: `desktop/test/e2e/login-sessions-browser.js` (seeded by
`login-sessions-seed.py`, fake tokens, a dead HTTPS proxy).

## Adding a provider

1. Subclass `Provider`, implement `auth_status` + `run_turn_stream`.
2. Register it in `app/providers/registry.py`.
3. It appears automatically in `/api/config`, `/api/providers`, and the UI.
