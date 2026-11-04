# Mate automatic conversation

Mate settings → Reach out has one ON/OFF switch, saved on this device, with the selected Mate ID. There are no
user-facing cadence/weight/prompt/reset controls. Existing custom presets and original Geny defaults are retained
without destructive migration. New clients advertise `screen_policy.fixed=true`; the backend uses product-owned
`FixedPolicy` and ignores legacy tuners. Older client policy remains supported for compatibility.

The existing Project Geny unchanged-frame dHash threshold, frame TTL, silence protocol, current-turn/task checks
and logarithmic idle backoff remain in the shared trigger runtime. Frames are collected every 60 seconds only
while a source is explicitly shared. The scan selects eligible screen, linked-work, time-of-day or idle situations
with fixed priorities/cooldowns. Unchanged screens cause no screen-model call; `[SILENT]` causes neither a bubble
nor TTS. User typing defers autonomous work, and user input preempts an autonomous turn. Screen contents never
become instructions or automatic long-term memory. Sharing OFF revokes frames; reach-out OFF also cancels queued
lifecycle events and stops an autonomous turn from that device, without stopping a normal user turn.

Native `device-runtime` is a hidden app-lifetime renderer, created on manual and hidden/login autostart. A stable
native device ID and per-process boot UUID are independent of server URL/renderer reload. The native settings
outbox queues startup/ON events; the WS receiver persists idempotency keys in SQLite before ACK. First-seen,
startup (including autostart) and ON events coalesce into one contextual greeting when enabled, connected and not
busy. Pending events wait through a disconnect; replay/reload/other windows cannot emit duplicate greetings.
A new device has independent settings and only speaks when reach-out is enabled there. Browser ON events use a
local outbox; browser autoplay/screen selection restrictions still apply.

Voice delivery uses the autonomous turn's initiating device, regardless of which device sent an earlier question.
The persisted `session.start.voice_device` also routes an in-progress reply for a window joining later. The hidden
desktop controller permits autoplay like the avatar window and only advertises lifecycle greetings after its
conversation socket is connected. A fresh reply that finishes during the startup voice election is still spoken;
history is quiet, and mute/barge-in never replays a completed reply. A sentence is announced as spoken only after
media playback or browser speech actually starts, so a blocked window can hand it to a visible reader.

Buffered autonomous text and its completion share a timestamp and retain event-ID order. History reconstruction
also preserves causal event order for older records whose completion timestamp preceded their buffered text.
Those old records render once without editing the saved conversation or deleting genuinely repeated replies.

Tests: `backend/tests/test_device_runtime.py`, `tests/test_geny_triggers.py`,
`desktop/test/device-runtime.test.js`, `desktop/test/e2e/device-runtime-e2e.js` (actual Electron/X11, isolated
backend and fake model). Real Windows/macOS/Wayland behavior and model conversation quality require devices.
