# Mate automatic conversation

See [Project Geny parity and verification](mate-proactive-parity.md) for the source-port mapping.
The previous capture-interval → forced model reply implementation has been replaced by the original Geny
Thinking Trigger policy, preset schema, 15 categories, 35 prompts and silence protocol.

Mate settings → Reach out controls opt-in, `all` (full Geny) or `screen` scope, frame-collection cadence,
optional guidance and an editable preset. Frame cadence is not speaking cadence. Rule edits apply through the
existing mates.changed feed; settings require no engine-specific name/grammar rewriting.

A source is shared explicitly on each device. Collection immediately refreshes a temporary frame cache, then
runs periodically. Only the backend trigger owner selects situations and starts autonomous turns. Unchanged
screens skip the screen model call; [SILENT] suppresses display and TTS. Stop revokes screen access and deletes
unused cached frames. Full Geny scope can still produce non-screen idle/time messages while enabled; choose
screen-only scope or disable Reach out to limit that.

Geny timing, weights, cooldowns and prompts can be edited and restored to defaults. The optional Show Now
button is restricted to a device currently sharing that Mate's source and explicitly bypasses the unchanged/
idle gates. It cannot access another computer's screen.
