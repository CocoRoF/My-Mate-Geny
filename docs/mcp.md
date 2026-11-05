# Provider settings and managed MCP

Settings has three independent entries:

* **Language model providers**: Claude Code and Codex accounts, sign-in,
  load balancing, context windows and their CLI installations.
* **Image and voice providers**: Higgsfield accounts and CLI, OpenAI,
  ElevenLabs, Google Gemini, and self-hosted voice services. Voice keys and
  URLs use the existing encrypted Mate settings; changing the location of
  the UI does not copy, clear or replace existing credentials. Google adds
  its own write-only key. Available media models come from a free model
  listing; model names for a mate's voice are selected in its Voice tab.
* **MCP**: a catalog of configured connections and tools. Nothing in this
  catalog is automatically enabled in every chat.

## Manage, catalog and manual setup

The MCP settings page opens on **Manage MCPs**. **Catalog** contains only
**Atlassian (Jira / Confluence)**, using the sooperset package. It supports
Cloud and Server/Data Center. The card shows its publisher, source and
installation documentation; browsing does not install or connect anything.

The catalog flow is **Download → Configure and test → Register MCP**. The recipe offers named Jira/Confluence URLs, Cloud
email/API-token credentials or Server/Data Center personal tokens. Writing is on by default (publishing and editing
pages, creating and changing issues), because the catalog is how people publish; read-only is an option. Microsoft SSO
does not replace the API token used for this connection.

Downloads use reviewed, fixed package identities, resolve an exact version on
an explicit click, and install in `home_dir/mcp-packages`. Python packages and
their complete dependency sets use isolated target directories; their SDK
version cannot replace Geny's SDK. A small runner uses the **current** bundled
interpreter, rather than persisting a temporary AppImage interpreter path.
Node packages have their own npm prefix and run their installed entry point,
not an `npx` download during connection startup. Node/npm is prepared in the
existing app-owned runtime if absent. Neither flow upgrades system packages
or provider accounts. Download operations share a single lease with provider
installation, are cancellable, and publish a manifest atomically only after
entry-point verification. Broken manifests/entry points and incompatible
Python runtimes are reported as requiring a new download.

Testing initializes the actual MCP transport and discovers tools. It does
not invoke tools or verify every tool's upstream permissions. A failed test
creates no registration and leaves an existing registration unchanged. A
successful test yields a one-use, five-minute server-side draft; registration
promotes that exact live connection. Editing a draft, expiry or a concurrent
change in another window requires a new test. Closing or expiring a draft
releases its connection. Repair preserves the registration ID and session
selections. No session is automatically granted a newly registered MCP.

**Manual setup** retains command, URL, JSON import, environment and header
editors. Saving with connection enabled tests before registering; explicitly
saving a disabled definition and importing JSON retain their offline behavior.
Sensitive legacy argv values are returned as JSON `null`; sending that null
at the same secret position preserves the saved value without echoing it.

Prerequisite errors distinguish missing executables (including Docker),
inaccessible working folders, invalid Docker environment arguments, unavailable
Docker engines, authentication rejection and connection timeouts. They name the
**runtime** that owns the process. Docker on the desktop or host does not make
it available inside a server container, and this feature does not mount a host
Docker socket. Catalog alternatives can avoid that dependency entirely.
Connection failures count as errors in the system card as well as in the logs.

## Manual configuration format

Add a name and either an executable plus arguments (`stdio`), a Streamable
HTTP endpoint, or a legacy SSE endpoint. Arguments may be one per line or
a JSON string array (the latter also supports empty arguments). The app
does not evaluate a shell command. An optional working directory belongs
to the machine running the backend.

Environment variables and authentication headers have a row editor with
masked values. Saved values are never returned by an API. Leaving a saved
row's value blank preserves it; deleting the row removes it. A newly
entered value replaces the old one. Definitions, including arguments and
URLs, are encrypted in the existing vault. HTTP authentication supports
explicit headers, such as `Authorization: Bearer …`; interactive MCP OAuth
login/refresh is not part of this interface.

The import accepts a JSON object with `mcpServers`, such as the standard
Claude configuration. Supported fields are command, args, cwd, env, url,
headers and timeouts. `type: http` / `sse` selects the corresponding URL
transport; a command selects stdio. Claude's per-server millisecond
`timeout` becomes `timeout_s`. All entries are validated before any write.
Existing names are skipped, not overwritten. Imports start disconnected;
replace example keys/placeholders in the editor and then enable the
connection. Provider-specific client features (OAuth helpers, client
plugins, automatic approvals, sampling) are not imported as executable
policy.

Registering/running a command is an explicit user action. For tools using
`npx`, Node/npm can be installed from the existing CLI dependencies card.
The MCP runtime prepends the app-owned Node directory to the child PATH.
It passes only the SDK's standard platform environment plus the variables
explicitly configured for that MCP, not the backend's vault/auth secrets.

## Where it runs

In **Local mode**, the app's bundled Python backend owns the encrypted
catalog and SDK clients. A stdio server runs on the desktop, even if the
chat happens to work in an SSH workspace. No Geny server is required.

In **Server mode**, the connected Geny server owns the catalog, credentials
and MCP processes/HTTP clients. Browsers and desktop renderers never spawn
those processes or connect directly to the MCP endpoint. Paths refer to
the server. Local and Server catalogs live in their respective databases;
keys are not synchronized between machines.

Each registered definition has one managed upstream client. The backend
multiplexes authorized sessions through it, with a bounded call queue and
eight concurrent requests. Root/workspace access is determined by the
MCP's own configured arguments/permissions. A chat's workspace is not
silently added to a filesystem server's allowed roots.

## Session panel

Each session starts with every registered MCP **off**. Turning an item on
persists that session's selection. The next turn provides a small SDK-backed stdio
gateway to Claude Code or Codex. The SDK gateway handles parallel calls and individual cancellation. The upstream key stays in the backend;
the gateway reads a session-scoped capability from a private token file.
This is combined with the existing SSH and screen bridges, not substituted
for them. A definition revision changes the persistent engine fingerprint.

Turning an item **off** revokes the capability immediately and cancels
that session's outstanding requests. A running engine may still display
cached tool names, but its further calls are rejected. It receives the
updated tool list on the next turn. Turning the global connection off or
deleting it blocks all sessions, while turning it off in one session does
not disconnect other sessions. A canceled remote tool may already have
performed work; cancellation does not roll back remote side effects.

Connection definitions and selections survive a restart. Enabled upstream
connections reconnect; an error is shown and can be retried. Deleted or
unreadable definitions never grant a session access. A corrupt definition
is preserved for diagnosis and can be deleted without decrypting it.
Shutdown closes the SDK clients and stdio process trees.
The gateway forwards protocol cancellation to the exact upstream request;
the SDK v1 client adapter explicitly sends cancellation notifications on
task cancellation and deadlines, while leaving other sessions connected.

## Timeouts and logging

Calls have a configurable 5–3600 second backend deadline (default 120).
The Claude per-server millisecond `timeout` and Codex `tool_timeout_sec`
allow ten seconds for the gateway response beyond that deadline; the
backend still ends the tool request at the configured time. Managed
bridges allow 35 seconds for startup and Codex waits for their initial
catalog instead of omitting a slow optional connection. No persistent
user CLI configuration is edited.

Admin → System includes MCP connection states, tool counts, call/error
counts, last duration and paginated events. Logs persist through the
existing log service (`source=mcp`) and also appear in Admin → Error logs.
Events include connect/disconnect/retry, session enable/disable, call
start/completion/failure/cancellation and optional, rate-limited stderr (off by default). Environment
and header values are redacted; SDK tracebacks are not forwarded. Basic call logs exclude tool arguments and result bodies. The advanced
server diagnostics option includes the server’s own stderr, with configured
keys redacted; a server may print other data there. User cancellation is
counted separately from failed calls. Viewing the
system card polls only while visible; historical pages remain stable.

The collapsed catalog includes at most eight short tool summaries. Opening
the tool list fetches descriptions fifty at a time; input schemas remain in
the actual session MCP protocol rather than in the settings catalog response.

## Verification

`backend/tests/test_mcp_runtime.py` uses actual SDK stdio, Streamable HTTP
and SSE servers (authenticated HTTP fixture), tools, resources and prompts.
It checks per-session permissions, immediate revocation/cancellation,
environment filtering, encrypted storage, restart/cleanup, dead-process
detection and CLI timeout configuration. `test_mcp_api.py` exercises the
authenticated API, all-or-nothing validation and the loopback token gate.

`test_mate_google.py` uses mocked HTTP to check model-only verification,
write-only keys, PCM-to-WAV TTS, transcription and error redaction.
`frontend/test/mcp-form.test.ts` covers argument preservation, write-only
secret edits, duplicates and the new deep links.

`desktop/test/e2e/provider-mcp-e2e.js` runs the actual Local app and a
separate Server deployment, with a real MCP fixture and a coding CLI
fixture. Google uses a local model-list fixture. No generation, paid
transcription, provider sign-in or provider installation is performed.

Official implementation references:

* [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
* [Stable Python SDK v1](https://github.com/modelcontextprotocol/python-sdk/tree/v1.30.0)
* [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
* [Claude Code MCP time limits](https://code.claude.com/docs/en/mcp#time-limits-on-mcp-tool-calls)
* [Gemini speech](https://aistudio.google.com/docs/speech-generation)
* [Gemini audio](https://aistudio.google.com/docs/audio)

Reviewed catalog references (2026-11-05):

* [sooperset Atlassian installation](https://github.com/sooperset/mcp-atlassian/blob/main/docs/installation.mdx)

`test_mcp_catalog.py` covers browsing without downloads, named credentials,
prerequisite errors, private legacy arguments, exact test promotion, stale
revisions, expiry, isolated installation, cancellation and damaged manifests.
The existing `provider-mcp-e2e.js` also checks the server catalog at mobile
width. Optional execution checks that downloaded unrelated catalog entries
were removed. Manual MCP connections remain available in Manual setup.
