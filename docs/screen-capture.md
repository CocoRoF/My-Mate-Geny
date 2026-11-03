# Local screen capture

Screen capture belongs to the user's device, independently of whether the session's workspace lives on this
server or an SSH host. General agent sessions and Mate conversations share one upload/consent pipeline.

## Entry points

The attachment menu's **Share screen** and the screen row above the composer open the controls.
**Capture once** selects a screen/window and adds a normal image attachment to the draft. It is sent only when
the user sends the draft. **Enable sharing** selects a local source for this conversation. The active source,
conversation and Stop button stay visible while navigating the main console. Standalone Mate chat windows
show the same indicator. Reload, page close, server/socket disconnect, track-ended and Stop end sharing; no
consent is persisted. One window shares one conversation at a time. Desktop session sharing requires capture
bridge v2, to enforce missing-source refusal (apps before v2 can still manually capture and use legacy Mate capture).

Modes (default: ask):

- **When requested**: the agent's MCP call asks permission each time (native prompt on desktop; timed application
  dialog for a browser). A browser must already have a user-selected live `getDisplayMedia` stream. A server
  request never opens the browser's system picker without a user gesture.
- **With each message**: a fresh screenshot is attached to each device-originated message, including voice
  messages and steers. Internal/delegated messages do not cause captures. Failure keeps the text and shows a
  warning; no previous image is substituted.
- **Periodic observation**: 60/180/300/600 second choices; first observation occurs after the selected interval.
  Each changed capture may start a model reply and incur tokens. Busy sessions are skipped, including background
  tasks. The server enforces a minimum of 60 seconds and one observation in flight; identical image bytes are
  discarded and do not start a turn. This is byte equality, not a semantic change detector. No queued observations.

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
5. Mate `see_screen` uses the same broker while preserving existing per-Mate opt-in settings. Explicit sharing
   also enables that tool on the next Mate turn; revoking sharing is checked again when the tool executes.
6. Per-message images enter the existing provider attachment envelope before the user message is linked/published.
   Claude receives image blocks; Codex receives image paths. Remote workspace uploads use the same existing SSH
   copy path as other attachments. Screenshots always originate on the client, never in the remote workspace.

## Privacy and retention

Capture temporarily hides avatar windows on desktop. General shared captures also hide the console to avoid
occlusion on X11 without a compositor, then restore visibility/focus. A selected app window itself is kept visible. Losing the selected source refuses the capture, rather
than replacing it with a whole-screen image. Browser capture is confined to the stream selected in the system
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
- `frontend/test/local-screen.test.ts`: source/session binding, mode/stop, in-flight cancellation and old bridges.
- `desktop/test/capture.test.js`: native capture, permissions, hiding/restoring windows, and missing-source refusal.
- `desktop/test/e2e/local-screen-e2e.js`: real Electron/X11 selected-window capture through a general session and
  actual MCP; compares model and attachment hashes, checks on-turn capture; browser stream permission/approval and
  cleanup. Uses a fake model and an isolated backend. Browser picker is replaced by a known canvas stream.

Windows/macOS/Wayland require real-device testing; successful CI packaging is not proof of screen permissions.
