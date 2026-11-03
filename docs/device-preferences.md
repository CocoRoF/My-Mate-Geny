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

The same version-1 device record now includes `sharing` (enabled, origin, conversation id/name, capture mode,
interval). Screen target, approval and image options remain in `screen`. `screen.proactive_enabled` and
`proactive_interval` are initialized once from the active legacy Mate and thereafter edited locally; character
situation rules, guidance and the per-Mate screen-tool permission remain server-side. Other voice fields do not move.
The client advertises its effective reach-out policy on its live session-list connection; the backend does not
persist it or apply another device's override.

A reload, renderer closure, network disconnect or app shutdown releases runtime ownership and pending requests,
without forgetting explicit intent. An explicit Stop stores disabled. Each native restore must acquire an
app-process lease for the saved server origin; a late restore cannot undo Stop. No startup dialog or persistent
sharing banner is added. A screen id can be recovered by display id; a window by one unambiguous exact title.
A missing source/conversation, macOS permission denial, or required Wayland portal switches intent off with one
floating toast, never substituting another screen. Network/authentication errors retain intent for reconnection.
Browser settings persist, but `getDisplayMedia` cannot resume without user activation; one browser owner lock
prevents a second tab from revoking a live owner, and a reload with no owner disables sharing with a toast.

Old saved volume/source/quality values and migration archives are preserved. Old versions never saved sharing
on/off or capture mode, so a fresh upgrade has no old persistent intent to infer: sharing must be enabled once
in the new version. Invalid fields recover safe defaults; a corrupt source disables persistent intent.

Regression: `desktop/test/e2e/sharing-resume-e2e.js` starts from the real UI, restarts the actual Electron app
using the same userData, reloads the renderer, stops/restarts, removes a source and checks one-owner handoff.
