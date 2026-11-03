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
Capture target, approval policy, size, format, JPEG quality and avatar hiding are device-wide. Native v3 ignores
stale per-Mate request quality settings. Automatic per-message/periodic captures use the user's explicit sharing
mode; requested looks follow the app approval setting. Changing the global capture target stops an existing share.

## Sharing ownership and avatar toolbar

`desktop/src/capture-sharing.js` owns ephemeral sharing state and one renderer owner. Other windows mirror the
state but never advertise a second server capture owner. Controls in any window send stop/mode changes to the
owner. Closing the owning renderer or losing its server connection revokes consent; settings remain on disk,
sharing consent does not. A server switch does not carry sharing into another origin.

The hover toolbar's screen button opens the selected Mate chat with the same screen/window picker; that picker
allows a single draft screenshot or persistent sharing. Active sharing has a blue button and red dot; pressing
again stops it. Toolbar width includes all seven controls, independently of a small avatar's width. The tray
also exposes screen sharing so capture can be cancelled while app windows are temporarily hidden.

## Cancellation boundary

Picker Cancel, Escape and backdrop close invalidate its local operation and cancel its native request id. A late
native result cannot invoke the attachment callback. Native cancel restores hidden windows immediately even if
the OS capture promise has not returned yet; the result is discarded when it does. A new native capture waits
for that OS operation to settle, preventing overlapping capture operations.

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
