# Local screen capture

Screen capture belongs to the user's device, independently of whether the session's workspace lives on this
server or an SSH host. General agent sessions and Mate conversations share one upload/consent pipeline.

Mate-specific autonomous conversation settings are described in [Reach out](mate-proactive.md).

## Entry points

The attachment menu (+ → Share screen), the avatar toolbar's screen button and the chat window's toolbar open one
thing: the picker — the desktop app's screens and windows (All screens too), or in a browser its own
`getDisplayMedia` dialog. There is no setup step: the pick turns sharing on for that conversation (device-local ON
intent and source). Pressed again while sharing: the same picker with Stop, where another pick changes the source
(a browser: a small card, Change / Stop). Only explicit Stop saves OFF; app restart, refresh, update or transient
failures pause access and automatically reconnect when possible. Unavailable targets never silently fall back to
another source. Asking first and the picture's size are set once (Settings → 메이트). See
[device preferences](device-preferences.md).

No persistent sharing banner/chip/row is inserted in any composer or window title/tray; the + menu's item says
when sharing is on. One short capture toast floats over a visible window.

Sharing is always **with each message** (`on_turn`): a fresh screenshot is attached to each device-originated
message, including voice messages and steers. Internal/delegated messages do not cause captures. Failure keeps the
text and shows a warning; no previous image is substituted. While shared, a general agent's MCP call (and her
`see_screen`) also takes a frame, asking first unless the device allows it (native prompt on desktop; timed
application dialog for a browser). A server request never opens the browser's system picker without a user gesture.

The older modes (**when requested**, **periodic observation**) are no longer offered; the server and the desktop app
still accept a share that advertises them (an older page), with their old behaviour (observation: at least 60 s
apart, one in flight, busy sessions skipped, identical bytes discarded). Mates configure speaking first in Reach out.

**Not shared, she can still look once** when asked: her `see_screen` goes to a desktop app window of the device the
user's last message came from — never another computer, nothing when that device is unknown — which captures the
device's chosen source (the primary screen or All screens when that is the choice) through the native approval
prompt unless the device allows it without asking. A browser (or the phone app) without a share can't: the tool
says why ("in the browser, turn on screen sharing first"). General agents' `capture_screen` stays shared-only.

## Transport

1. The owning window advertises `shares: {session_id: mode}` with its existing `/ws/sessions` `client` message.
   Browser capability is advertised only while a stream is live. A disconnected window loses consent server-side.
2. `CaptureBroker.shared_client(sid, device)` routes to the exact device (`client_msg_id` suffix) and a consenting
   connection for that session. Neither shared capture nor legacy Mate routing falls back to another computer.
3. `capture.request` carries scope `session`, session id, request id and an unpredictable response proof. The page
   captures its selected source, uploads to that session's normal attachments endpoint, then POSTs
   `/api/sessions/{sid}/screen/{rid}/result` with the proof and attachment id. The broker validates the session,
   proof and a new image belonging to that session. Expiry, denial, stop and disconnect finish pending requests.
4. `services/screen.py` injects a session-bound `screen` MCP server into general Claude and Codex requests only while sharing is enabled, merging
   SSH tools. `capture_screen` returns MCP image content to the model. The bridge calls loopback-only
   `/api/internal/screen/call` with a per-session token; cookie/public callers cannot use that endpoint. Its config
   lives in a private temporary directory and a 0600 file; the token itself is read from a separate 0600 token file, so neither CLI gets it in argv.
5. Mate `see_screen` uses the same live session/device grant while shared. Not shared, the broker asks a desktop app
   window of that same device (`CaptureBroker.pick`, scope `mate`, answered at `/api/mates/{id}/capture/{rid}`), or
   answers `browser` / `outdated` / `no_app` for her to relay. There is no per-Mate permission switch; she always
   has the tool, so turning sharing on or off never restarts her engine.
6. Per-message images enter the existing provider attachment envelope before the user message is linked/published.
   Claude receives image blocks; Codex receives image paths. Remote workspace uploads use the same existing SSH
   copy path as other attachments. Screenshots always originate on the client, never in the remote workspace.

## All screens

With more than one display the picker and the share settings offer **All screens** (desktop app with capture
bridge ≥ 4; device preference `screen.all_screens`). Every capture then takes each screen as its own picture,
never stitched: the screen in use is `main` — the display where the pointer last moved within ~30 s, else the one
under the pointer, else the primary (`cursor-feed.js createPointerActivity`, sampled only while All screens is
chosen) — the others are `sub`, left to right. One approval covers the set; `max_edge` applies to each picture;
cancellation between pictures delivers nothing; an empty other screen is left out, an empty main one fails.

The server asks for them with `multi: true` (`app/mate/capture.py MULTI_BRIDGE`; the window's `capture` version
decides) and takes at most `MAX_PICTURES`, each uploaded with the request's proof. The page answers
`attachments: [{id, role, source}]` (main first) plus the main `attachment_id`. Her `see_screen` / `capture_screen`
result and a message's attachments list them in that order, labelled "main screen (the one in use)", "other screen
1"… — by role only, nothing looks at the pictures to name them. Observation and the thinking trigger compare one
frame and ask for the main picture only. Back-compat: an older app answers one `attachment_id`; an older server's
request has no `multi`, so the app sends only the main picture in the one-picture shape.

## Privacy and retention

Capture never hides, moves or restores Geny windows. Legacy hiding flags are ignored; the selected visible source is captured directly. Losing the selected source refuses capture instead of substituting a full screen. Browser capture is confined to the stream selected in the system
picker; it cannot hide other applications' windows. The browser stream has no audio track.

Images intentionally sent to the model remain conversation attachments and may also be retained by the model's
CLI/session system, just like manually attached images. They are not copied into app event/log JSON as base64:
`SessionService._screen_result` substitutes attachment references for both Mate and general MCP tool responses.
No automatic memory extraction is introduced; instructions tell the agent not to save screen contents without
an explicit request. This instruction is not a storage sandbox against an agent with general file tools.
Unchanged periodic captures, failed/expired response uploads and screenshots discarded because a session became
busy are removed while still pending. Conversation deletion purges its attachments and drops the bridge token.

## Verification

- `backend/tests/test_local_screen.py`: consent boundaries, response proof, attachments/model input, cancellation,
  message preservation, periodic throttling/deduplication and MCP transport/config merging.
- `backend/tests/test_mate_screen.py`: her tool always offered, routing to the device the user talks from only, a
  look without a share (approval flag, another device never asked, browser / unknown device reasons).
- `frontend/test/local-screen.test.ts`: source/session binding, "with each message" always, stop, in-flight
  cancellation, old bridges, a look without a share following the device's approval and size.
- `desktop/test/capture.test.js`: native capture, permissions, hiding/restoring windows, missing-source refusal and
  all screens (order, one approval, per-picture size, cancellation, the one-picture shape for older servers).
- `backend/tests/test_screen_all_screens.py`: several pictures per request with roles, tool/message order and
  labels, one-picture clients and requests, upload caps.
- `desktop/test/e2e/local-screen-e2e.js`: real Electron/X11 selected-window capture through a general session and
  actual MCP; compares model and attachment hashes, checks on-turn capture; browser stream permission/approval and
  cleanup. Uses a fake model and an isolated backend. Browser picker is replaced by a known canvas stream.

Windows/macOS/Wayland require real-device testing; successful CI packaging is not proof of screen permissions.
All screens on real multi-monitor hardware (display ids, mixed scale factors, the pointer on Wayland) too.
