# Device preferences: capture and output volume

`desktop/src/device-preferences.js` is the desktop authority. It keeps `settings.json.devicePreferences` under
Electron userData. `hrhNative.device` exposes get/patch/migrate and change notifications. Every app window receives
the same revision through IPC, across server origins. A patch merges against the main process's latest value.
The web/Android fallback uses the same schema in `hrh_device_preferences_v1` localStorage, with storage events,
BroadcastChannel and Web Locks for writes. No preference changes are sent to the server.

Only output **volume (0–3, including zero)** moved out of Mate voice settings. The playback queues and preview
player follow the device value immediately; existing voice-owner election is unchanged. TTS enable, speed,
voice/model/language, STT engine, input device, interruption, auto-send and silence settings stay where they were.
A voice-settings Save omits the legacy `volume` property. Old server values remain as migration sources for old
clients/new devices; new clients never use them after migrating.

## Migration

- Capture source: prefer the desktop's selected Mate's old `captureSources` entry, otherwise the first stored source.
- Volume and capture quality/approval/hiding: prefer the app's selected Mate, then the active Mate supplied by the
  renderer, then the first available Mate. Zero is a valid volume. Existing explicit device edits always win.
- Archive every old source and every Mate's screen/volume values, keyed by server origin and Mate id, in
  `devicePreferences.migration`. The legacy server records and old local source map are not deleted.
- Import settings once. Switching Mate/server or refetching metadata never replaces an established device value.
  Additional legacy alternatives are archived. Recreating the store reads the persisted result.

The **Mate screen-tool enabled flag remains per Mate, off by default**. It is an independent capability gate.
Explicit screenshots/sharing are user actions; enabling sharing does not silently enable a Mate's `see_screen` tool.
Capture target, approval policy, size, format and JPEG quality are device-wide. The legacy avatar-hiding field is retained only for compatibility and is ignored; capture never hides app windows. Native v3 ignores
stale per-Mate request quality settings. Automatic per-message/periodic captures use the user's explicit sharing
mode; requested looks follow the app approval setting. Changing the global capture target stops an existing share.

## Sharing ownership and avatar toolbar

`desktop/src/capture-sharing.js` owns ephemeral sharing state and one renderer owner. Other windows mirror the
state but never advertise a second server capture owner. Controls in any window send stop/mode changes to the
owner. Closing the owning renderer or losing its server connection revokes live access; explicit sharing intent remains
on disk for restoration. A server switch never carries live sharing into another origin.

The hover toolbar's screen button opens the selected Mate chat with the same screen/window picker; that picker
allows a single draft screenshot or persistent sharing. Active sharing has a blue button and red dot; pressing
again stops it. Toolbar width includes all seven controls, independently of a small avatar's width. The Screen settings also expose start/stop. There are no persistent sharing bars in any composer,
window-title suffixes, or tray sharing entries/tooltips. Native capture completion targets one visible app
window; one floating toast fades after 1.2 seconds and is removed after 1.5 seconds. Repeated completion ids
are deduplicated and overlapping toasts are replaced. Older apps use one owner-local fallback toast.

## Cancellation boundary

Picker Cancel, Escape and backdrop close invalidate its local operation and cancel its native request id. A late
native result cannot invoke the attachment callback. Native cancel discards late OS results without changing any app window visibility or focus. A new native capture waits for the prior OS operation to settle.

Requested captures track their upload with a request id and proof. The server validates the pending request both
before saving and after image preparation, tracks created attachment ids and deletes them on denial, cancellation,
timeout or disconnect. Cancel between response delivery and broker consumption also revokes the response.
The renderer aborts in-flight uploads and removes uncommitted attachments. Completed, already accepted images
are ordinary conversation attachments; stopping a later sharing session does not delete prior conversation data.

## Mate streaming layout

`UserBubble` has a full-width row even inside an assistant flow whose children align left. Its own bubble stays
right-aligned with the same 85% maximum as normal user messages. A steering boundary finalizes preceding reply
blocks; subsequent text already becomes a new flow item. Roles, tool events and message text are unchanged.

Tests: `desktop/test/device-preferences.test.js`, `desktop/test/capture.test.js`,
`backend/tests/test_local_screen.py`, `frontend/test/mate-steering.test.ts`,
`desktop/test/e2e/device-settings-e2e.js`. End-to-end tests use an isolated backend and fake model; native capture,
IPC, persistence and rendering are real. Browser contexts verify per-device volume isolation. Windows/macOS/
Wayland permission and native capture behaviour still need real devices.

## Persistent sharing on this device

The version-1 native device record includes `sharing` (enabled, origin, conversation ID/name, optional Mate ID,
mode, interval) and `screen` (source metadata, approval, image options, reach-out ON/OFF and selected Mate).
Volume shares this store/revision/IPC path; other voice options stay in their existing locations. Device edits
save atomically before publication and update all app windows immediately. Browser values use localStorage,
BroadcastChannel/storage events and Web Locks. No server-global screen/volume preference is introduced.

A hidden native app-lifetime renderer is the sole restore owner; visible windows only mirror its runtime.
Autostart without the console, closing all visible windows, app restart/update, page reload and disconnect retain
ON. Explicit Stop alone writes OFF and cancels pending capture/upload/restore. A late restore cannot undo Stop.
Source changes cancel old requests then reconnect to the selected source while retaining ON. Missing source,
permission, authentication or conversation produce waiting state, not implicit OFF or full-screen substitution.
A source is restored by display ID or a single exact window-title match. Corrupt source metadata is marked
invalid, not interpreted as the default primary screen. Invalid fields recover defaults without discarding
other settings. Legacy source/volume alternatives remain in migration archives.

Browser ON intent is retained but a lost display stream needs user activation in the browser picker. It is not
represented as a live screen grant until that succeeds. One browser owner lock prevents two tabs from sharing.

Both Screen settings and the start dialog render the same `DeviceCaptureSettings` component/hook. All quality,
source, approval and capture-mode changes save and apply immediately; Done only closes the dialog. Reach out is
edited only in its one-switch tab. The obsolete per-Mate `screen.enabled` UI/gate has been removed: device
sharing grants the selected conversation access and execution checks the same live grant again.

Regression: `desktop/test/e2e/device-runtime-e2e.js` exercises actual UI, two-window synchronization, native
capture/MCP image delivery, no hide/show flicker, process/page restart, no visible windows, missing/returning
target, hidden autostart, ON/startup event dedupe and explicit OFF persistence. Model calls use a fake CLI.
