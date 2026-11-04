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
4. Local execution picks a real local folder with the OS folder dialog. Server mode keeps server workspace/SSH/Git
   selection. Persist setup completion and start the selected provider/model in that workspace.

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
