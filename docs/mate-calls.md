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
- That message starts **her own engine's turn** (her usual model and tools) — for every call that was picked up, a word
  from them or not: it reads the whole call (`calls.follow_up_prompt`: `<phone_call caller="user|you" duration="m:ss">`
  with the call as she remembers it — `calls.describe`: who called whom and when, why she called (`reason`, `about`), how
  it went, both sides of what was said — + the rules: the turn is hers — she takes the call in and does what was asked
  with her tools, as for a message; she writes only when they need to hear something (what came of it, a question,
  something she didn't get to say), never a recap of the call; otherwise `[SILENT]` → nothing beyond the card). Picked
  up without a word from them (busy, a tap by mistake), she may send one short message — what she called about, or that
  it's fine — or nothing. The turn waits for one she is in the middle of; what waited for the call (a chat's result)
  comes after it.
- A call nobody picked up (missed, declined, cancelled, failed) is a card only: an internal message (`meta.internal`),
  left out of memory — and no turn of hers.
- **She never forgets a call happened.** Wherever her conversation is retold to her engine — a handoff to a fresh
  session, a catch-up of what happened since her last turn — a call is told as the call it was (`calls.describe`, through
  `SessionService.call_note`), never as the user's words alone, and one nobody picked up too ("[Phone call — You phoned
  them at 2026-11-13 17:02 (…); they didn't pick up (a missed call).]"). A later call's prompt has them the same way
  (`recent`), and a call of hers they turned down or missed is in her next message's `<context>` once (below). (Before,
  a call she made that they picked up without a word was only a card she never saw: asked "why did you call?", she said
  she hadn't.)
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

**She calls like a phone, with the app closed.** There is no push service (FCM) in this app, so the app keeps one line
to the user's own server running in the background — `GenyLinkService` (`mobile/android/…`), a foreground service:

- **The line**: `GET /api/mate-calls/link?device=` (server-sent events, signed in with `Authorization: Bearer` — the
  page's login cookie, handed over by `GenyCallPlugin.link`, kept fresh by the server's sliding cookie on every answer).
  It hears `hello {calls, mate, ring}` (a ring already on comes at once), `call.ring`, `call.update` (every call),
  `policy {calls, mate}` (speaking first switched here) and a `ping` at least every `calls.LINK_PING_S` = 45 s (under a
  proxy's 60 s idle; two missed — 120 s — is a dead line). A dropped line comes back at once when the network does,
  else after 2 s … 5 min; signed out (a stale token) it waits for the page to sign it in again, or tries every 15 min.
- **On the server**: `CallService.link` / `unlink`; `CallService.phones` keeps what each phone's page last said it lets
  her do (speaking first, to whom: `saw()` from its `/ws/sessions` hello, in the setting `call_phones`), so with the page
  gone the link still counts: `phone()` takes an open page first, else a linked phone that lets her. `ring()` and
  `_announce()` reach the links too. Nothing else on the server sees a link (screen sharing, speaking first on a
  screen, the device's presence): only calls.
- **Her ringing** (`CallNotifier`, from the link or the page alike — one ring per call): a call notification
  (`CallStyle.forIncomingCall`: her face — the page hands over each mate's, `mate/call/faces.ts` — her name, **거절** /
  **받기**), the "Calls" channel's ringtone, insistent, a full-screen intent that brings the app up over the lock screen.
  While the app is in front and unlocked the page rings itself instead (never both: `ring` says whether the phone rings).
  **거절** is done without opening the app (`CallActionReceiver` → `…/decline`); **받기** opens the app and tells the
  server at once (`…/answering`: the ring holds another `RING_S` so it isn't missed while the app comes up), and the
  page, even one started just for it, takes the call. A call of hers nobody took leaves **부재중 전화** in the shade.
- **During a call** the service also holds the microphone (foreground service type `microphone`, started while the call
  screen is in front), so the call goes on with the screen locked or another app in front, and shows it: her face, the
  clock, **끊기** (`…/hangup`).
- **Always there**: on unless switched off (Settings → 메이트 → 전화 → 앱을 닫아도 전화 받기); started by the page,
  after a reboot and after an update (`BootReceiver`); gone with a sign-out or another server. Its own notification is
  quiet (a minimum-importance channel) and says how it stands ("서아의 전화를 받을 수 있어요", "먼저 말 걸기가 꺼져 있어
  전화는 오지 않아요", "다시 연결하는 중", "다시 로그인하면…"). The settings section says the same and what the phone
  still has to allow: notifications, full-screen notifications (Android 14+), no battery optimisation (the line lasts).
- Type `specialUse` (Android 14+: the subtype says why — the app has no push service) plus `microphone` in a call;
  permissions `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `FOREGROUND_SERVICE_MICROPHONE`,
  `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK` (a moment awake to ring), `ACCESS_NETWORK_STATE`,
  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.

`GenyCallPlugin` (`mobile/android/…/GenyCallPlugin.java`, registered in `MainActivity`):

- `begin({speaker, id, mate, name})` / `setSpeaker({on})` / `end()`: `MODE_IN_COMMUNICATION` for the call, the
  loudspeaker or the earpiece (`setCommunicationDevice` on Android 12+, `setSpeakerphoneOn` before), the screen kept on
  and over the lock screen; back after. (The WebView opening the mic switches the phone to call mode by itself, often
  turning her down or onto the earpiece: this keeps her where the screen says.) The link holds the microphone meanwhile.
- `ring({id, mate, title, body})` → `{shown}` / `cancelRing({id})`: her ringing (above). Taps come to the page as
  `callAction` (kept until it listens).
- `link({device, faces})` / `status()` / `setBackground({on})` / `openSettings({what})`: the background link.
- Permissions for a call: `USE_FULL_SCREEN_INTENT`, `VIBRATE`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`,
  `POST_NOTIFICATIONS`. An app without the plugin still calls (the page's own ring; no notification).

**Limits**: a phone maker's own battery manager can still stop a background app (some do whatever the app asks); letting
the app skip battery optimisation is the remedy, and the settings section asks for it. In deep sleep the line notices it
dropped only when the phone wakes. Earpiece routing of the WebView's media playback depends on the phone; where it
doesn't follow, "speaker off" is only quieter.

## APIs

- `POST /api/mates/{id}/calls {device}` → `{call, plan}` (409 `code: busy`) · `GET /api/mate-calls/active` →
  `{call | null}` · `POST /api/mate-calls/{cid}/accept {device}` → `{call, plan}` · `…/answering` · `…/decline` ·
  `…/hangup` · `GET /api/mate-calls/link?device=` (the app's background link, above).
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
