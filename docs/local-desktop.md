# Local desktop and first-run setup

The desktop offers Local execution and Server connection. Local execution launches a bundled CPython backend
and the bundled UI on a random IPv4 loopback port; it does not use a Geny web server. The existing native windows,
Mate, capture, voice, settings and filesystem APIs use that local origin. Claude Code/Codex continue using their
own provider authentication and network connections.

## Runtime contract

- A relocatable CPython distribution, backend source/resources and a clean UI build ship as extraResources.
  Python is a real interpreter so stdio MCP bridges, helper scripts and the optional processing venv work.
- User HOME is preserved for installed CLI detection/auth. Geny state lives separately in the app's local data
  directory, with its own DB, vault, files and sessions. Paths/PATH and process cancellation support all target OSes.
- The runtime binds 127.0.0.1 only. A launch-scoped secret lets the native main process mint its own normal
  HttpOnly session cookie. No login form or bootstrap secret reaches the renderer. Server auth is unchanged.
- One backend per app instance, readiness/timeout/crash errors visible, and owned process cleanup on Quit/mode
  switch. Remember Local/Server selection; do not lose a remembered remote server when selecting Local.
- Local ports change across restarts; rebind saved local capture intent to the new origin without losing ON.

## Setup assistant

The first setup on a device/connection shows an assistant instead of the new-chat form. Completed setup keeps
the existing last-conversation restoration policy. The assistant can be reopened explicitly.

1. Detect Claude Code and Codex, including common GUI-launch PATH omissions. Either configured provider suffices.
2. If missing, explicitly install using the providers' official user-scoped standalone installers; show progress,
   cancellation/retry and re-detect. Never auto-install/upgrade an already installed CLI, and never touch Higgsfield.
3. Reuse existing CLI login or guide provider sign-in/configuration with the existing provider controls.
4. The assistant configures providers only. Its footer offers the text action “I'll set this up later” and a
   “Finish setup” primary button, enabled once either provider is connected. Both persist dismissal; neither picks
   a folder nor creates a session. Reopen the assistant later to finish provider setup.

The new-chat form chooses the working folder separately. Local execution uses a full-width folder card and the OS
folder dialog; the card shows the selected folder name/path and a Change action. Server mode keeps server
workspace/SSH/Git selection. No theme choice defaults to System: the first paint, app windows and console follow
OS light/dark changes; an explicitly saved appearance choice remains respected.

## Delivery checks

- Backend: bootstrap guards/auth isolation, owned data paths, actual subprocesses, Windows portability and CLI setup.
- Native: Local/Server UI, process readiness/failure/cancellation, restart, mode switch, quit/child cleanup.
- UI: first-run and completed state, provider discovery/install/sign-in, local folder, remote browser/mobile setup.
- Real Electron/Xvfb with a packaged runtime, independent of a running remote backend. Test fixture providers for
  chat execution; no paid model calls or real account login changes. Actual CLI install checks use disposable HOME.
- CI builds/tests runtime on Windows, Linux, macOS Intel and Apple Silicon; preserve release artifacts and retry
  transient publishing errors without deleting an already published release. No private download credentials ship.

Official references:
- https://learn.chatgpt.com/docs/codex/cli
- https://learn.chatgpt.com/docs/config-file/environment-variables
- https://code.claude.com/docs/en/setup
- https://docs.astral.sh/uv/guides/install-python/

## Persistence and updates

Local history/vault/assets stay in the existing desktop user-data directory's `local` subfolder. Remote history
is not copied into it. Local selection does not erase the remembered remote server or its credentials.
The runtime prefers its previous loopback port; if busy, it chooses another port and restores native-owned UI
preferences and capture origin. Setup completion is keyed by `local`, independent of that port.

A local installation runs its bundled code. Installing a newer desktop package updates that code while retaining
its data; a browser reload alone cannot update a local bundle.

## Device-owned app updates

Every desktop mode defaults to `https://github.com/CocoRoF/My-Mate-Geny`. Settings → Updates & Download ends with
an Update source editor for a compatible public repository/fork. The selection lives in native settings on this
device, independently of any connected Geny server. The local UI shows the desktop version, not a web-console build.
The sidebar also shows the real app version. The default repository is currently private: its assets need this
computer's existing GitHub CLI sign-in or a user-supplied read token. Changing repository visibility is never automatic.
OS encryption protects saved tokens; if unavailable, tokens stay in memory only and the UI explains that lifetime.
Tokens are never returned to renderers or sent to Geny servers, and are stripped before signed-storage redirects.

The source reads `apps-latest`, falling back to the repository's latest release. A compatible source publishes
`latest.yml` / `latest-linux.yml` and installers with the existing platform suffixes. A random capability on a random
IPv4 loopback port exposes only release assets to the desktop updater, never arbitrary URLs or filesystem paths.
Source edits are blocked while checking/downloading/ready-to-install; all windows subscribe to native source changes.
Normal updater checksum validation, cancellation, quit cleanup and restart behavior remain in effect.

## Visits and prerequisite installation

The assistant is automatic only on a connection's first visit. Showing it records the visit even when the user
closes the app without finishing; existing completed setup and existing connections migrate on update. Local visits
are keyed by `local`, not the loopback port. The assistant is still available from the sidebar when explicitly opened.

Settings → Providers can install missing Claude Code/Codex with their official standalone installers and missing
Higgsfield through its official npm package. Node.js/npm can be explicitly installed in app-owned storage first, or
with the Higgsfield install button. Node 24 LTS binaries come from nodejs.org, with SHA256 validation, safe archive
extraction, staging before activation, progress/cancellation and post-install verification. PATH changes are limited to
app child processes; system tools and existing credentials are preserved. Session engines and login/version helpers
use the same prerequisite path immediately. Missing Git links to its official install assistant.

Installer jobs are serialized with CLI upgrades. API clients on older Geny servers keep their existing upgrade UI
until the new installer endpoints are available. Local installations use the backend bundled with this app.

## Signing out and expired authentication

Both desktop sign-out buttons invoke the native connection transition in every execution mode. That transition
shows Local/Server selection, clears the former connection's cookies, pauses capture without erasing saved sharing
intent, and stops its owned local runtime. Selecting another mode waits for that cleanup to finish.
The console also recovers an expired-session redirect or a saved `/login` page into the same chooser. Subframes,
external sites and stale navigation from a previous server cannot reset the current connection. Browser/mobile web
authentication continues using the web login form.
