# My Mate Geny — Mate design (contract)

hr-harnessor becomes **My Mate Geny**. Everything that exists today (chat
sessions = real coding agents, Explorer, Providers, Usage, …) stays exactly as
it is. On top of it comes the **Mate**: an avatar you talk to. The Mate does not
do the work itself — it is a secretary that **hands work to the chat sessions**
(the workers) the same way the user would, follows up, and reports back.

References studied: `ailism-mate` / `ailism-desktop-mate` (video/photo body,
voice queue, desktop windows), `Geny` / `project-geny-app` (Live2D, emotion
tags, lip-sync, delegation, overlay/quick chat), `geny-audio-services`
(OmniVoice TTS, Whisper STT).

## 0. Naming

- Product name shown everywhere: **My Mate Geny** (short: "Geny").
- Internal identifiers stay (the desktop/Android app id and Java package, the
  `~/.hr-harnessor` state directory, cookie/localStorage keys) so existing
  installs update in place and logins survive.

## 1. Mate model (backend, JSON over `/api/mates`)

```jsonc
{
  "id": "mate_xxx",
  "name": "Estelle",
  "is_default": true,
  "created_at": "…", "updated_at": "…",
  "persona": {              // who she is — the character only (§1a)
    "description": "",      // who she is (free text)
    "personality": "",
    "greeting": "",         // first line when a conversation starts
    "language": "ko",       // reply language (edited in Conversation style; also picks the localized name/greeting)
    "instructions": ""      // extra standing instructions
  },
  "avatar": Avatar,         // §2
  "llm":   { "provider": "claude", "model": "claude-sonnet-5-5", "effort": "low" },   // new mates talk on Sonnet ("" falls back to it too); or "codex" / "gpt-6.1-sol"
  "voice": {
    "auto_read": true,
    "volume": 1.0,          // 0.0 – 3.0 (300 %); see §5 "Volume"
    "tts": { "engine": "browser", "voice": "", "model": "", "speed": 1.0, "profile": "", "language": "" },
    "stt": { "engine": "browser", "model": "", "language": "",
             "auto_send": false, "barge_in": true, "silence": 1.2 }   // the last three: realtime engines (§5)
  },
  "prefs": {                // the conversation style: the only source of how she talks (§1a)
    "user_name": "",
    "address": "",          // what she calls the user ("" = her character's way: defaults.address)
    "self_ref": "",         // how she refers to herself ("" = her character's way)
    "formality": "auto",    // auto (her character's own: defaults.formality) | haeyo | hapsyo | banmal
    "speech_style": "",     // speech habits: rhythm, catchphrases, sample lines
    "length": "normal",     // short | normal | long
    "emotion": 2,           // 0 off · 1 subtle · 2 normal · 3 expressive (prompt + avatar reactions / voice emotion)
    "tone": { "warmth": "auto", "humor": "auto", "initiative": "auto" },   // auto | low | high
    "avoid": "",            // topics to avoid
    "memory": { "recall": "normal", "self_save": true },  // recall: off | light | normal | rich
    "self_edit": "auto",    // may she change it herself: auto | ask (a proposal the user applies) | off
    "defaults": { "formality": "", "address": "", "self_ref": "" }   // her character's own way (bundle data)
  },
  "relation": { "enabled", "paused", "stage", "affinity", "show_indicator", "avatar_mood" },  // read-only summary (§5 below)
  "state": { "label", "level", "top": [{ "emotion", "v", "word", "why" }] },  // how she feels, read-only (app/mate/state.py)
  "screen": {               // may she look at the screen (§4 "Seeing the screen")
    "enabled": false,       // off: see_screen does not exist for her
    "approval": "ask",      // ask (every time, in the desktop app) | allow (without asking)
    "hide_avatar": true,    // the mate windows hide while the picture is taken
    "max_edge": 1920,       // 1280 | 1920 | 2560 | 0 (as captured): the picture's long side at most
    "format": "png", "quality": 85   // png | jpeg (quality 40 – 100)
  },
  "session_id": "sess_…"   // its conversation (sessions row kind="mate"), null until first opened
}
```

- `tts.engine`: `off | browser | openai | elevenlabs | omnivoice | http`
  (`browser` = Web Speech `speechSynthesis`, synthesized in the page; the rest
  are synthesized by the backend). `voice` = provider voice id / OmniVoice
  profile id.
- `stt.engine`: `off | browser | openai | whisper | elevenlabs` (`browser` = Web Speech
  recognition where available; `whisper` = an OpenAI-compatible
  `/v1/audio/transcriptions` server such as geny-audio-services; `elevenlabs` =
  Scribe v2 Realtime, a live transcript while speaking, with the ElevenLabs key of
  Global settings — §5 "Realtime mic"). `stt.auto_send` (default false),
  `stt.barge_in` (default true), `stt.silence` (0.3 – 3 s, default 1.2) shape the
  realtime mic; booleans are checked (400), the pause is clamped.
- Global voice settings (shared by all mates) — `GET/PUT /api/mates/settings`:
  `{ openai_key_set, elevenlabs_key_set, omnivoice_url, whisper_url, http_tts_url, http_tts_key_set }`
  (keys are write-only, stored in the vault). `PUT` body: any of
  `openai_key | elevenlabs_key | http_tts_key` (non-empty string sets, `""`/`null`
  removes, absent keeps) and `omnivoice_url | whisper_url | http_tts_url`
  (`""` clears); returns the GET shape.
- CRUD: `GET /api/mates` (default first; with none yet the backend creates
  **Geny**: no avatar, browser voice, Korean secretary persona),
  `POST /api/mates {name, persona?, avatar?, llm?, voice?, is_default?}`,
  `GET /api/mates/{id}`, `PATCH` (or `PUT`) `/api/mates/{id}`, partial:
  `persona` / `llm` / `voice` (incl. `tts`/`stt`) merge field by field,
  `avatar` is replaced, `is_default: true` moves the default;
  `DELETE /api/mates/{id}` (its conversation and files go too). Validation
  errors are 400 with `detail`. `llm.provider`: `claude | codex` (the engines
  that can run sealed — §3 *Engines*). Changing it without a `model` sets that
  engine's mate default (`claude-sonnet-5-5` / `gpt-6.1-sol`; `""` falls back to
  it too). `llm.effort`: `default|low|medium|high|xhigh|max` (default `low`;
  for Codex the model's reasoning level).
- `prefs` merge field by field like `persona` (unknown keys dropped, enums checked → 400); built-in updates
  touch only the bundled speech habits still as bundled and `defaults` (§1a). Every option changes a line of the
  prompt's How you talk section, and the next message carries a `<settings_update>` note with the new value; the
  recall level is per turn (no restart). A `persona.speech` / `persona.address` sent by an older client or an import
  lands in `prefs.speech_style` / `prefs.address`. The mate's own changes: `GET /api/mates/{id}/style-changes`,
  `POST …/style-changes/{cid}/undo|apply|dismiss` (§1a).
- Memory (docs/mate-memory-affinity.md §4): `GET /api/mates/{id}/memories?q=&kind=&status=active|done|archived|all&sort=created|recent|importance|due`
  → `[{id, text, kind, importance, pinned, due_at, expires_at, status, source, created_at, updated_at,
  last_used_at, use_count, core}]` (`kind`: profile | preference | fact | plan | context; `core`: always in
  the system prompt), `POST {text, kind?, importance?, pinned?, due_at?}` → the memory + `merged` (an
  active one of that kind said the same: updated instead) + `similar`, `PATCH …/memories/{mid}`,
  `DELETE …/memories/{mid}`, `POST …/memories/bulk {ids, action: delete|archive|restore|pin|unpin}`,
  `GET …/memories/stats`, `POST …/memories/preview {text}` → `{core, recalled, level, block}` (the
  Memory tab's Test recall). The mate edits the same memories with its tools (§4).
- Relationship (docs/mate-memory-affinity.md §5): `GET /api/mates/{id}/relation` → stage, affinity,
  earned/warmth stage, next stage needs, stats, milestones, log; `GET /api/mates/{id}/state`: every feeling with its reason
  and what moved them; `PATCH …/relation {enabled?, paused?,
  sensitivity? (0.5–1.5), show_indicator?, avatar_mood?, affinity? (0–100)}`; `POST …/relation/reset
  {mode: zero|recompute}`; `GET …/relation/journal?days=30` (7–90; reads only) → the Relationship panel's
  data: daily end-of-day values, the next stage's needs (earned and warmth), stats, milestones,
  anniversaries, the change log with kinds, the latest memories (docs/mate-memory-affinity.md §6.1).
- Global settings also hold `timezone` (IANA; the console — any screen — fills it from the browser when
  empty; "" = the server's own zone): the mate's clock (`Now:` line), plan dates and relationship days.
  A relationship remembers the zone its days were counted in; when that is no longer the user's (set,
  changed, or first reported — a container counts in UTC until then) it is counted again from the history,
  the user's own value / fresh start and switches kept, and announced.

## 1a. Prompt composition — who she is vs how she talks

The rule (the user's, 2026-11): **how the mate talks and how she addresses the user is decided only in the
conversation style** (대화 방식, `mate.prefs`); the persona is purely the character. She edits her own style the way
she edits her memories, and every source that could fight it is either gone or explicitly ranked below it.

### Audit (what fed the prompt before, and who could write it) — 2026-11-03

| Input | Where | Written by | Conflict found |
|---|---|---|---|
| `persona.description`, `personality` | Who you are | user (Profile), built-in sync, ailism import, studio agent | none (character) |
| `persona.speech` | "Speaking style:" in Who you are | user, built-in sync (the bundles), import (`speech` + examples), studio (`update_mate_draft`) | **the bundles' speech fixed the speech level and the address in free text** — 한채린: "short 존댓말 (해요체) with the user — never 반말 … Call the user “<이름> 님”", "Your catchphrases are *exactly* …" (all 해요체); 에스텔/서아: "반말 throughout — never 존댓말". A `formality` setting had to fight it ("This wins over the speaking style above") and a self-change had nowhere to go |
| `persona.address` | "Call the user …" in Who you are | user (Profile chips), import, studio | a second address source next to the speech text's "<이름> 님" and `prefs.user_name` |
| `persona.instructions` | Standing instructions | user, built-in sync (opening + return lines, interests), import, studio | the bundles' opening / return lines are in her default speech level (해요체 / 반말) under "standing instructions from the user" |
| `persona.greeting` | Greeting (+ the first message) | user, built-in sync / language switch, studio | the line already said; stays at the level it was written in |
| `persona.language` | "Always reply in …" | user (Profile), language switch, studio | none (now shown in Conversation style) |
| `prefs` (user_name, self_ref, formality, length, emotion, tone, avoid, memory) | "## Conversation settings (from the user; they win over your character text)" + the contract's "## How you talk" | user (Style / Profile tabs), studio | two "how you talk" places; `formality: auto` meant "whatever the free text says"; `self_ref` was "In Korean, …" only |
| core memories / recalled memories | What you always know / `<context>` | the mate (`remember`…), user (Memory tab), housekeeping | **a memory could hold a style rule** ("반말로 해 달라고 함") and nothing said which wins; the memory tool descriptions didn't steer style requests away |
| the story | The story you two share | — (fixed text) | she stays in character; what the story never overrides (docs/mate-memory-affinity.md §5.5) |
| relationship guide | Between you and the user | — (the guide for the stage they are at, on/off) | "familiar → more relaxed…" with nothing pinning the speech level; "their settings beat closeness" only |
| how she feels / relationship lines | `<context>` | engine | none |
| screen line | Seeing the screen | Screen tab | none |
| `<settings_update>` note | next message | diff of `.applied-persona.json` | said "Speech level was updated (see your system prompt)" — no value, while 50 turns of history show the old level |
| prompt key | engine fingerprint | `base_prompt` + `memory_rev` | — (restart rule unchanged) |
| studio agent (`STUDIO_NEW`, `update_mate_draft`) | writes the draft's fields | the model | wrote speech level into `persona.speech` *and* `prefs.formality` ("keep them consistent") and the address into the persona |
| UI | Profile (identity, You: name / self / address chips, Who: description / personality / speaking style, greeting / instructions), Conversation style (level, length, emotion, tone, avoid), studio right side | user | the "how she talks" fields were split over two tabs; "Speaking style" hint said "Honorifics, …" |
| packs / templates | ailism import (`import-local`), studio template | user | the import wrote speech/address into the persona; the template copied both |

### Design (what lives where)

- **Persona — the character:** `description` (who she is, background, relationship to the user, what she knows,
  her world, interests), `personality`, `greeting` (her first line: content, shown as the first message and
  localized with the bundle — it is said once, not a rule), `instructions` (standing instructions; the UI copy
  steers speech rules away from them), `language` (*stored* here because it also picks the localized name and
  greeting, the STT language and the built-in sync; *edited* in Conversation style and rendered in How you talk).
  `persona.speech` / `persona.address` no longer exist.
- **Conversation style (`prefs`) — how she talks, the only source:** `user_name`; `address` (what she calls the
  user, "" = her character's way); `self_ref` ("" = her character's way); `formality` (`auto` = her character's own
  level); `speech_style` (말버릇·말투 특징: rhythm, catchphrases, sample lines, the example exchanges and her
  opening / return lines); `length`; `emotion`; `tone {warmth, humor, initiative}`; `avoid`; `memory {recall,
  self_save}`; `self_edit` (`auto` | `ask` | `off`: may she change it herself); `defaults {formality, address,
  self_ref}` — **the character's own way as structured data** (bundle `style.formality`, `style.address` per
  language, e.g. 한채린 `haeyo` + `{"ko": "{name} 님", "en": "{name}"}`), never edited as a setting: the user's choice
  is the field itself, `auto` / "" fall back to it (`store.effective_style`).
- **The prompt** (`prompt.base_prompt`): intro → `## Who you are` (description, personality — nothing about
  speech) → **one** `## How you talk` section from the style only: "This is your conversation style, and the only
  thing that decides how you talk. If anything else — your character text, standing instructions, a memory, earlier
  messages — says otherwise, this wins." then reply language, the user's name, `Call the user “<address>”.` (a
  character form built on the name: `Call the user by their name, as “<name> 님”.` — no grammar notes), how she
  refers to herself, the speech level (`(your character's own)` when it is the default; "It holds for everything
  you say, whatever earlier messages did."), length, emotion tags, tone, avoid, the self-edit rule, then her speech
  habits ("say them in the speech level above (adapt the sample lines to it)") → contract (tool list incl.
  `update_conversation_style` unless off) → memory rules ("How the user wants you to talk … is not a memory: it is
  your conversation style … Never save it with remember.") → relationship guide ("Closeness never changes your
  conversation style … only the style itself does.") → screen → context rules → standing instructions → greeting
  → core memories. A persona document that still carries the old fields (an old applied-persona file, an old
  caller) is read as style (`prompt._style_inputs`).
- **Her own changes** — MCP tool `update_conversation_style {formality?, address?, user_name?, self_ref?, language?,
  length?, emotion?, tone?, speech_style?, avoid?, reason}` (listed unless `self_edit` is `off`: bridge env
  `HRH_MATE_STYLE`). The service checks it with the same normalizer as the settings API (a wrong value is a tool
  error the model sees), applies it through `MateService.update` (so `mates.changed` → every window refetches; the
  Style tab follows while it has no unsaved edits), records it (`mate_style_changes`: `{id, actor, status
  applied|proposed|dismissed|undone, reason, changes {path: {from, to}}, session_id}`), logs it (`mate.style_changed`
  in the admin log) and answers with the change id and the style as it is now. `ask` mode records a **proposal**
  instead (nothing changes until the user presses Apply). The conversation shows a chip — "대화 방식 변경: 말투
  높낮이 → 반말" — with Undo (applied) or Apply / Dismiss (proposed); the Conversation style tab lists her changes with
  the same buttons. Undo puts each field back unless it was changed again since (`skipped`). API: `GET
  /api/mates/{id}/style-changes`, `POST …/style-changes/{cid}/undo|apply|dismiss`.
- **When it takes effect.** In the very reply where she called the tool (its result says "Talk this way from this
  reply on"), and from her next message in the **system prompt**: a style change changes the prompt key, so the
  Claude engine restarts at the next message with `--resume` (same conversation) and the `<settings_update>` note
  spells out the new value ("- Speech level: 반말 in Korean, like a close friend …", "- Call the user “하렴”.");
  Codex reads the changed instructions file at its next turn. Why not a per-turn context line instead: a style
  *overrides* what the conversation did so far — it must sit where a long or compacted history can't outweigh it,
  and repeating it in every message would grow the CLI transcript each turn (the `<context>` block is stored in the
  CLI session). Style changes are rare; the restart happens between turns (no lost context) and costs one process
  start and one uncached prompt. The mate's own `remember` still never restarts anything.
- **One-off requests** ("이번엔 짧게 말해줘") are not settings: the prompt says so and the model just does it.
- **Memories.** The memory tools' descriptions and rules send style preferences to the style. A **read-only hint**
  (`style.memory_flags`, `GET …/memories` → `style_flag {reason: formality|address|speech, conflict, level}`) marks
  active memories that look like style rules (words that name a speech level or a form of address — a small
  bilingual vocabulary next to the settings it describes, used only for this hint; `conflict` = it names another
  level than the style's). The Memory tab offers **Move to Conversation style** (`POST …/memories/{mid}/to-style`:
  the text joins the speech habits, the memory is archived — restorable) or **Keep as a memory** (`…/style-ok`:
  no hint any more). Nothing is moved or deleted automatically.
- **Studio.** `update_mate_draft` writes who she is into `persona` and how she talks into `prefs` (`address`,
  `speech_style`, `formality`…); `persona.speech` / `persona.address` are refused with where they live now. The studio
  prompt says so; its right side has the same split (Profile / Conversation style).
- **Migration** (`MateStore.migrate_style`, at startup before the built-in sync; idempotent; logged as
  `mate.style_migrated`): per mate (drafts too) `persona.address` → `prefs.address` and `persona.speech` →
  `prefs.speech_style`, each only where the style has no such field yet — a value the style already has (an
  address the user cleared included) stays exactly as it is; the old persona document is kept whole in
  `mates.persona_legacy`. Built-ins: `files.upgrade_snapshot` reads an old snapshot's `persona.speech/address` as
  its `style`, so a speech text still as bundled is recognised and replaced by today's bundle text (habits only),
  a user-edited one stays; `prefs.defaults` always follows the bundle (data, not a user setting). The bundle format
  is part of `builtin_hash` (`BUNDLE_FORMAT`), so every built-in is merged once. A page still open from before the
  update sends the old `persona.speech/address` with every save: values equal to the backup are ignored; anything
  else in those old fields (an older client, an ailism import, `POST /api/mates`) is routed into the style
  (`store.split_persona`). The ailism import uses today's layout (`files.ailism_persona(styled=True)`: opening /
  return lines into the speech habits, interests into the description).

### Checked (2026-11-03)

- A copy of the live database (sqlite backup API): 5 mates migrated — the speech text and the (empty or
  “주인님”) address moved into each style, the old persona kept in `persona_legacy`; 한채린 keeps the user's own
  settings exactly (name 장하렴, speech level "auto", no address of her own) and her prompt goes from three places
  naming a speech level (the speech bullets, the Korean line, the settings override) to one; a second start
  changes nothing.
- The real model (claude-sonnet-5-5, this prompt, the real MCP bridge, one `--resume`'d CLI per turn):
  "앞으로 반말로 해" → `update_conversation_style {formality: banmal}`, then 반말 from that reply on; "나를 하렴이라고
  불러" → `{address: 하렴}`, then "하렴"; "이번엔 짧게 말해줘" → a short answer and no tool call.
- Tests: `backend/tests/test_mate_style.py`; browser: `desktop/test/e2e/mate-style-browser.js`.

## 2. Avatar (three kinds + none)

All asset URLs are server-relative: `/api/mates/{id}/assets/<path>`.

```ts
type Avatar =
  | { kind: "none" }
  | { kind: "video"; rig: Rig }          // clip state machine (ailism-mate body)
  | { kind: "photo"; rig: Rig }          // stills only (clips: [])
  | { kind: "live2d"; live2d: Live2D };  // Cubism 4/5 model (Geny)

interface Rig {
  aspect: [number, number];                  // w, h of one frame
  packing?: "stacked-alpha" | "plain";       // video only; stacked-alpha = colour top / alpha bottom (H.264)
  home: string;                              // still of the shared home frame (poster / fallback)
  stills: Record<string, string>;            // neutral, smile, laugh, shy, surprised, sad, worried, thinking, sleepy,
                                             // + mechanics: blink, mouth_half, mouth_open, mouth_o
  clips: { id: string; kind: "idle"|"talk"|"listen"|"think"|"react"|"away";
           emotion?: string; src: string; small?: string; loop?: boolean;
           disabled?: boolean }[];           // disabled: never played, picked or preloaded
  emotions?: Record<string, string[]>;       // emotion -> clip ids (react); several = one at random,
                                             // [] = no clip for that emotion (aliases not tried)
  emotion_stills?: Record<string, string>;   // emotion -> still name ("" = none); never blink/mouth_*
}

interface Live2D {
  model: string;                 // URL of *.model3.json
  scale?: number; x?: number; y?: number;        // kScale / initial shift
  idle_group?: string;           // idle motion group (default "Idle")
  emotions?: Record<string, string | number>;    // emotion -> expression name or index
  emotion_motions?: Record<string, string>;      // emotion -> motion group
  tap_motions?: Record<string, { group: string; index?: number }>;  // hit area -> motion
  hidden_parts?: string[];
}
```

Renderer contract (frontend `src/mate/avatar`): one component

```ts
<MateAvatar avatar={Avatar} name portrait? size="lg"|"sm"
            mood="idle"|"listening"|"thinking"|"talking"|"away"
            react={{ name: string; at: number } | null}   // one-shot emotion
            className? />
```

The speaking level (0..1, ~30/s) comes from the shared voice bridge
`src/mate/voiceBridge.ts` (`start(id) / level(v) / end()` + `attachAudio(el)`),
used by the photo body (mouth stills) and the Live2D body (`ParamMouthOpenY`, RMS smoothing 0.3 /
threshold 0.015 / scale 1.8 as in Geny). Video motion has no audio-event subscription.

- **Video**: ailism-mate `StackedPlayer` (WebGL, two `<video>` slots, preloaded
  Blob URLs, seamless clip switching on the home frame); `plain` packing plays
  the video as-is in a rounded frame. One player per avatar: `MateAvatar` keys
  the body by mate + rig + size, so another mate never reuses (or keeps
  playing) the previous one's player, canvas, videos or Blob URLs. Switching
  is calm: a mood counts only after it held 600 ms (thinking ↔ talking flips
  while a reply streams are ignored). Video receives a separate `videoMood` based only on conversation
  activity; audio start/end/cancel/mute is never its input, directly or through the displayed speaking mood.
  Activity and reactions only preload the next clip. **The video's own ended event is the sole transition
  clock**, always at 1×. The controller repeats loop clips at natural boundaries instead of changing a
  media loop flag in response to events. No force-finish, acceleration or mid-clip seek exists. Pause/resume
  and reused slots restore 1×. Photo/Live2D mouth animation still follows the voice bridge.
- **Clip choice** (`src/mate/avatar/shared.ts`, used by the video body *and*
  the clip editor's trigger preview, so the preview is exactly the stage):
  disabled clips never count. A mood plays a random clip of its kind
  (`moodPool`: talking → talk, listening → listen, thinking → think, away →
  away, idle → idle; none of that kind switched on → the idle clips), not the
  same one twice in a row. An emotion (`clipsFor`): the `emotions` map under the
  emotion, then under the words rigs use for it (emotion.ts aliases, e.g. smile →
  happy); a key with `[]` stops there (no reaction); a key whose clips are all
  disabled is passed over; then the react clips whose `emotion` or id names it.
  Several clips → one at random. The body exposes the clip on screen as
  `data-mate-clip` on its layer.
- **Photo**: ailism-mate `StillBody` (blink 2.5–6 s; mouth stills driven by the
  voice level instead of a random timer); a single photo gets a gentle
  breathing/sway and a level-driven pulse. The still for an emotion (and for the
  moods thinking → "thinking", away → "sleepy"): `emotion_stills` under the
  emotion or an alias ("" = none), else the still named like it.
- **Clip / trigger editor** (Mate settings → Avatar, video/photo): a clip library
  (a card per clip: a thumbnail, hover/tap plays it with the stage's own
  player, its triggers in plain words — "while idle", "while talking", "while
  you type", "while thinking", "when she feels ‹emotion›", "after a long
  silence"); the selected clip's editor (on/off = `disabled`, situation = kind,
  the feelings that play it = membership in `emotions`, its own `emotion`,
  loop, rename/replace/remove); "What plays when" (a button per mood and per
  emotion → the clip(s) the renderer would pick, played in a preview stage, and
  for an emotion: add/remove clips, "No clip", "Automatic" = drop the key);
  "Stills for feelings" (`emotion_stills`). Nothing is stored until Save (PATCH
  avatar; for a built-in that marks it `customized`). Built-ins also get
  **Reset to the bundled version** → `POST /api/mates/{id}/avatar/reset` (below).
- **Live2D**: pixi.js 7 + pixi-live2d-display 0.5 (cubism4) as in Geny's
  `Live2DCanvas`; idle group, expressions/emotion motions, auto-blink, tap
  motions (hit area → group from `tap_motions`, fixing Geny's hard-coded
  `TapBody`), pointer focus inside the canvas.
- **Cubism Core is not bundled** (Live2D licence, see project-geny-app
  `live2d-runtime.ts`). Binding contract:
  - `GET /api/mates/live2d/core` →
    `{installed, installing, size?, source, received?, total?, phase?, error?}`
    (`received`/`total`/`phase` while an install runs; `error` = the last
    install failed and nothing is installed).
  - `POST /api/mates/live2d/core/install` (the user accepted the licence in the
    UI; optional body `{accept_license: true}`, `false` → 400 before anything
    starts) downloads
    `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`
    (env `MATE_LIVE2D_CORE_URL` overrides it, for tests) to
    `<MATES_ROOT>/_runtime/` and **streams NDJSON** (`application/x-ndjson`,
    status 200, one JSON object per line):
    ```
    {"phase":"downloading","received":0,"total":null}
    {"phase":"downloading","received":65536,"total":203772}   … (~every 80 ms)
    {"phase":"verifying"}
    {"phase":"done","installed":true,"size":203772,"source":"https://…"}
    ```
    or, as the last line, `{"phase":"error","error":"…"}` (unreachable CDN,
    HTTP error, > 8 MB, or not the Core script — the check is the same as
    before: 10 KB–8 MB containing `Live2DCubismCore`; a failed install never
    replaces an installed copy). Concurrent requests share one download: a
    second request streams the same progress and the same final line.
  - Served at `GET /api/mates/live2d/core.js` (404 with `Cache-Control:
    no-store` until installed).
  - Frontend: `src/mate/live2dCore.ts` — `markLive2DCoreInstalled()` (the
    settings panel calls it on `done`) dispatches the window event
    `hrh:live2d-core-installed` and tells the app's other windows
    (BroadcastChannel); every Live2D body that showed "runtime not installed"
    retries at once (fresh URL), no reload. That state offers **Open Global
    settings** (`openGlobalSettings("live2d")` → window event
    `hrh:open-global-settings`, which the Mate view turns into
    `useMateStore().openGlobal("live2d")`).

Asset upload / import:
- `POST /api/mates/{id}/assets` (multipart `file`, `path`) → `{path, url, size}`;
  `url` carries `?v=<mtime>`. `path` is relative (no `..`, no hidden parts);
  `pack-*` / `l2d-*` top folders are reserved for imports. Max
  `MATE_ASSET_MAX_MB` (200).
- `GET /api/mates/{id}/assets/<path>`: Range requests (video seeking),
  ETag/Last-Modified; `Cache-Control: immutable` for imported files and URLs
  with `?v=`, `no-cache` otherwise. Only media/JSON types are served as such;
  anything else (HTML, SVG, JS…) is `application/octet-stream`.
- Bundled files: `GET /api/mates/builtin/<key>/<path>`. A mate's JSON names each with
  its version (`?v=<12 hex>`, from the file's time and size, like the ETag;
  `app/mate/asset_versions.py`, a middleware on `/api/mates`): under that URL a file is
  kept for good (`immutable`), and a set redone under the same names is a new URL, so
  nothing anywhere plays an old copy (a browser held one under the older one-day cache
  rule, and showed yesterday's clip). JSON coming back has the version taken off: what is
  stored, and what the bundle sync compares, never carries it. Asked without it, a file is
  asked again every time (`no-cache`, 304 while the same).
- `POST /api/mates/{id}/avatar/import` (multipart `file` = zip) → `{mate, avatar}`
  (the avatar is applied): an ailism-style pack (`rig.json` + files →
  video/photo; `asset:<pack>/<file>` refs are rewritten to asset URLs, refs to
  missing files are dropped; `video` when it has clips) or a Live2D zip (finds
  `*.model3.json`; reads a geny-avatar `avatar-editor.json` sidecar:
  `emotionMap`, `idleMotionGroupName`, `tapMotions`,
  `display.kScale/initialXshift/initialYshift`, top level or under
  `animationConfig`). Emotion names are mapped to the mate tags (`anger`→`angry`,
  `sadness`→`sad`, `surprise`→`surprised`, `happy`/`smirk`→`smile`). A motion
  group named `""` (pixi-live2d-display can't play it) is renamed (`Idle`, else
  `Motion`) in the stored model3.json. Without tap config every hit area gets
  the first non-idle group. Zips are bounded (5000 entries, `MATE_IMPORT_MAX_MB`
  unpacked); `..`/absolute/hidden names and symlinks are refused. Each import
  lands in a fresh `pack-<id>/` or `l2d-<id>/` folder; the one the previous
  avatar used is removed.
- `POST /api/mates/import-local` `{ path, mate_id?, name? }` (file/folder on this
  server) → `{mate, mates, imported: "ailism"|"pack"|"live2d"}`:
  - an ailism content mate (`mates/<key>.json`) **or a whole content folder**
    (every character in it). Everything the author wrote comes along: tagline,
    profile, appearance, background, relationship, knowledge and world →
    `description`; personality; speech + all example exchanges → `speech`;
    greeting (or the opening lines) → `greeting`; the author's note, the opening
    lines, return lines and interests → `instructions`; `{{user}}` filled in.
    Body from `../assets/<key>/rig.json`, else `doc.mate.body`. Voice: an
    ElevenLabs id from `character.voice`, and ailism-desktop-mate's
    `voices/<key>/voice.json` when found next to the content folder (OmniVoice
    `instruct` voice design, or a `ref` clip copied into the mate's assets +
    `ref_text`); the TTS engine itself is left for the user to pick. An ailism
    character already imported (same name) is updated in place.
  - a folder with `rig.json`, or a Live2D model folder (`*.model3.json` up to 3
    levels down; a Geny `model_registry.json` entry is used for tuning when
    there is no sidecar).
  Creates a new mate unless `mate_id` is given (then only its avatar changes).
  The world/character text may say the mate can't touch the user's computer:
  the contract keeps that (it never acts itself) and states that asking the
  chats through its tools is how it helps.

### Avatar Create (making a video avatar with AI)

**New mate** in the mate picker opens the **Mate Create studio** — the creation agent on the left helps define her
concept and fills her settings on the right (highlighted, undo per field; drafts are hidden mates until **Create
mate**), then makes her avatar. **Mate view → Avatar Create** (or Mate settings → Avatar → **Create with AI**) opens
the same studio for an existing mate, with a conversation with the avatar agent separate from the mate's chat: it interviews the user (reference picture, look, 1:1 / 9:16, studio / light,
how many motions — presets minimal 6 / standard 15 (한채린's set) / rich 21 clips, or custom), prices every Higgsfield
job (free quotes) and, only after the user's **Confirm** (enforced by the server, with a hard cap), makes the avatar
exactly the way the built-in mates were made: candidates → the picked one cut out as the base picture → stills that
change only the face → Kling clips that start and end on the base picture → alpha recovered from the known gray →
stacked-alpha encode → loop / alpha checks → an ailism-style pack. The finished avatar plays in the panel; **Apply**
puts it on a mate (the old avatar is backed up and can be restored) or **New mate** creates one. Full contract:
[docs/avatar-create.md](avatar-create.md).

### Built-in mates (shipped with the app)

**Han Chaerin** (한채린, the default on a new install) is bundled in `backend/app/mate/builtin/`, a video mate
(`mates/<key>.json` = the authors' original ailism content, `assets/<key>/` video clips + stills + `rig.json`,
`voices/<key>/voice.json`). Order: `files.BUILTIN_ORDER` (chaerin, then the optional `mao`, see below); the first one created on a
new install is the default — an existing install keeps the user's default.

Bundles no longer shipped (`files.RETIRED_BUILTINS`: Estelle and Seoa) are settled at startup: one nobody ever used is removed; one the
user talked to, taught something or changed stays on as their own mate, with all that is hers but without the bundle's body, whose files
are gone with it.

**Personas are English** (`personas/<key>.json`): everything the authors wrote
(tagline, profile, appearance, background, relationship, knowledge, world,
personality, speech, all example exchanges, opening and return lines,
interests, author's note) written in English, with the character's Korean
speech habits spelled out ("When you speak Korean: … / When you speak
English: …") and the Korean example exchanges / opening / return lines kept
verbatim. Her own speech level and address are structured (`style:
{formality, address: {ko, en}}`), never sentences in the free text (§1a).
`files.compose_persona` makes the persona (who she is: the profile sections +
interests → description, personality, the note → instructions) and
`files.compose_style` the conversation style (speech habits + examples +
opening / return lines → `speech_style`, `style` → `prefs.defaults`). Per language the file has `names` and `greetings`
(`{en, ko}`; the Korean greeting is the author's line) and a `language` (the
bundled reply language: `ko`, as before). The mate contract says "Always reply
in ‹language›, whatever language your instructions are written in". The
default "Geny" persona is English too (`store.DEFAULT_PERSONA`, greeting per
language in `DEFAULT_GREETINGS`).

On startup every bundled character exists as a mate (`builtin: "<key>"`), body
served from `GET /api/mates/builtin/<key>/<file>` (no copy). Name and greeting
follow the mate's reply language (`files.localized`). **Updates merge field by
field** (`files.merge_builtin`): each built-in keeps a snapshot of the bundle it
was last synced from (`mates.builtin_snapshot`: names, greetings, persona
fields, style, avatar); on a new bundle version (`builtin_hash`, covering
`personas/<key>.json` and the bundle format) every persona field, the bundled speech
habits, the name, the greeting and the avatar that still equal the snapshot get the
new version, anything the user changed stays; `prefs.defaults` follows the bundle. The reply language, voice, model, memories and default flag are
never touched. Mates synced before snapshots existed: an unedited one
(`customized` off) counts as entirely bundled; an edited one is compared with
the old bundled persona (`files.legacy_persona` of `mates/<key>.json`) — so the
owner's address/greeting edits stay and the untouched fields become English,
while a Korean-replying mate keeps its Korean name and greeting. The changed
persona restarts the engine (prompt key) and the next message carries the
settings note. `customized` still turns on with the user's first persona/avatar
edit (the profile notice shows only while it's off).

Switching the reply language (PATCH `persona.language`) swaps the name and
greeting for that language's bundled version when they still are bundled ones
(any language's; for a non-built-in, the default Geny greeting) —
`files.localize_patch`; user-written ones stay.

A deleted built-in stays deleted; `POST /api/mates/builtin/restore` brings
them back. `POST /api/mates/{id}/avatar/reset` (built-ins only, else 400)
re-applies the bundled avatar of that key (clip/trigger/still edits undone;
voice/model kept) and turns `customized` off again — with the current bundle
hash recorded — only when the persona is still the bundled one (for the mate's
language); a mate whose persona the user edited keeps `customized`. The
avatar-less "Geny" mate is only created when there is no mate at all.

**Mao (optional, not in the repository).** Live2D's sample model *Niziiro
Mao (PRO)* may not be redistributed (Live2D Free Material License, art. 4.1.1),
so the repository does not ship it. The built-in machinery still supports a
bundled **Live2D** character: an install that adds `assets/mao/` (the model
under `runtime/` plus Live2D's `ReadMe.txt`), `mates/mao.json` and
`personas/mao.json` locally (all three are gitignored) gets Mao as a second
built-in. `assets/<key>/live2d.json` makes a bundle Live2D: the
fields of the Live2D avatar with `model` relative to the folder (validated:
the model and its `.moc3` exist; motion groups named in `idle_group` /
`emotion_motions` / `tap_motions` must exist). Files (nested folders too) are
served from `/api/mates/builtin/<key>/runtime/…`; the body renders once the
Cubism Core is installed. The bundle hash covers nested files. Tests for Mao
run only where it is present. Everyone else imports the sample like any other
Live2D model (next section).

### Using Live2D's free sample models

Live2D publishes free sample models (Mao, Hiyori, Haru, …) that work as mate
bodies. They are not part of My Mate Geny — download them yourself:

1. Open Live2D's sample page, <https://www.live2d.com/en/learn/sample/>, pick
   a model and download it, accepting Live2D's terms (the Free Material
   License Agreement and the Terms of Use for Live2D Cubism Sample Data).
   Read who may use them commercially — larger companies may use them only
   internally.
2. Install the **Live2D runtime** once: Mate → **Global settings → Live2D**,
   accept the Cubism Core licence (the server downloads it from live2d.com).
3. Mate → **Mate settings → Avatar → Import → Upload a zip** with the
   downloaded zip (the importer finds the `*.model3.json` inside), or unpack
   it on the server and enter the folder that contains `*.model3.json` under
   **Folder on the server** (`POST /api/mates/import-local`). To create a new
   mate from it instead: **New mate → Import from the server**.
4. Tune it in the same tab (**Live2D model**): scale and shift, idle motion
   group, and which expression / motion plays for each emotion. Without tap
   settings every hit area plays the first non-idle motion group; a motion
   group with an empty name (Mao has one) is renamed `Idle` / `Motion` on
   import.

**Credit line.** Works that use Live2D sample data must show *"This content
uses sample data owned and copyrighted by Live2D Inc."* — put it wherever you
publish or show the mate (a README, a stream overlay, an app's about page),
keep the model's `ReadMe.txt`, and don't present your work as official
Live2D content. The originals are authoritative; see
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

## 3. Conversation = a session of kind "mate"

- Each mate has one conversation: a `sessions` row with `kind="mate"`,
  `mate_id`, workspace `~/.hr-harnessor/mates/<id>/home` (local).
  `POST /api/mates/{id}/conversation` returns it (creating it) as
  `{mate, session_id, session, running}`; a new conversation starts with the
  persona's greeting as an assistant message (`meta: {internal: true, kind:
  "greeting"}`; the engine knows it from its prompt). `…/conversation/reset`
  starts a fresh context like `/clear` in a chat (history stays, a
  `context.reset` notice marks the cut; 409 while the mate is talking). The
  client streams it with the existing `/api/history/{sid}` + `/ws/chat/{sid}`,
  exactly like a chat.
- `GET /api/sessions` (the Chat sidebar) and every delegation listing **exclude**
  mate sessions; their changes are not announced on `/ws/sessions`.
- Session rows carry `kind` (`chat|mate`) and `mate_id`; history `messages[]`
  carry `meta` (null, or e.g. `{via: {kind: "mate", mate_id, name}}` /
  `{internal: true, kind: "delegation_result", delegations: [...]}`). The live
  `user.message` / `user.steer` events carry the same keys in `data`.
- **Engines.** The session's `provider` follows `mate.llm.provider`; both are
  the same sealed secretary (same prompt, same `mate` tools, same events), the
  system prompt being persona + conversation settings + mate contract + the relationship guide (while it
  is on) + the **core** memories (`app/mate/prompt.py`). Each message is prefixed with a `<context>` block
  (never stored, never a restart): the time now, memories recalled for this message (BM25 over Korean stems /
  bigrams and English words + importance, recency, plans due soon; not repeated within 20 turns of the same
  engine session), the user's memory edits since the last message, and the relationship / mood lines when
  they changed.
  Switching engine (PATCH `llm.provider`) is a chat's engine switch: each engine
  keeps its own CLI session, at the next message the new one gets the
  conversation so far as a handoff (`context.handoff` notice), and going back
  catches the previous one up (`context.catchup`). Reset clears both.
- The system prompt's parts and their single sources: §1a.
- Engine **Claude Code** (persistent like chats, same account pool):
  `--system-prompt-file <persona + mate contract + memories>` with
  `--system-prompt-snapshot off` (so an edited persona reaches the model on
  resume), `--tools ""` (no built-in tools: it can't run code or edit files),
  `--allowedTools mcp__mate`, `--mcp-config <0600 file: mate bridge>
  --strict-mcp-config`, `--disable-slash-commands --setting-sources local` (no
  user CLAUDE.md / hooks / plugins), no wait guide, model/effort from
  `mate.llm`. Editing name/persona/prefs/effort (the mate's own `update_conversation_style` too, §1a), the user's
  edits of core memories, or turning the relationship on/off restarts the engine at the next turn (`--resume`, same conversation); a model
  change is applied live; what the mate `remember`s itself, the user's edits of other memories (told
  in the next `<context>` block) and affinity / mood changes don't restart it.
- Engine **Codex** (`codex exec --json` per turn, resuming the
  thread; same account pool; default model `gpt-6.1-sol`), sealed by
  `app/providers/_codex_sealed.py` (verified against codex 0.166):
  - `CODEX_HOME` = `HOME` = `<id>/codex/` (0700), never the user's `~/.codex`:
    no user config.toml / MCP servers / profiles / hooks, no AGENTS.md, skills,
    plugins, memories or rules. Only the turn's account login is linked in:
    `auth.json` → the account's file (host `~/.codex` or a pooled account's
    CODEX_HOME; codex writes a token refresh through the link), plus
    `auth.lock` when the account has one. The mate's threads live here, so
    `exec resume` works whichever account runs the next turn.
  - `config.toml` (0600, rewritten every turn; the bridge token is in it, not
    in argv): `model_instructions_file` = the prompt file (replaces Codex's base
    instructions; a resumed thread reads a changed file — the CLI then appends
    it as a "replaces the base instructions" message, so while only the mate's
    own `remember`s changed the previous text is kept, same rule as the Claude
    engine's prompt key), only `[mcp_servers.mate]` (tools pre-approved:
    `default_tools_approval_mode = "approve"`), `web_search = "disabled"`,
    `project_doc_max_bytes = 0`, skills/permissions/collaboration/apps
    instructions off, `history.persistence = "none"`, features `shell_tool
    unified_exec shell_snapshot view_image image_generation memories plugins
    apps hooks goals multi_agent multi_agent_v2 browser_use computer_use
    in_app_browser tool_suggest skill_search sleep_tool` off, and as the
    backstop `sandbox_mode = "read-only"` + `approval_policy = "never"` (no
    `--dangerously-bypass-…`).
  - `model_catalog_json` = a copy of the account's `models_cache.json` without
    the tools a model brings itself (`apply_patch_tool_type`, `tool_mode`
    code mode, `multi_agent_version`, tool search, experimental tools). Left
    out when there is no cache (a `codex.sealed` warning notice; the sandbox
    still keeps it from changing anything). The model then sees only the
    `mate` tools (+ Codex's harmless MCP-resource listing tools); asked to run
    `ls` it says it can't.
  - Images go as `--image`, other files inline as for Claude; steering =
    interrupt + resume the sealed thread (normal chats use app-server steering); `-m` / `-c
    model_reasoning_effort` from `mate.llm`.
- **Attachments** work like in a chat: uploads go to
  `POST /api/sessions/{mate sid}/attachments`, the ws `chat` / `steer` messages
  carry their ids, history and live `user.message` / `user.steer` events carry
  them, and the Mate views show them (thumbnails, file cards). The mate can't
  open files (no file tools on either engine), so for a mate session the text block of the
  envelope (`inline_files`, `app/providers/_inline_files.py`) holds, instead of
  paths, an `<attachments>` list with each file's id —
  `- [att_…] name — mime, size — image, shown to you | <how it was read>, included below | <what it is> — not available to you; forward it…`
  — followed by `<file id="att_…" name="…">…</file>` blocks with the readable
  text: text/code/markdown/CSV/JSON… as is (first 256 KB read), docx/pptx/xlsx/
  odt text from their XML (stdlib), PDF text via `pdftotext` (poppler, ≤ 40
  pages) when the server has it; ≤ 20 000 characters per file and 60 000 per
  message, cut with `…[truncated]` and a note. Images still go as inline image
  blocks; anything else (archives, binaries, a scanned PDF) is only described.
- Reply format the prompt asks for: short conversational text in the mate's
  language, no heavy markdown; optional inline emotion tags at the start of a
  sentence: `[neutral] [joy] [smile] [laugh] [shy] [surprised] [sad] [worried]
  [angry] [thinking] [agree] [greet] [sleepy]`. The client strips tags for display and
  speech, and turns the latest one into the avatar's `react`. `worried` is also one of
  her state emotions, which is why she reaches for it; the client takes her other state
  words too (`lonely` → sad, `nervous`/`anxious` → worried, `happy`, `excited`), so no tag
  she writes ever shows as text. A body without a worried clip or still shows sad.
- **Replies: bubbles, captions, speech** (the model may still write markdown,
  and a delegated chat's answer often has some). One reply text, three views:
  - *Bubbles* (`frontend/src/mate/markdown.ts` `segmentReply` →
    `components/mate/MateReply.tsx`, the same in the console Mate view, the mate
    chat window, the quick card's reply box and on phones — compact there): a
    conversational line is its own bubble with inline markdown (bold, italic,
    `code`, links); a block construct — fenced code (language label, copy
    button, lowlight highlighting shared with the agent chat), a list (nested,
    ordered, tasks; indentation capped from the 4th level), a table, a quote,
    a heading, an image on its own line — is one bubble rendered as markdown
    (react-markdown + GFM; `~~` is left as written, Korean writes 좋아~~), a
    `---` a thin divider. Emotion tags (not inside code) and stage-direction
    lines go. Keys = the block's first line, so bubbles never remount while the
    reply streams. Streaming: an unclosed fence is a code block in progress
    (its opening line shows once complete), `**bo` / `*it` / `` `co `` are
    closed for now, a half-typed `[link](…` shows its label, a marker just typed
    is hidden, a table shows complete rows only (its header once the delimiter
    row is there). Code and tables scroll sideways inside their bubble; long
    words / URLs wrap; the page never widens. Raw HTML is shown as text (never
    parsed). Links: absolute `http(s)` / `mailto` only (`safeHref`; anything
    else — `javascript:`, `data:`, relative… — is just its label), opened with
    `target=_blank rel="noopener noreferrer"` (the desktop app sends them to the
    system browser). Images: `http(s)` only, lazy, `max-h-72`, no referrer;
    this server's own files (`/api/mates/*/assets/`,
    `/api/sessions/*/attachments/`) load at once, any other URL only after a
    click ("Show image" — a remote image tells its host the reply was read, a
    prompt-injected reply could leak data through its URL); a broken image
    shows its alt text.
  - *Captions* (stage / overlay) and notifications: plain words (`plainText`,
    `plainPreview`): no markdown symbols, no code, no tables.
  - *Speech* (`mate/sentences.ts` `SentenceStream`, `markdown.ts`
    `speechText`): the scanner runs over the whole reply as it grows. A fenced
    code block or a table (a line starting with `|` + its delimiter row) is
    one silent piece — **never read, no placeholder** (language-neutral; what
    came before it is said at once); nothing else waits for it. No sentence
    ends inside a `code span` or a `[link](…)`. What is said: list marks,
    checkboxes, quote marks, heading marks, emphasis, backticks, HTML tags,
    images, URLs (bare or in links: the label only), emoji, stage directions
    (`*smiles*`, `(웃음)`) and emotion tags removed. Deterministic: sentences
    and their indices depend only on the text, never on how it was chunked
    (an over-long run is cut exactly where char-by-char streaming cuts it,
    never inside a URL that would then be read) — every window numbers them
    the same for the one voice. Plain conversational text is split and said
    exactly as before (regression tests against the previous version). The
    server strips markdown from `…/speech` text too (`voice.speakable_text`;
    nothing left → 400).

## 4. Delegation (MCP server `mate`, stdio bridge → backend internal API)

Tools the mate gets (all others are disabled):

| tool | what |
|---|---|
| `list_sessions()` | chat sessions (not mates): id, title, workspace, provider/model, running, updated_at, last user + assistant snippet |
| `read_session(session_id, limit=10)` | recent messages, running state, current activity |
| `send_to_session(session_id, message, attachments?)` | exactly like the user typing in that chat: idle → starts a turn; running → steers the running turn. Marked `via: {kind:"mate", mate_id, name}` (the chat shows "via <name>") |
| `create_session(workspace_path, message?, title?, provider?, model?, attachments?)` | new chat for a folder (+ first message) |

`attachments` = ids (`att_…`, `[att_…]` accepted) of files **from the mate's
own conversation** (listed in its messages, §3). Each is copied into the
worker session (`<UPLOADS_ROOT>/<worker sid>/<new id>/<name>` + its
model-sized image variant) as a pending upload and sent with the message —
the same envelope as a user message with attachments (image blocks + the
`<attachments>` note with paths for the worker's tools; remote sessions get
their copy on the remote host as usual), shown on the "via ‹mate›" message.
Unknown ids, ids of another session, a missing file or more than
`UPLOAD_MAX_FILES` → a tool error, nothing sent; with `create_session` they
need a `message`. Copies are removed again if the delivery fails. The tool
result says what went (`… with 2 files (shot.png, bug.md)`). `read_session`
lists each message's `files` (names).
| `find_folders(query)` | candidate project folders: workspaces of existing chats, then a bounded search of `/home` (depth ≤ 3, names/git repos) |
| `remember(text, kind?, importance?, due?)` | save a memory (a duplicate of the same kind updates the old one; similar ones are listed); never how she should talk |
| `update_memory(id, text?, kind?, importance?, due?, status?)` | correct / merge / mark a plan done |
| `forget(id, reason?)` / `recall(query, kind?, limit?, include_done?)` | delete one; search all memories |
| `update_conversation_style(formality?, address?, user_name?, self_ref?, language?, length?, emotion?, tone?, speech_style?, avoid?, reason)` | unless `prefs.self_edit` is off: change her own conversation style when the user asks for a lasting change (applied, or proposed with "ask me first"; recorded, undoable — §1a) |
| `feel(emotion, strength, reason)` | say how she feels and why, when it changed noticeably (docs/mate-memory-affinity.md §5.4) |
| `change_outfit(outfit, reason)` | unless `prefs.self_outfit` is off: change her clothes, when she decides to (see "Outfits") |
| `see_screen(reason?)` | only while this device shares the conversation: a picture of the user's screen from their desktop app (below) |

Policy in the prompt: find the chat already working on that project and send
there; if none, find the folder and create a chat; if the folder is unknown or
ambiguous, **ask the user**. Never pretend work was done.

Results: when a turn the mate started/steered finishes, the backend starts a
mate turn with an internal message
`<delegation_result session_id="…" title="…" status="ok|error|stopped">…final answer (trimmed to ~4000 chars)…</delegation_result>`
(several finished chats → several blocks in one message; event/message flag
`internal: true`, `kind: "delegation_result"`, `delegations: [{session_id,
title, status}]`, rendered as a small card, not a user bubble); the mate tells
the user in its own words. Queued while the mate is talking (delivered when its
turn ends). If the chat ended its turn with background tasks still running,
the block says so (`background_tasks="n"`) and the chat's own follow-up turn is
reported once more. Never loops: a mate conversation can't be a target, each
chat reports once per delegation, and after 3 automatic result turns in a row
(no user message in between) further results only appear as a
`mate.delegation_held` notice.

Bridge transport: `app/mate/mcp_bridge.py` (stdio JSON-RPC: `initialize`,
`tools/list`, `tools/call`, `ping`) → `POST /api/internal/mate/call {name,
arguments}` → `{text, is_error}` with header `X-Mate-Token` (random per mate
conversation and backend process). `/api/internal/*` is accepted only from a
loopback peer without proxy headers and with a valid token, never with the
user's cookie (404 / 401 otherwise). `find_folders` searches
`MATE_SEARCH_ROOTS` (default `/home`).

### Seeing the screen (`see_screen`)

The mate runs on the server; pixels come from the user's local device. There is one sharing switch per
installation/browser profile, off until the user enables it. `mate.screen.enabled` is retained only as legacy
archived data and is neither a permission gate nor an extra UI control. `see_screen` is offered when
`CaptureBroker.shared_client(session_id, last_client_device)` grants access to that conversation on that device.
The bridge environment/prompt key changes on the next turn when the live grant changes. Execution rechecks the
grant, so a previously offered tool cannot capture after Stop. An unknown/other device never supplies a fallback.

The native app-lifetime hidden `device-runtime` renderer owns the live grant, WS connection, frame timer and
fallback voice listener independently of visible windows. Device intent lives in the same atomic native settings
record as volume. Closing/reloading windows, app restart/update, disconnect, missing target or permission failure
releases live access and pending requests but keeps ON intent. Only explicit Stop writes OFF. Restoring validates
origin, conversation and source without capturing a picture; no missing window is replaced with a whole screen.
The controller resolves a recreated conversation only for its saved Mate. Unavailable target/permission is a
waiting state with one floating notice, retried without opening a setup dialog. Browsers retain intent but need a
new user gesture for `getDisplayMedia` after the stream ends. See [device preferences](device-preferences.md).

Request routing/upload, unpredictable response proof, source selection and approval share the general
[screen capture pipeline](screen-capture.md). The default per-request approval remains. A capture never hides or
moves Geny windows. One short floating toast appears in one visible window; no persistent composer rows, title
suffixes or tray sharing text exist. The avatar toolbar's active/waiting dot and Screen settings expose Stop.
Completed captures never display a notification: neither agent requests, automatic sampling nor manual captures
produce a success toast. The frontend has no capture-completion listener or fallback notification. Legacy native
completion IPC remains wire-compatible for older servers and is ignored here. Errors/approval prompts use their
own controls; generic floating errors live in `lib/toast.ts`, outside the capture completion path.
Sent images remain normal conversation attachments (including model CLI session retention); transient/failed
captures are deleted and no image bytes are copied into app logs or long-term memory.

## 5. Voice

- `POST /api/mates/{id}/speech` `{text, emotion?}` → audio (cached by content
  hash on disk; header `X-Speech-Cache: hit|miss`); engines openai
  (`gpt-4o-mini-tts` default, voice default `alloy`; emotion → `instructions`) /
  elevenlabs (`voice` required, `eleven_multilingual_v2` default) / omnivoice
  (`/tts`; profile = `tts.profile` or `tts.voice`; emotion →
  `ref_audio_path`/`ref_text` of that emotion's clip, else neutral, else the
  first, resolved through the service's `GET /voices` like Geny's
  `_resolve_emotion_ref`; mate tags map to OmniVoice `joy / sadness / anger /
  surprise / neutral`) / http (OpenAI-shaped `<http_tts_url>/audio/speech`,
  Bearer `http_tts_key` if set). `browser`/`off` → 204 (the page speaks).
  Missing key/URL/voice → 400 with a readable `detail`; the service failing →
  502 with its message. Text ≤ 4000 chars.
- `POST /api/mates/{id}/transcribe[?engine=auto|whisper|openai|elevenlabs]` (multipart `file`, webm/opus from
  MediaRecorder or a WAV, ≤ 25 MB) → `{text, language?, engine}` via openai
  (`gpt-4o-mini-transcribe` default) / whisper
  (`<whisper_url>/v1/audio/transcriptions`, `whisper-1` default) / elevenlabs
  (batch `scribe_v2`, `POST /v1/speech-to-text`); `stt.language`
  (or the persona's) is sent. `browser`/`off` → 400. A mate on ElevenLabs realtime
  (and `?engine=auto`) uses the recording fallback: Whisper → OpenAI → ElevenLabs batch.
- `POST /api/mates/{id}/stt/realtime` → `{url, model, sample_rate: 16000, language,
  commit_strategy: "vad", silence, expires_in: 900, fallback}`: a **single-use token**
  (`POST /v1/single-use-token/realtime_scribe` with the key, server side) inside the
  `wss://…/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&token=…&audio_format=pcm_16000&commit_strategy=vad&vad_silence_threshold_secs=<silence>&language_code=<lang>`
  URL the page opens itself. The key never leaves the server and is never logged
  (an upstream error that quotes it is redacted); every (re)connect asks for a new
  token (consumed on connect, 15 min to use it; ≤ 20 per mate and minute → 429).
  Failing: 400 / 429 / 502 `{detail, code, fallback}` — `code`: `missing` (no key) ·
  `auth` (rejected / no speech-to-text permission) · `quota` (credits; ElevenLabs
  answers 401 `quota_exceeded`) · `busy` · `network` · `upstream`; `fallback`: the
  engine that can transcribe a recording instead (ElevenLabs batch is not offered
  for `auth` / `quota` / `missing`).
- `GET /api/mates/voices?engine=…` → `{engine, voices: [{id, name, language?, …}]}`:
  openai fixed list; elevenlabs via its API (key needed; `preview_url`);
  omnivoice via `/voices` (`emotions` = the profile's reference clips);
  `browser`/`http` → `[]` (the page lists its own).
- Providers (Global settings): `GET /api/mates/providers[?refresh=1]` →
  `{tts: [...], stt: [...]}`, each `{engine, label, kind, configured, ok, error,
  detail, checked_at}` (engines `openai` (TTS+STT, one key) / `elevenlabs` (TTS + realtime STT, one key) /
  `omnivoice` / `http` / `whisper`). A verification uses only free read calls
  (OpenAI `/models`, ElevenLabs `/voices`, OmniVoice `/health` + `/voices`, an
  OpenAI-compatible server's `/models`, Whisper `/v1/models` else `/health`);
  results are kept in `mate_settings` (`verify:<engine>`), dropped when that
  provider's key/URL changes, re-checked after 30 min or on demand
  (`POST /api/mates/providers/{engine}/verify`). `PUT /api/mates/settings?verify=1`
  checks the changed providers at once and adds `providers` to the answer.
- `GET /api/mates/models?engine=&kind=tts|stt` → `{engine, kind, models: [{id,
  name, description?, languages?}], default, languages?}`: OpenAI's fixed lists,
  ElevenLabs `/v1/models` (`can_do_text_to_speech` only), a self-hosted
  server's `/models` (a Whisper server's first model is then the transcription
  default, e.g. vLLM's `openai/whisper-large-v3`), OmniVoice `languages`.
  `GET /api/mates/voices` items also carry `category`, `labels`, `languages`,
  `previews` (ElevenLabs), `models` (OpenAI), `emotions` (OmniVoice).
- `POST …/speech` may carry `tts` (unsaved voice fields: a settings preview).
  An engine whose key/URL is no longer set answers **204 +
  `X-Speech-Fallback: browser`** + `X-Speech-Fallback-Reason` (the page speaks
  with the browser voice); a configured engine that fails is still 502.
  API bases: `MATE_OPENAI_BASE`, `MATE_ELEVENLABS_BASE` (tests / proxies).
- Volume: `voice.volume` 0.0 – 3.0 (default 1.0; normalized/clamped by the
  backend, non-numbers → 1.0, booleans → 400). The page plays the voice queue's
  audio element through Web Audio: source → AnalyserNode (lip-sync level, taken
  *before* the gain, so the mouth doesn't depend on volume) → GainNode (the
  volume) → DynamicsCompressorNode (transparent at ≤ 100 %; a limiter above:
  threshold −6 dB, ratio 12) → speakers. Until the AudioContext runs (no gesture
  yet) the element plays directly at min(volume, 100 %). The browser engine
  (speechSynthesis) can only do 0–100 % (`utterance.volume`, clamped; the Voice
  tab says so). The Voice tab's slider (0–300 %, 100 % marked) is live for
  previews and the voice queue; leaving the tab puts the saved value back.
  `window.__hrhMateAudio` (the page's voice queue) offers `getVolume()` /
  `outputGain()` for checks.
- Settings UI: **Global settings** (voice services, Live2D runtime, desktop app
  per computer, defaults incl. the timezone) vs **Mate settings** (Profile · Conversation style · Avatar ·
  Language model · Voice · Screen · Memory · Relationship · Danger zone); a mate's Voice tab offers only Off,
  the browser and verified providers.
- Client: replies are split into sentences/bubbles (§3 "Replies"), synthesized in order with
  one-ahead prefetch, played through the voice bridge (level → avatar). Mic:
  push-to-talk button (tap to start / tap to stop, or hold); with the realtime engine and
  auto-send also hands-free.

### Realtime mic (ElevenLabs Scribe v2 Realtime)

API facts (ElevenLabs docs, checked 2026-11): `wss://api.elevenlabs.io/v1/speech-to-text/realtime`,
`model_id=scribe_v2_realtime`, auth by `xi-api-key` header or a `token` query parameter from
`POST /v1/single-use-token/realtime_scribe` (15 min, consumed on use); client frames
`{"message_type":"input_audio_chunk","audio_base_64","commit","sample_rate"}` (16-bit LE mono PCM, 0.1 – 1 s
chunks recommended, 16 kHz recommended); server `session_started` · `partial_transcript` · `committed_transcript`
(+ `_with_timestamps` when asked) and errors (`auth_error`, `quota_exceeded`, `rate_limited`, `queue_overflow`,
`resource_exhausted`, `session_time_limit_exceeded`, `input_error`, `chunk_size_exceeded`, `transcriber_error`,
`commit_throttled`, `insufficient_audio_activity`…); `commit_strategy` `manual` (default) or `vad`
(`vad_silence_threshold_secs` 0.192 – 3); a manual commit (`commit: true`, empty audio) also works in VAD mode;
processing starts after ~2 s of audio; the server closes after 15 s without a message; $0.39 per hour of audio
sent (silence included); realtime concurrency 6 (free) … 45.

Page (`frontend/src/mate/stt/`, used by `components/mate/useMic.ts` → `MateComposer`, so the console Mate view,
the mate chat window and the quick card — the overlay has no mic):

- `capture.ts`: `getUserMedia({audio: {echoCancellation, noiseSuppression, autoGainControl, channelCount: 1}})`
  (the same constraints for the recorder engines) → an AudioWorklet tap (from a blob: module; ScriptProcessor
  where worklets are missing) at the device rate; close() stops the tracks, disconnects, closes the context.
- `pcm.ts`: a streaming resampler (box-filter decimation / linear interpolation) → 16 kHz int16, 100 ms chunks,
  base64; a WAV writer for the fallback.
- `realtime.ts` (`RealtimeStt`): token (POST …/stt/realtime) and mic in parallel; audio before
  `session_started` is buffered; partials → the box (after what was typed: `joinText`), committed text → the
  draft (auto-send off) or sent with the box's text (auto-send on, the mic keeps listening). Stop = a manual
  commit, the committed text within 2.5 s (else the last live text). A dropped socket / a retryable error
  (`transcriber_error`, `rate_limited`, the session limit, a close) reconnects with a **fresh token** (400 ms,
  800 ms, 1.6 s), the live text stays on screen and the new session gets the utterance's audio again (since the
  last commit, ≤ 30 s, incl. what was captured meanwhile). After 3 failed tries, or `auth` / `quota` / an input
  error, or no token at the start: the **recording fallback** — the session keeps recording and on stop sends a
  WAV of the audio since the last commit to `/transcribe?engine=<fallback>` (with a notice "Live text unavailable
  (why) — Whisper transcribes when you stop"); no server fallback → Web Speech where the browser has it (a
  notice), else the error in words (key rejected / out of credits / not set up / can't reach). Nothing heard for
  40 s (90 s with auto-send; her speaking and her reply streaming don't count) or ElevenLabs'
  `insufficient_audio_activity` → it stops by itself (billing). The page going to the background (tab hidden,
  Android app sent home, `pagehide`) finishes the utterance and releases the mic.
- **Listening while she speaks** (`echo.ts`, `mate/voiceOwner.ts`): every window says when her audio plays
  (`voicing`, on each start/stop and every second) and what each started sentence says; the mic in any window of
  the device (quick card, chat window, console) knows "she speaks here" (`deviceVoicing`) and what she said
  lately (`recentSpoken`, 20 s). Barge-in **off**: while she speaks (+ a 700 ms tail) the mic sends silence —
  nothing of hers can reach the recognizer. Barge-in **on** (default): audio goes out (echo cancellation removes
  most of her), a transcript that is her words (character-pair overlap ≥ 0.6 with what she said, numbers ignored
  — "1" said / "one" heard) is dropped, and once the user's own words (≥ 4 letters / 2 words, not her) show up
  while she speaks, `hushDevice` stops her voice in whichever window of the device plays it (BroadcastChannel
  `hush`); the rest of that reply is shown, not read. Committed text keeps only the user's words. Why on by
  default: the mic is only open then because the user opened it (or chose hands-free), the user's speech is what
  should win, and the text check means her own voice can't interrupt her even where echo cancellation can't help
  (the browser voice is the OS speaking — no echo reference — and loud phone speakers). A message sent from any
  device still stops her everywhere (as before).
- Settings → Voice: engine "ElevenLabs realtime" (offered once the ElevenLabs provider is verified), language
  (empty = the reply language; sent as `language_code`), auto-send, the pause, barge-in, a cost note. The toggles
  are live-previewed in every window (`livePreview` flags `sttAutoSend` / `sttBargeIn`); saved values reach other
  devices with `mates.changed`. Global settings → Voice services: ElevenLabs is Speaking + Listening.
- Platforms: the desktop app allows audio capture for the server's pages (`setPermissionRequestHandler`, macOS
  `NSMicrophoneUsageDescription`); the Android app's WebView asks through Capacitor's
  `BridgeWebChromeClient.onPermissionRequest` (RECORD_AUDIO + MODIFY_AUDIO_SETTINGS in the manifest — no native
  change); getUserMedia needs a secure page (https, or localhost) everywhere.

## 6. Surfaces

The web console gains a **Mate** item above **Chat** in the sidebar (mate list,
avatar stage, conversation, mic, Mate settings: Profile · Avatar · Language
model · Voice · Memory). Layout as in Geny's VTuber tab: on desktop the avatar
gets half the width (big, bottom-anchored, scaled to the height) and the
conversation the other half; Mate settings / Global settings (header buttons:
sliders = Global, gear = this mate) open over the conversation half, so the
stage never moves or overflows (1280 / 1440 / 1600 px alike). Phones: the stage
on top (36 dvh, collapsible), the conversation below, settings full screen.
Whether the split fits is measured on the main area (`useNarrowerThan`): beside
the sidebar a tablet or a small window gets the phone layout too. On a phone the
header keeps her picture and name, her ring (or the heart when the ring is
hidden: both open the same panel), read aloud and the gear; the rest
(hide the avatar, Avatar Create, Global settings, New conversation) is in one
`more` menu, and a panel takes the header's room, under the status bar (Android's
Back closes it). In settings a long field grows with its text, the Save bar sits
under the form on the bottom edge and only shows with something to save, a choice
of many (`Segmented`) has even columns, what a finger presses is big enough
(`.touch-ui`), and another tab starts at its top. A phone on its side (`max-height:
500px`): the sidebar opens as on a phone, the stage stays beside the conversation
until a panel opens, and nothing goes under the side bar. Checked at 360, 412 and
landscape in `desktop/test/e2e/mate-studio-phone-browser.js`.
**Mate composer** = the Chat composer's machinery
(`src/components/composer/`: `useComposer`, `ComposerParts` (`AttachMenu`,
`QueuedList`, `FileInputs`), `useFileDrop` + `DropOverlay`, `files.ts`
(`filesFromClipboard`)) — the Chat view's `InputBar` uses the same hook — in
the mate's chrome (`MateComposer`): + menu (Photos / Files), paste anywhere on
the page (clipboard images named `pasted-<stamp>.png`), drag & drop over the
conversation, the attachment tray (upload progress, retry, remove,
thumbnails), per-conversation drafts incl. uploaded files (draftStore /
composerStore keyed by the mate's **session id**; `pin(sid)` keeps them from
the chat-list prune; an old `mate:<id>` text draft moves over once), queued
messages, steer while she answers (Enter / ↑ = add to her running turn, Queue
= after it; a bounced steer is queued), Enter / Shift+Enter / touch rules
(`lib/device.ts`), IME-safe Enter, Escape stops her reply (not in the quick
card, where Escape closes it), auto-grow, `/clear` (new conversation) and
`/stop` in a `/` menu (no `@` mentions: a mate has no workspace), plus
push-to-talk (the transcript goes out with the attached files) and the
read-aloud toggle. The quick card's + opens the file picker directly. The
console Mate view, the quick card and the chat window all have it.

Reply reading has one immediate saved switch: `voice.auto_read` for the selected mate.
Voice settings, the console/chat speaker and the native mini-avatar's speaker use
`useReplySpeech`; OFF hushes every playback owner on this device immediately, ON
clears an existing device mute after saving successfully. The separate global
"read on this device" policy still applies. Volume remains device-local. Voice
configuration drafts exclude `auto_read` and volume, so a later Save cannot revert
a speaker toggle made in another window. Failed saves retain the confirmed state
and allow retry; enabling again does not replay a hushed reply.

The native hover bar receives this state only from its selected, same-origin
overlay. Its speaker shows blue/white-dot ON and a crossed speaker OFF, with an
explicit ON/OFF tooltip. Loading, saving and an unconfigured TTS engine disable
the action. The toolbar window has its own clamped width, independent of the
avatar's size; adding the speaker cannot clip it in a small avatar window.

Extra full-page surfaces (no sidebar), used by the desktop app:

- `/?surface=mate-overlay&mate=<id>` — transparent page: avatar + caption
  bubble only; plays the voice. When the window takes the mouse (click-through
  off, or move mode) a drag pans the avatar inside it and the wheel zooms
  (around the pointer), kept per mate in localStorage `hrh.mate.view.<id>`
  (`mate/avatar/view.ts`; video/photo: a CSS transform, Live2D: in its
  renderer). Move mode: a move bar on top (drag = move the window, Reset view,
  Done) and a resize frame (8 handles → `resizeBy`); the page marks
  `<html data-hrh-own-move>` so the desktop app does not make the whole page a
  drag area.
- `/?surface=mate-quick&mate=<id>` — one-line quick chat card: a fixed width;
  the page reports its height only and the window grows downwards (top edge
  fixed) up to 640 px, then the box scrolls; the card is the drag handle
  (`-webkit-app-region`); a draft (text or files) keeps it open when focus
  leaves, with an ✕ in its corner (`setQuickPinned`).
- `/?surface=mate-chat&mate=<id>` — compact mate chat window.

**One voice** (`mate/voiceOwner.ts`). A reply is read aloud on the device
(browser profile; the desktop app's windows are one) that sent the message it
answers — the device id rides in the message's `client_msg_id`
(`…~<device>`), which the server echoes on `user.message`; a turn the mate
starts itself is read where the user last talked from (unknown: here). On that
device the windows showing the mate elect one reader over a BroadcastChannel
(heartbeats 300 ms, gone after 1 s — 75 s for a hidden page, whose timers the
browser throttles — `bye` on close): the window reading a reply keeps it until
it is done; else the overlay while on screen; else the most recently focused
Mate surface on screen (chat window / console Mate view); else one in the
background (hidden tab, minimised window). The quick card
never reads. Every window follows every sentence; the reader announces each
sentence it starts (keyed by the turn's server start time + the sentence's
index), so a window that takes over mid-reply goes on from the next sentence
and nothing is read twice. Mute (localStorage) and the volume apply wherever
it plays.

**Avatar edits show at once** (`mate/livePreview.ts`). While Settings → Avatar
has unsaved changes (a clip switched off, a trigger, a still), the draft is
broadcast to every window of the browser and every avatar (`LiveMateAvatar`:
console stage, mate chat window, overlay, quick card) plays from it — a clip
switched off is cut and never picked again. Saving (or leaving the tab) ends
the preview; the saved avatar then reaches other devices by `mates.changed`.

**Mates stay current in every window.** Every mate write (create / update /
delete / memories / relationship / global voice settings) is announced on `/ws/sessions` as
`{"type": "mates.changed", "data": {"version", "reason", "mate_id"}}` (and
`mates_version` in hello/pong); every window refetches `GET /api/mates`
(coalesced). The Voice tab's unsaved volume previews in every window of the
browser (BroadcastChannel `hrh-mate-preview`) and is dropped when the tab
closes; so does the Conversation style tab's unsaved emotion level (avatar reactions). The Relationship
panel follows `mates.changed` (reason `relation`, sent only when the mate document's summary changed, and
reason `memory`).

## 7. Desktop app (Electron) — Mate only

The main window stays the console (chat with workers as today). New, all about
the Mate: tray menu, the avatar window (transparent, frameless, always on top,
click-through by default, move mode, remembered position/size), a hover action
bar, the quick chat card on a global shortcut (**Ctrl/Cmd+Shift+G**), the mate
chat window, start at login, Linux forced to X11/XWayland. The renderer surface
is the web app (§6), so features update without reinstalling.

Geometry (`desktop/src/geometry.js`, unit-tested): the avatar's resize keeps
an authoritative rect like move-by, the dragged edge stops at the work area,
the size is kept per mate (`settings.json` `mateSizes`; it wins over the page's
suggested size); the quick card opens where it was last dropped
(`mateQuickPos`, pulled onto a live display), else centred under the pointer.
Tray → *Reset Mate position & size* forgets both and the avatar's pan/zoom.

**Never a black window** (`desktop/src/recovery.js`, unit-tested). The console,
the chat window and the quick card show the local retry page (`offline.html`:
reason, Retry, automatic retry after 2 s, 4 s, 8 s … 60 s) when their page
fails to load, its renderer crashes, hangs for 8 s, or — console and chat —
it loaded but `#root` stays empty (an older web build whose code chunk
vanished). The avatar window retries quietly (hidden, backoff; reloaded when
hung). In the page: `index.html` shows a boot screen until React mounts
(reloads once if `/assets/` code fails to load, then offers Reload; the
transparent overlay / quick card show nothing and retry quietly), a root error
boundary (`components/ui/ErrorBoundary.tsx`; per console view too) and
`lib/recover.ts` (a failed dynamic import / `vite:preloadError` reloads once,
guarded by sessionStorage for 30 s, then the Reload screen).
SIGTERM/SIGINT quit properly and DOM storage is flushed on quit and every 15 s.

Bridge (preload → `window.hrhNative.mate`):

```ts
mate?: {
  showAvatar(mateId?: string): Promise<void>; hideAvatar(): Promise<void>;
  setClickThrough(on: boolean): Promise<void>; getState(): Promise<{ visible: boolean; clickThrough: boolean; mateId: string | null; hotkey: string; autostart: boolean }>;
  moveBy(dx: number, dy: number): void; moveEnd(): void; setAvatarSize(w: number, h: number): void;
  resizeBy?(edge: string, dx: number, dy: number): void; resizeEnd?(): void;   // 0.4.1+: move mode's resize frame
  setSize(w: number, h: number): void; setQuickPinned?(on: boolean): void;      // quick card: its height; a draft keeps it open
  openQuick(): Promise<void>; closeQuick(): Promise<void>; openChat(): Promise<void>; openConsole(): Promise<void>;
  setMate(mateId: string): Promise<void>; setHotkey(accel: string): Promise<boolean>; setAutostart(on: boolean): Promise<void>;
  onCommand(cb: (cmd: { type: string; [k: string]: unknown }) => void): () => void;
}
```

**Window chrome** (`desktop/src/chrome.js`). The console and the mate chat
window have no system title bar (Windows / Linux: `frame: false`, still
resizable from the edges, Windows 11 rounds the corners and draws the shadow;
macOS: `titleBarStyle: "hidden"` with the traffic lights). The page draws it —
the console a slim bar (logo · what is open · minimize / maximize-restore /
close, `components/layout/TitleBar.tsx`), the chat window its header (avatar,
status, pin, console, window buttons) — as a `-webkit-app-region: drag` area
(double-click maximizes: the OS does it) and marks `<html data-hrh-chrome>`.
A page that does not (an older web build, the login page, the local connect
/ retry pages, a page still loading) gets a plain bar from the preload until it
does. `HRH_NATIVE_FRAME=1` or settings `"nativeFrame": true` keeps the system
frame. Bridge, present only in those two windows:

```ts
window?: {
  chrome: "custom" | "mac"; kind: "console" | "chat"; initial: { maximized; fullscreen; focused };
  minimize(): void; toggleMaximize(): void; close(): void;
  getState(): Promise<{ maximized: boolean; fullscreen: boolean; focused: boolean }>;
  onState(cb): () => void;
}
```

**Screen capture** (`desktop/src/capture.js`, §4 "Seeing the screen") — `hrhNative.capture` in the server's pages:

```ts
capture?: {
  version: 1;
  info(): Promise<{ version; platform; wayland: boolean; permission: string }>;
  sources(o?: { thumbnails?: boolean; size?: number }): Promise<{ id; name; kind: "screen" | "window"; display_id?; primary?; thumbnail? }[]>;
  getChoice(mateId): Promise<Source | null>; setChoice(mateId, src | null): Promise<boolean>;   // per mate, this computer
  grab(o: { mateId?; sourceId?; maxEdge?; format?; quality?; hideAvatar? }): Promise<Shot>;      // Share screen / test
  request(req: CaptureRequest): Promise<Shot>;   // the mate's see_screen: prompt (unless allowed) → capture
  cancel(id): Promise<void>; openPrivacySettings(): Promise<void>;   // macOS Screen Recording pane
}
// Shot = { ok: true, data: Uint8Array, mime, width, height, source } | { ok: false, code, message? }
```

**Updates** (`desktop/src/updater.js`, desktop/README.md): `hrhNative.updates`
(`getState`, `check`, `download`, `cancel`, `install`, `retry`, `onState`) —
Settings → Updates & Download's update card; the state lives in the app.

**Screens.** The sidebar has **Mate** and **Chat** (+ the chats, and Settings
at the bottom). Everything else is a **Settings tab** (`components/settings/`):
General — Updates & Download, Account, Language, Notifications, Mate & voice,
Desktop app (in the desktop app); Agents & system — Providers, Connections,
Usage, Admin. A wide screen shows the tab list beside the chosen tab; a phone
shows the list, and a tab with a back button. The Settings item (and the
Providers tab) carry the connected-providers count.

**Back / forward** (`frontend/src/lib/nav.ts`, URLs in `lib/navUrl.ts`, all
shells). Every screen change (Mate, a chat, a Settings tab) is a history entry
with its URL (`/?view=settings&tab=usage`, `/?view=chat&session=<id>`, `/`), so
back goes to the previous screen and a reload stays on it; overlays
(`lib/back.ts`) close first — a screen opened from the phone drawer takes over
the drawer's entry. The old screens' URLs (`/?view=usage`, `providers`,
`connections`, `admin`, `downloads` — bookmarks, the desktop app's menu,
notifications, older apps) open their tab (`downloads`: Updates & Download,
scrolled to the downloads).
A guard entry below the first screen keeps back inside the app — never the
login page or the connect screen. `/login` while signed in redirects to `/`,
and a successful sign-in replaces the login page in history. Desktop: the
mouse's back / forward buttons (Windows app-commands → `hrhNative.onNav`),
Alt+← / Alt+→. Android: back = the previous screen; at the first one a second
press within 2 s leaves the app (to the background).

**Startup conversation** (`lib/lastConversation.ts`). A fresh launch at `/`
restores the device's last conversation kind and ID: either the selected Mate
or a coding session. Navigation and successful sends (including the desktop
Mate chat / quick windows and speech) update this local, per-origin record.
Settings, studios, and passive avatar/runtime windows do not replace it;
explicit URLs still take precedence. Deleted targets fall back through the
existing Mate/session list selection. A device with no valid new record keeps
the legacy last-session startup behavior. No server setting or native shell
change is needed. `last-conversation.cjs` exercises full Electron restarts
with the same profile, popup sends, background windows, and deleted targets.

Android (Capacitor): the Mate view runs in-page; microphone permission added.

## 8. Backend notes

- Files under `MATES_ROOT` (default `~/.hr-harnessor/mates`): `<id>/assets/…`,
  `<id>/home/` (engine cwd), `<id>/engine/` (prompt + MCP config files),
  `<id>/codex/` (the Codex engine's sealed CODEX_HOME),
  `_runtime/live2dcubismcore.min.js`, `_cache/tts/`.
- Code: `backend/app/mate/` (`store`, `files`, `prompt`, `service`,
  `mcp_bridge`, `voice`, `netio`: stdlib HTTP, no new dependencies); routers
  `app/routers/mates.py`, `app/routers/mate_internal.py`.

### Reach-out switch

Mate settings → Reach out has one local device ON/OFF switch. The selected Mate and opt-in are stored in the
device record. The fixed situation policy is product-owned; legacy presets/prompts remain archived unchanged
and are ignored by fixed-policy clients. See [automatic conversation](mate-proactive.md).

## Her own day

A mate can live a day of her own on the real clock: where she is, what she is doing, her needs, the plan, story events, gifts
and her journal. All of it is in [docs/mate-life.md](mate-life.md). API: `GET /api/mates/{id}/life` (the Life panel's view),
`PUT /api/mates/{id}/life/plan/{slot}` `{activity}` (a suggestion for one slot of her week, null = up to her),
`POST /api/mates/{id}/life/gift` `{item}`; `prefs.life` (auto, on, off) turns it on or off. Her tool: `do_activity`.

## Reset her memory

**Mate settings → Danger zone → Reset memory** (`POST /api/mates/{id}/memory/wipe {confirm: her name}`) is as if they had never talked: her
memories and all that goes with them, the whole conversation with its attachments, the relationship (a fresh start: outfits her affinity
opened lock again, and she goes back to her default set if she had one on), how she feels now, and the record of how she changed her own
style go, along with the files the engines keep (Claude Code's transcripts for her folder in every login, her Codex home, her compiled
prompts), so nothing can be resumed or read back. She starts over with her greeting, and every open window follows to the new conversation.
Who she is stays: her profile, her conversation style, her avatar and outfits. So do the chats she passed work to.

## Outfits

A mate has a wardrobe, at the top of **Mate settings → Avatar & outfits**: her default set, bundled outfits, and the outfits the user added.
**Add outfit** takes a name and makes an empty place. Everything below in that tab edits the picked
outfit exactly like an avatar (kind, Make it with AI, zip or folder import, stills, clips, triggers), whether she has it on
or not. **Wear** swaps the whole set at once in every window (`mates.changed`); an empty outfit can't be worn yet. Her
default set always stays.

- **Stored** in `mates.outfits`: `{worn, worn_at, base, items: [{id, name, note, feel, avatar}]}`. The `avatar` column is always the set she
  has on, so everything that reads a mate just works; `base` holds her default set while another one is on. What comes off
  keeps the state it was in.
- **Same place, same size**: sets are cut separately, so each picture has its own shape and margins and her face sits elsewhere
  in it. Each set says where her face is (`rig.frame`: `{face: [cx, cy, h], outline, top, how, for}`, in fractions of the picture), and the
  stage always keeps her default set's shape and places any other set so that its face lands on her default face
  (`mate/avatar/framing.ts`), keeping her head on the page and her feet on the bottom edge. The AI pipeline measures every set it
  makes (`pipeline.py export`; `frame <pack>` for a pack made before, as the bundled ones are): a face detector over all her stills,
  taking the median, since one picture can fool it. Anything else (an imported pack, a new picture, sets from before) is
  measured by the server from the picture's outline (`files.framed`, `how: outline`); `for` says which picture it is about, so a new
  picture gets measured again. Faces are compared with faces and outlines with outlines (a measured set has both); what still can't be
  compared only shares her height and her spot. The wardrobe's tiles line up the same way.
- **A change of clothes dissolves** (`mate/avatar/outfitFade.ts`): what she has on fades away, the new set is made ready behind it, then
  it fades in, in every window. Editing the same set, or another mate, goes straight in; `prefers-reduced-motion` skips it.
- **Files**: an outfit's uploads go to `assets/outfits/<id>/` and are removed with it. Imported packs are removed when no set
  uses them any more.
- **Built-ins**: editing an outfit doesn't mark a built-in as customized; editing her default set does. A bundle update or
  Reset goes to her default set (Reset puts it back on). A new avatar from the studio is her new default set, never an
  outfit.
- **Bundled outfits**: `builtin/assets/<key>/outfits.json` lists `{items: [{id, name, note, rig}]}`; `rig` is a relative
  path to a rig pack in the character's asset folder. New entries enter the wardrobe once during built-in sync, without
  changing what she wears. The built-in snapshot remembers which were offered, so updates preserve the user's edits and
  deletions; one she already has follows the bundle where it is still as bundled, and an edited one keeps its edits on the
  bundle's new files when they move to another folder (a replaced pack needs one: built-in files are cached for a day by
  URL). Han Chaerin's **그레이 밴드** uses plain
  gray fabric and white bands without brand names or logos.
- **Unlocks**: an entry may say `"unlock": {"affinity": 60}` (그레이 밴드 does). It is in the wardrobe from the start, but until
  her affinity (rounded) reaches that, its card only carries `locked: {affinity}` and the server answers
  403 to wearing, reading, changing and deleting it, and to opening it in the studio. Once reached it stays open
  (`unlock.at`, set whenever the relationship is saved), however the affinity moves later; **Start over**
  closes it again and she goes back to her default set if she had it on. A value set by hand counts like any other, and word
  of the opening shows over the panel it was set in. The files themselves
  are not hidden: the repository is public, and this is a reward, not a protection.
- **She knows**: while an outfit is on, the per-turn `<context>` says what she has on (it replaces the clothes in her
  profile; no restart, nothing stored). It lists her wardrobe too when that changed since the engine session was last told
  (or every 30 turns), naming what is still closed.
- **It can make her feel something**: an outfit's `feel` ({emotion: strength}, in `outfits.json`) makes that emotion climb for as long
  as she has it on, however she came to wear it, and rises in it are stronger; it fades after she takes it off
  (docs/mate-memory-affinity.md §5.4). Only 크롭탑 has one: that is why she keeps getting shyer in it.
- **She changes herself** (`change_outfit(outfit, reason)`): whether to is hers to decide, from how she feels. There is no
  rule to get past, no count: her `<context>` lists the wardrobe with how she leans on each outfit right now
  (`state.leaning`: how she feels, how close they are, how exposed it is, and asking again wears her down until it angers
  her), and her prompt says yes when it feels right, no in her own words when it doesn't. She may also change unasked when her
  feelings give her a real reason. The tool only holds what isn't up to her: a reason must be given, closed outfits stay
  closed, empty ones can't be worn, and a turn nobody started by talking to her (`meta.internal`: a delegation's result, a
  look at the screen) can't, so text in a chat can't dress her. **Wear** in settings is untouched by all of this.
  `prefs.self_outfit` `off` (the switch under her wardrobe) takes the tool and its rules away, and the tool refuses by
  itself if an engine still has it.
- **API**: `POST /api/mates/{id}/outfits {name}` → `{id, mate}`, `GET …/outfits/{oid}` → `{id, name, avatar}`,
  `POST …/outfits/{oid}/wear` (`default`: her default set), `PATCH …/outfits/{oid} {name?, avatar?}`,
  `DELETE …/outfits/{oid}`; `POST …/avatar/import` and `POST /api/mates/import-local` take `outfit`. A mate document carries
  `outfits` (cards, no avatars).

The project behind Make it with AI: docs/avatar-create.md §12.
