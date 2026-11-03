# Project Geny automatic conversation parity

This replaces the earlier interval → model-turn implementation. The original runtime is in
`/home/workspace/project_geny_workspace/Geny/backend/service/vtuber/{thinking_trigger,screen_observation}.py`.

## Source policy

- `app/mate/trigger/schemas.py`: original complete trigger-preset schema.
- `defaults.py`: original 15 categories and 35 prompts, only the Python import path changed.
- `policy.py`: original category eligibility, time-window resolution, weighted selection, logarithmic adaptive
  threshold and two-stage category/prompt selection methods. Host lookups (clock, locale, linked worker,
  screen presence, timezone and configured manifest) are injected by the Mate adapter.
- `frame.py`: original Hamming/threshold/TTL helpers, including environment overrides (10/64 and 400 seconds).
- `silence.py`: original executor silence rule (leading cue tags, punctuation tolerance, maximum four tags).
  Autonomous text is held until completion, as Geny's execute-then-deliver flow does; a silence marker never
  reaches persisted text deltas, displayed bubbles or TTS. Normal user-requested streaming is unchanged.

Source SHA-256:

- `schemas.py`: `a7d279469025ce1957f5db726f2f9fb639de01b4f90945768fdd5bb71891cd59`
- `defaults.py`: `d33590d40bbd9b7b804504ab9d0acfb237ad0f96df7e351324228af1765bffe7`

`tests/fixtures/geny_trigger_manifest.json` was produced by importing the ORIGINAL Geny schemas and defaults,
not by serializing the port. Tests compare every field/category/prompt against that source-derived fixture.

## Runtime mapping

| Project Geny | My Mate Geny |
|---|---|
| Immediate frame upload + periodic uploads; uploading does not fire a reply | Owner waits for consent acknowledgement, immediately collects a frame, then collects at the device-selected cadence. Capture options remain device-owned. |
| Recent-frame buffer + screen-active TTL | One private temporary cache artifact per Mate; 400-second TTL; replaced/expired/revoked caches deleted. Restart purges orphaned cache artifacts. |
| Single Thinking Trigger tick, 30 seconds ±2 jitter | One backend `GenyTriggers` lifecycle task; no renderer starts autonomous model turns. |
| User activity resets consecutive triggers | User message/steer and completed non-trigger turn update activity and reset count. |
| Base idle 60 s; max 3600 s; logarithmic scale reaches maximum after 20 consecutive triggers | Original defaults and formula, editable through the original preset schema. |
| Sharing screen ignores adaptive backoff, using base idle threshold | Same. |
| Screen category weight 800, category cooldown 45 s | Same original category and prompt references. |
| Linked worker busy/idle; working category cooldown 90 s, weight 1000 | Active delegations plus persisted latest linked worker. Links survive task completion, allowing idle-worker/activity categories to remain eligible. |
| First/continued/long idle, time-of-day, fun and activity categories | All original categories, consecutive ranges, conditions and weights. Time uses Mate's configured timezone. |
| Category roulette, then prompt roulette, locale fallback and current-time anchor | Original selection/render methods. |
| Unchanged screen skips screen category BEFORE model call | Same dHash/Hamming threshold, compared against last model-viewed frame. No extra RGB heuristic. Mark before dispatch, including silent replies. |
| Live frame preferred, uploaded frame fallback | Consent-bound capture with 2.5 s timeout; valid current-device cache fallback only. Never use another device or revoked share. |
| Show Now bypasses idle/category conditions/cooldown/unchanged checks | Explicit force action takes a current frame and selects a screen prompt directly; busy/offline/permission gates remain. It does not increment the autonomous consecutive counter. |
| Thinking timeout 180 s, activity timeout 600 s | Same request timeout values. |
| Memory warm-up before autonomous execution | Mate's existing engine configuration synchronously loads persona, conversation style, core/recall memories and history before provider execution. There is no separate asynchronous Geny memory-manager warm-up to race. |
| Incoming inbox / already executing; user preemption | Mate running/queued work gates; a new user message interrupts autonomous thinking and is requeued as its own normal turn through the existing rejected-steer protocol. |

The `screen` scope restricts eligible categories to screen categories, honoring the earlier screen-only
permission. `all` uses the full original Geny preset. The switch is off by default. The UI explains that idle/
time triggers in `all` can continue without a screen; no image is captured without explicit live sharing.

## Storage adapter and privacy

Geny's observation-note captioning/indexing and idle memory-compaction jobs are storage bookkeeping, not
trigger selection. My Mate Geny keeps its existing memory system and the user's earlier privacy requirement:
no automatic screen memories or extra caption/index database. A model-used frame is an ordinary conversation
attachment; provider CLI sessions may retain it. Unused frames live only in the bounded recent-frame cache.
The triggering policy and prompt library above are directly ported; storage/execution use current host APIs.

## No application hiding during capture

`capture.js` calls the OS capture API directly. There is no hide/restore callback, compositor-hide delay,
console hiding or avatar hiding. The old flags are ignored even if stored as true. New UI disables the legacy
app preference on load, preserving other migrated settings, so previous native versions also stop hiding
windows after refreshing the UI. The chooser closes as normal UI before a manual shot; app windows remain
visible and in position. Actual Electron tests record application visibility/focus events during manual,
automatic and cancelled captures and assert no capture-induced changes.
