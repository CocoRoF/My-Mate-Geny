# Seven-day usage and speech message drafts

Settings → Usage shows today and the preceding six calendar days in the browser's IANA timezone.
`GET /api/usage/week?tz=Asia/Seoul` reads numeric terminal-event projections with a partial time index.
Session / mate / independently recorded internal-creation calls are separated using `usage_source`, with
historical `sessions.kind` attribution when absent. Tools within a mate turn remain in that turn. There is no
invented allocation of memory/settings tool cost. Titles and IDs support navigation; conversation contents
are never copied into aggregation. The result is not a second ledger and does not modify existing events.

Input + output + cache-read + cache-write tokens define the ratios. Costs use the same TurnCostNormalizer as
history and the session panel. Legacy cumulative Claude costs are primed with preceding terminal events before
slicing the window; existing historical best-effort limits still apply. Codex/unreported costs are unknown,
not zero-priced subscription consumption. These token ratios cannot represent a provider's subscription quota.
Top five is by tokens within its own category. Hover, focus/ArrowDown or tap opens a portal; Escape closes it.

## Parallel speech receipt and response deadlines

All Mate composers use `mate/stt/draft.ts`. Both deadlines start at the latest speech/input activity.
`stt.silence` is the send pause; `continuation_grace` is the response/merge window and must be at least the pause.
With 1.8 s / 4 s the server receives and durably stores the first message at 1.8 s, and starts its response at
4 s. These are parallel deadlines, not 1.8 + 4. A continuation at 3 s extends the same message and sets the new
response deadline to 7 s (four seconds after that continuation). A continuation after the window is a new group.
STT/network delays can delay actual receipt; a recognizer final never starts another full silence timer.

The collector uses mic activity and live partials, sends a provisional partial at the pause if necessary, and
replaces it with the corresponding final in the same group. New pieces update the received user bubble in place.
The response is held until the merge deadline. A different reply already in progress receives the combined
instruction through the existing steer path; a finishing turn becomes a normal next turn without another user
row. A group's original message ID and its chronological boundary are preserved, including replay/history.

The backend `SpeechInput` broker stores accepted content and deadlines in SQLite. WebSocket reconnect replays
pending groups. Client outbox packets remain locally until the matching revision is acknowledged; stale
acknowledgements cannot drop newer text. Revisions/idempotent group IDs prevent duplicate sends across reconnect
and backend restart. Once delivered, the broker clears its duplicate transcript/attachments; the canonical
conversation message remains. A late correction after finalization is kept in the editable draft with a notice,
not silently dropped or substituted into an answer the model already saw. No transcript is printed in logs.

Enter/send forces immediate delivery, including an accepted group (one message). Editing a draft holds automatic
sending until manual send/clear; typing in an open group postpones response release while the user is active.
Stop/reset cancels pending response work while retaining the accepted message. Native Quit cancels recordings
and client timers; accepted server messages survive as in ordinary chat. Model processing time is separate from
the response-release deadline. Voice volume remains device-owned; these fields retain the existing per-mate
listening settings and shared unsaved previews. No native shell change is required.

Tests: `test_speech_input.py` covers persistence, parallel deadlines, revision/ownership, steering, restart and
real WS receipt/force; `speech-draft.test.ts` covers the collector/outbox; `mate-steering.test.ts` covers message
identity/ordering. `speech-parallel.cjs` runs real Electron/Xvfb + the real API/WS against an isolated backend
with fake STT and model responses. `usage-speech.cjs` retains the seven-day Usage UI regression.
