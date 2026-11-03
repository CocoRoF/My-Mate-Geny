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

## Speech drafts

Every Mate composer (console, native chat, quick chat and browser/mobile) shares `mate/stt/draft.ts`.
All recognition engines deliver committed segments there, rather than sending a chat message per segment.
Defaults are merge on, 1.8 seconds of continuation grace (0.5–5), very-short-fragment filter off. Existing
`auto_send` remains the master switch. Off means keep the editable draft. Recognition VAD/silence remains a
separate ElevenLabs setting; its boundary does not decide a chat turn. No language-specific unfinished-sentence
heuristic is used: an arriving partial blocks finalization, and further speech activity restarts the grace.

Whisper/browser recordings hold pending automatic sends while recording or transcribing. Realtime partials
and fresh non-gated audio postpone automatic sending. Finalized pieces join the persistent conversation draft
without forced newlines; substantial whole-word overlap is deduplicated conservatively. Existing Japanese/CJK
joining is retained. No model output/name/grammar correction is involved.

Typing/IME/direct draft edits cancel and hold automatic sending until manual send or clear; further voice can
still append. Enter/send always sends immediately, including a visible partial. The matching later final
transcript consumes that prefix instead of sending it again. A failed manual send retains that partial in the
editable draft; automatic sends that fail connection/uploads retain their text without retrying blindly.
Already-sent text is never retroactively edited: a subsequent utterance becomes a new message, using existing
steer/add-now and bounced-steer queuing while the mate replies. Unmount/Quit cancel timers and never submit an extra last fragment.
Normal microphone Stop finalizes recognition through the same draft policy. Unsent committed text retains existing draft persistence.

New recognition-finalization values live with the mate's current listening settings, including unsaved
cross-window previews and the existing Save flow. No voice setting is relocated; volume alone remains in the
device-owned store from the earlier change. If listening preferences move to devices later, that should be a
separate explicit migration, not a side effect here.

Tests: numeric seven-day/timezone/cost-boundary/source/top-five backend tests; speech draft state-machine tests;
`frontend/test/e2e/usage-speech.cjs` runs real Electron/Xvfb and an isolated backend with synthetic PCM and fake
STT protocol transcripts. It does not verify real ElevenLabs/Whisper recognition accuracy or physical microphones.
