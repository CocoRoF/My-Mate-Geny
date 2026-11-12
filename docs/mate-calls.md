# Phone calls with a mate

On a phone (the Android app, or a phone's browser) the Mate view's header has a 📞: it calls her. She answers like
on a phone, you talk, you hang up; what you asked for on the call she does right after it. She can call you too —
rarely, by day, when she has a reason.

## On the call screen

- Full screen, over any view: her round picture and name, **연결 중..** while it rings back (one ring at least), then
  **통화 중 01:23** from her first sound. Her words show as she says them (a caption), yours as they are heard. A soft
  ring around her picture moves with her voice; the mic badge lights while you are heard.
- Big round buttons: **스피커** (loudspeaker / earpiece), **종료** (red), **음소거**. The top corner folds the call into a
  green pill at the top of the page (her picture, the clock, mute, end) so the chat can be read while you talk; tapping
  the pill brings the call back. Android's Back folds it too (it never hangs up).
- Sounds made in the page: the Korean ring-back (440 + 480 Hz, a second on, two off), a click as she picks up, three
  beeps as it ends. The end shows for a moment: **통화 종료 · 03:12**, **연결이 끊겼어요**, **연결할 수 없어요**.
- Her ringing: **전화가 왔어요**, her picture pulsing, her name and why she calls ("물어볼 게 있대요", "맡긴 일 소식이
  있대요", "그냥 목소리가 듣고 싶었대요"), **거절** / **수락**; her ringtone and the phone vibrating.
- The screen stays on during a call. Her chat voice is quiet while she is on the phone, and the composer's mic is the
  call's. Dark and light; on small phones (≤ 360 px wide, short screens) the picture and buttons shrink.
- Code: `frontend/src/components/mate/call/` (`CallLayer` — the screen, the pill, her ringing; `CallButton`;
  `CallCard`), `frontend/src/stores/callStore.ts`, `frontend/src/mate/call/` (`machine.ts` the states, `session.ts`
  the line, `listen.ts` the ears, `vad.ts`, `tones.ts`, `native.ts`).

## Fast and light: the call's engine

A call never runs on her usual model: always **Claude Haiku 5.5** (`claude-haiku-5-5`), with **no tools at all** and a
prompt of its own (`prompt.call_prompt`): who she is, her conversation style, the story and how close they are, how she
feels and her day (a `<context>` block as of the call's start), the core memories plus memories recalled for the chat
lately, the chat lately (16 messages after the last clear; nothing the user deleted, no internal prompts) and the call's
rules (short spoken replies, no markdown or emoji — her emotion tags only, they set her voice and are never read; can't
do anything on the call: "알겠어, 끊고 바로 볼게"). The fastest way there is is picked per call
(`calls.CallService.make_engine`):

1. **An Anthropic API key** — the Anthropic provider's pool (Settings → Providers → Anthropic), else the Claude
   provider's own key, else a pooled Claude account that is an API key: the Messages API streamed straight
   (`calls.ApiEngine`: thinking off, effort low, `max_tokens` 400, the system prompt and the conversation cached).
2. **Else Claude Code** (the signed-in CLI, any pooled account): **one** long-lived `--input-format stream-json` process
   for the whole call (`calls.CliEngine`, the same `ClaudeEngine` as chats): `--model claude-haiku-5-5 --effort low
   --tools "" --mcp-config '{"mcpServers":{}}' --strict-mcp-config --disable-slash-commands --setting-sources local
   --no-session-persistence --system-prompt-file <call prompt>`. Each utterance is one message; a barge-in is an
   `interrupt`. The process starts while it rings, so it is warm when she answers.

Latency, measured on the test host (Claude Code 2.1.311, Haiku 5.5, the call prompt of a built-in mate ≈ 10 000
characters, `.bench`-style runs of the real CLI): her **first answer of a call 1.4 s** to the first text (hidden behind
the ring-back); after that, per utterance, **first text 0.53 – 0.58 s, first finished sentence 0.67 – 0.82 s**. A new
process per utterance would pay the cold 1.4 – 1.9 s every time. The API path was not measured (no key on the test
host); it skips the CLI's own overhead. End of speech → her first sound is then ≈ the pause that ends a sentence
(0.7 s with ElevenLabs realtime on a call; 0.65 s of quiet for the VAD, plus the transcription of a recording) + the first
sentence (≈ 0.7 s) + the first clip of her voice (`/speech`, one sentence). The page measures it on every reply
(`metric`: end of their speech → her first sound); the call keeps the median (`latency` in the call's card and the admin
log line `mate.call`).

## The voice loop (the page)

- **Listening** (`listen.ts`), as the server's plan says (`plan.stt`, from her voice settings):
  - **realtime** — her STT engine is ElevenLabs: Scribe v2 Realtime (`mate/stt/realtime.ts`) with a call's shorter pause
    (`POST /api/mates/{id}/stt/realtime?call=1`: at most `voice.CALL_SILENCE` = 0.7 s), never stopping for quiet.
    Her echo is filtered by text (`echo.ts`); the user's own words while she speaks are a barge-in at once.
  - **record** — a server engine (Whisper, OpenAI, Google, ElevenLabs batch): `vad.ts` cuts the utterances (an adaptive
    noise floor after a short calibration, 90 ms to start, 0.65 s of quiet to end, blips < 260 ms dropped, 300 ms of
    pre-roll; while she speaks it takes 2.2 × louder speech for 240 ms), each goes to `/transcribe` as a WAV; a
    transcript that is just her is dropped.
  - **browser** — Web Speech, continuous (desktop Chrome). The Android WebView has none: then the server's engine for a
    recording if there is one, else the call screen says plainly that speech recognition isn't available here (she can
    still be heard).
- **Her voice** (`session.ts`): her reply streams in as text; each finished sentence goes to her own TTS at once (a queue
  of the call's own, one ahead synthesized while one plays) and becomes the caption. Engine `browser` / `off`, or a
  server engine that isn't set up: the browser's voice; no voice at all on the device: her words show (the screen says
  so).
- **Barge-in**: their own words while she speaks → she stops and the server is told what of the reply was said
  (`barge {rid, heard}`); a VAD start that may be her echo only turns her down until the transcript says. Her next
  message starts "[They talked over you; of what you were saying they heard only: “…”]".
- **Mute** sends silence (the stream stays open: unmuting is instant). **Speaker**: in the Android app the phone's route
  (below); elsewhere "speaker off" only turns her down.
- **The line** `/ws/mate-calls/{id}`; a dropped socket reconnects (0.5, 1.5, 3 s) and gets what it missed of the reply
  again; the server keeps the call `RESUME_S` = 10 s; failing that: **연결이 끊겼어요**, the call ends (what was said is
  kept). A page that comes back (reload) finds her ringing again; a call it was on can't go on without its sound and is
  hung up cleanly.

## During the call she only talks — and acts afterwards

- No tools exist on the call's engine (and a tool call the model tries is never run: the reply ends there, counted in
  the log as `tools_refused`). What she would do on her own waits: delegation results (`MateService._flush`), her own
  messages and screen comments (`trigger/runtime.py`, `device_events.py`, `_life_reach_out`).
- When it ends the call is **one entry in her conversation**: a user message whose text is what the user said on it and
  whose `meta` is `{kind: "call", call: {id, direction, status, duration_s, transcript: [{who, text, cut?}], latency,
  engine, model, …}}`. So her memory extractor (a user message) and recall index see what the user said, and the
  user can delete it like their own words (`hidden_messages`).
- That message starts **her own engine's turn** (her usual model and tools): it reads the whole call
  (`calls.follow_up_prompt`: `<phone_call caller="user|you" duration="m:ss">User: … / <name>: …</phone_call>` + the
  rules: a short "통화 정리" — what they talked about and agreed — then do what was asked with her tools, as for a
  message; nothing to add → a warm line, or `[SILENT]` → nothing beyond the card). The turn waits for one she is in the
  middle of; what waited for the call (a chat's result) comes after it.
- A call nobody spoke on (missed, declined, cancelled, failed, or only her hello) is a card only: an internal message
  (`meta.internal`), left out of handoffs and memory.
- The conversation draws a card: "음성 통화 3:12 · 한채린에게 걸었어요 · 15:02", "부재중 전화", "거절한 전화",
  "취소한 전화", "연결되지 않은 전화"; **대화 내용** unfolds the transcript.

## She calls you

`CallService.consider` (every minute, `CallService.run`) — she calls only when all of these hold:

- a phone app is connected (`/ws/sessions` hello: `native: "android"`, `calls ≥ 1`) and lets her **speak first** there
  (`screen_policy.enabled`: Settings → 메이트 → 먼저 말 걸기, the device's `devicePreferences.screen.proactive_enabled`),
  set to her (or to nobody, and she is the default mate) — no new setting;
- **by day** in the user's time zone (10:00 – 21:00), she isn't asleep (her day), nor furious with them;
- they **aren't chatting**: nothing from them in 15 minutes, no turn of hers running, the device not typing;
- **not too often**: 6 h after a call of hers, doubled for each one in a row they didn't take (12 h, 24 h … at most a
  week); 3 h after any call; no call on;
- **a reason**: a question of hers they never answered (40 min – 8 h ago), news from work she passed on that they
  haven't seen (20 min – 8 h), or missing them (lonely ≥ 0.55 once they are past "new", 0.7 before; then only now and
  then: a chance per minute).

It rings on that phone (`call.ring` to its windows; `call.update` to every window). Unanswered for 30 s it is a missed
call. Her hello is made while it rings (she says why she called), so it comes the moment they pick up.

**Declines matter**: a declined call makes her sad and a little lonely; a missed one lonelier; from the second in a row
she sulks a little (angry, at them) — `state.call_unanswered` with the reasons `declined_call` / `missed_call`. Her next
message's `<context>` tells her once ("At 15:12 you phoned them and they turned the call down. You may mention it once
if it fits…"). A call they take warms her (`call_talked`) and resets the count.

## On Android

`GenyCallPlugin` (`mobile/android/…/GenyCallPlugin.java`, registered in `MainActivity`):

- `begin({speaker})` / `setSpeaker({on})` / `end()`: `MODE_IN_COMMUNICATION` for the call, the loudspeaker or the
  earpiece (`setCommunicationDevice` on Android 12+, `setSpeakerphoneOn` before), the screen kept on; back after. (The
  WebView opening the mic switches the phone to call mode by itself, often turning her down or onto the earpiece: this
  keeps her where the screen says.)
- `ring({id, title, body, accept, decline})` / `cancelRing`: while the app is in the background (or the phone locked),
  her ringing as a call notification — channel "Calls" (ringtone, vibration, high importance), category CALL, insistent,
  a full-screen intent over the lock screen, 수락 / 거절. Taps come to the page as `callAction` (kept until it listens).
- Permissions: `USE_FULL_SCREEN_INTENT`, `VIBRATE` (plus the existing `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`,
  `POST_NOTIFICATIONS`). An app without the plugin still calls (the page's own ring; no notification).

**Limits**: there is no push service (FCM) in this app, so a fully closed app can't ring — she calls only a page that is
alive: the app open, or in the background while Android keeps it (it may freeze a background app after a while; then the
call is missed). Earpiece routing of the WebView's media playback depends on the phone; where it doesn't follow,
"speaker off" is only quieter.

## APIs

- `POST /api/mates/{id}/calls {device}` → `{call, plan}` (409 `code: busy`) · `GET /api/mate-calls/active` →
  `{call | null}` · `POST /api/mate-calls/{cid}/accept {device}` → `{call, plan}` · `…/decline` · `…/hangup`.
- `/ws/mate-calls/{cid}`: client `say {text}`, `barge {rid, heard}`, `metric {rid, first_audio_ms, stt}`, `hangup`,
  `ping`; server `state {call}`, `reply {rid, greeting}`, `delta {rid, text}`, `done {rid, text, ttft_ms}`,
  `ended {reason, call}`, `pong`.
- `/ws/sessions`: `call.ring {call}` (the phone she calls), `call.update {call}` (every window); the hello carries
  `native`, `calls`, `visible`.
- Table `mate_calls` (id, mate, conversation, direction, status `ringing | dialing | active | talked | declined | missed |
  cancelled | failed`, reason, device, times, end reason, engine, transcript, latency, `noted`).
- `plan`: `{stt: {mode: realtime | record | browser, engine, fallback}, tts: {engine}, model}`.

## Tests

- `backend/tests/test_mate_calls.py`: the lifecycle over the line (greeting, a reply, the metric, hang-up → the card
  and her own engine's turn with the whole transcript), a screen connecting mid-reply, barge-in, a dropped line, a call
  nobody spoke on, no tools (the CLI line's flags against the fake CLI, one process, a tool call never run; the API line
  against the fake Anthropic API: no tools, thinking off, effort low, cache), the engine choice, her calls (phone app /
  speak first / her mate, by day, chatting, her reasons), declines and misses (feelings, the cooldown doubling, picking
  up resets), what waits for a call.
- `frontend/test/mate-call.test.ts`: the state machine, the clock, the VAD, the tones.
- `mobile/test/call.test.js`: the plugin registered, its methods and event named as the page calls them, the manifest.
- Browser: `desktop/test/e2e/mate-call-browser.js` (a phone-sized page against `session-rewind-server.py`, the fake CLI
  as every engine): 📞 → ring-back → 통화 중, a reply, the pill, mute / speaker, hang-up → the card and her note; light,
  a 360 × 640 phone, her ringing.
- Not verified here: a real Android phone (audio routing, the call notification over the lock screen, background
  ringing), real speech recognition and her real voice on a call, the API engine's latency.
