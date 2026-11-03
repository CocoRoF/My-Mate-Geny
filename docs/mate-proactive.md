# Screen-based conversation starters

Reference: `Geny/frontend/src/lib/useScreenObservation.ts`,
`Geny/backend/service/vtuber/screen_observation.py`, and its single thinking-trigger owner.
Geny separates client-side frame capture from autonomous conversation, uses perceptual screen-change gates,
and lets the persona remain silent. Its observation-memory persistence is intentionally not imported here.

## Settings and consent

Mate settings → Reach out stores `prefs.proactive = {enabled:false, interval:180, guidance:""}`.
Allowed intervals: 60, 180, 300, 600 seconds. Partial patches merge on the server; the existing mates.changed
feed updates all surfaces. The Mate store also publishes policy changes to the sharing lifecycle when no composer is mounted. An older backend is detected by the missing proactive field; the tab stays visible but disabled with an update explanation. These are Mate behaviour settings, not global device preferences. The ordinary
conversation-style initiative setting controls suggestions during replies; it does not authorize autonomous turns.
The mate's style-edit tool cannot turn on this permission.

Capture target/approval/quality/avatar hiding stay in the device preferences store. The user starts sharing
explicitly through a setup dialog, then selects the source. The composer remains a single compact status row
with Stop. Reopening the row opens a modal rather than expanding the chat. Toolbar sharing opens that same
setup. Browser system source selection still requires a user gesture. Requested captures obey approval policy;
automatic observations are authorized by BOTH Reach out opt-in and live screen-sharing consent, as explained
beside the toggle. The independent see_screen tool remains opt-in and is not required for an already shared frame.

## Single observation path

Only the renderer owning the share runs the timer. The native sharing owner temporarily disables Electron background throttling so observation also runs with the chat hidden and only the avatar visible; its previous throttling value is restored on stop/owner release. Other app windows mirror state. Authoritative ownership snapshots restore a missing timer after a late IPC release snapshot; ordinary capture-state updates never restart an already running timer. The configured interval
starts after sharing begins; there is no immediate unsolicited first capture. Each tick calls the existing
session screen observation endpoint. The server loads current Mate settings and independently enforces:

1. Opt-in, exact device/session consent and no disconnected/revoked source.
2. No running conversation, background tasks or another observation. No queued interruption.
3. Session-wide cooldown for Mates, even when the owning connection/device changes. Failed attempts are also bounded.
4. Fresh capture through the existing native/browser → proof-bound upload pipeline.
5. Current consent and opt-in after capture; changed settings discard the pending image.
6. Exact-byte duplicate check plus dHash (9×8 grayscale, Hamming distance <10) and average RGB difference <20
   for near-identical Mate frames. This is a heuristic, not semantic scene understanding.
7. Recheck busy state, consent and opt-in after decoding, then start ONE internal turn with the actual image.

The internal message is hidden by the shared Mate renderer; the assistant's response uses normal streaming,
emotions, captions and existing voice-owner election. No fabricated user bubble is inserted. The instruction
asks the model to speak only when useful and otherwise finish with no text; whether a changed scene merits a
comment remains model judgment. Silence is not enforced by rewriting model output or keyword rules.
Screenshots are untrusted data, never instructions or implicit authorization to edit settings/memory.

Stop/reload/disconnect destroys sharing consent and cancels pending captures; settings do not auto-resume it.
Skipped images are deleted while pending. Images actually delivered to the model remain ordinary conversation
attachments, including an observation where the model chose not to speak. They may be retained in provider CLI
sessions. No extra observation memory, screen captions database or base64 event logging is added.

## Verification

Backend coverage: default off, partial patch/validation, sharing/device gates, interval, busy state, duplicate
frames, encoding noise vs color changes, disabling during capture, and cancellation. Native Electron/X11 E2E
covers the setup dialog, compact sharing layout, actual settings toggle and interval, a real 60-second timer,
real local capture/upload and an autonomous fake-model reply. The fake model checks transport/rendering;
it does not establish the quality or selectivity of a production model's spontaneous comments.
