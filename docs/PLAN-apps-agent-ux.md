# Plan — native apps, download page, Claude-Code-grade agent UX

Status legend: [ ] todo · [~] in progress · [x] done (verified)

## 0. Facts that shape the design (probed on the live runtime, 2026-10-31)

* One `claude --input-format stream-json` process can serve many turns (same
  session id); stdin stays open between turns.
* Background work is first-class in the CLI stream:
  `task_started{task_id, tool_use_id, description, task_type, is_backgrounded}`,
  `task_updated{patch:{status,end_time}}`,
  `task_notification{status, output_file, summary}`,
  `background_tasks_changed{tasks[]}`. Output lands in a file we can read.
* When a background task finishes while idle, Claude **starts a turn on its
  own** to react. The harness must stream those unprompted turns.
* `control_request {subtype: interrupt}` stops the current turn and keeps the
  process (and its background tasks) alive.
* `rate_limit_event` carries live 5h / 7d plan utilization.
* `codex exec` is one-shot per turn (no background tasks, no injection).
* gh CLI is authenticated (repo + workflow scopes); Actions is enabled on the
  private repo. Docker is available locally for Android/Electron test builds.

## 1. Agent core — persistent Claude engine

- [ ] `ClaudeEngine`: one long-lived CLI process per chat (keyed by config:
      model, effort, mode, folders, account, MCP). A single reader pumps every
      line; events go to the active turn, otherwise into an **auto turn**
      (unprompted, e.g. reacting to a finished background task).
- [ ] Turn = write user message → events until `result`. Steering = write more
      user messages (unchanged contract). Stop = `interrupt` control request,
      kill only as a fallback.
- [ ] Lifecycle: idle reaper (no turn, no running task for N minutes), respawn
      with `--resume` on config change, clean shutdown on session delete.
- [ ] Codex stays one-shot `exec` per turn.

## 2. Background tasks (Claude Code parity)

- [ ] `bg_tasks` table + live `task.update` events (started/updated/notification).
- [ ] Background-tasks drawer: running / completed, grouped by turn, live
      elapsed, status, output viewer (tail of the output file), stop.
- [ ] Inline in the turn: "Started in background: …" rows and completion notes.
- [ ] Auto turns rendered like normal turns with a "triggered by background
      task" label; tab/desktop/mobile notification when they finish.

## 3. Turn UX

- [ ] Exact per-turn file changes from **git snapshots** (temp-index tree before
      and after the turn: catches edits by any engine *and* by shell commands);
      tool-input diffs as fallback outside git.
- [ ] "N files changed +a −b" card at the end of the turn → full diff viewer
      (file list + unified diffs) — "View all".
- [ ] Images the agent reads/creates (tool-result image blocks, screenshots,
      markdown image paths) saved as artifacts, shown inline with lightbox.
- [ ] Tool rows use the agent's own action description (`description` of Bash)
      — "Reseed and rebuild the web app" instead of raw commands.
- [ ] Message actions: copy, retry, relative time. File preview for paths.
- [ ] Live plan usage (5h/7d) from `rate_limit_event`.
- [ ] Notifications when a turn finishes in the background (web / desktop / mobile).

## 4. Mobile-specialized UI (same web app, responsive)

- [ ] < 768px: drawer sidebar, full-screen chat, session panel as a sheet,
      safe-area insets, `100dvh`, 44px touch targets, horizontally scrolling
      chips, sheet-style menus, keyboard-aware composer.
- [ ] Every view (chat, providers, connections, usage, admin, downloads)
      verified at 390×844.

## 5. Native apps

- [ ] **Desktop (Electron, Win/macOS/Linux)**: loads the live console (identical
      design & features, UI updates without reinstalling), persistent login,
      tray, native notifications, external links in the browser, offline
      screen, configurable server URL, single instance, window state,
      update check against the download feed.
- [ ] **Android (Capacitor)**: mobile UI, native notifications, back button,
      status bar/safe areas, file chooser + camera, share-to-app (images/files
      into a chat), update check.
- [ ] Both expose a small `window.hrhNative` bridge (platform, version, notify).

## 6. Release pipeline + Download page

- [ ] GitHub Actions `apps.yml`: on every push to `main` (and manual dispatch)
      build Windows (NSIS), macOS (dmg arm64 + x64), Linux (AppImage + deb),
      Android (signed APK); publish to a rolling `apps-latest` release plus a
      versioned release.
- [ ] Backend `/api/downloads`: latest release metadata (cached), authenticated
      download proxy for the private repo's assets.
- [ ] `/downloads` page: platform auto-detect, version/commit/date/size,
      install notes (unsigned builds), changelog, QR for Android.
- [ ] In-app "new version available" for desktop/mobile shells.

## 7. Review + end-to-end verification

- [ ] Independent code review of existing backend/frontend; fix findings.
- [ ] Live E2E: auth/ban, providers + usage, account pool, SSH workspaces
      (2223/2222/2224), attachments, steering, stop, background tasks, auto
      turns, engine switch context, admin logs, downloads.
- [ ] Screenshots desktop (1440) + mobile (390) of every view.
- [ ] Build each app (Docker locally + CI) and smoke-test the artifacts.
