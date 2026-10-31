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
- Internal identifiers stay (appId `me.hrletsgo.harnessor`, Android package,
  repo/dir names, cookie/localStorage keys, domain) so existing installs update
  in place and logins survive.

## 1. Mate model (backend, JSON over `/api/mates`)

```jsonc
{
  "id": "mate_xxx",
  "name": "Estelle",
  "is_default": true,
  "created_at": "…", "updated_at": "…",
  "persona": {
    "description": "",      // who she is (free text)
    "personality": "",
    "speech": "",           // speaking style, honorifics, catchphrases
    "greeting": "",         // first line when a conversation starts
    "address": "",          // how she calls the user
    "language": "ko",       // reply language
    "instructions": ""      // extra standing instructions
  },
  "avatar": Avatar,         // §2
  "llm":   { "provider": "claude", "model": "", "effort": "low" },   // model "" = catalog default
  "voice": {
    "auto_read": true,
    "tts": { "engine": "browser", "voice": "", "model": "", "speed": 1.0, "profile": "", "language": "" },
    "stt": { "engine": "browser", "model": "", "language": "" }
  },
  "session_id": "sess_…"   // its conversation (sessions row kind="mate"), null until first opened
}
```

- `tts.engine`: `off | browser | openai | elevenlabs | omnivoice | http`
  (`browser` = Web Speech `speechSynthesis`, synthesized in the page; the rest
  are synthesized by the backend). `voice` = provider voice id / OmniVoice
  profile id.
- `stt.engine`: `off | browser | openai | whisper` (`browser` = Web Speech
  recognition where available; `whisper` = an OpenAI-compatible
  `/v1/audio/transcriptions` server such as geny-audio-services).
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
  errors are 400 with `detail`. `llm.provider` is `claude` only (the mate engine
  needs Claude Code's `--system-prompt` / `--tools` / MCP). `llm.effort`:
  `default|low|medium|high|xhigh|max` (default `low`).
- Memory: `GET /api/mates/{id}/memories` → `[{id, text, created_at}]`,
  `POST {text}` → the memory, `DELETE /api/mates/{id}/memories/{mid}`.
  (The mate edits the same list with its `remember` / `forget` tools.)

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
  stills: Record<string, string>;            // neutral, smile, laugh, shy, surprised, sad, thinking, sleepy,
                                             // + mechanics: blink, mouth_half, mouth_open, mouth_o
  clips: { id: string; kind: "idle"|"talk"|"listen"|"think"|"react"|"away";
           emotion?: string; src: string; small?: string; loop?: boolean }[];
  emotions?: Record<string, string[]>;       // emotion -> clip ids (react)
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
used by the video body (subtle motion), the photo body (mouth stills) and the
Live2D body (`ParamMouthOpenY`, RMS smoothing 0.3 / threshold 0.015 / scale 1.8
as in Geny).

- **Video**: ailism-mate `StackedPlayer` (WebGL, two `<video>` slots, preloaded
  Blob URLs, seamless clip switching on the home frame, 200 ms crossfade on
  mood change); `plain` packing plays the video as-is in a rounded frame.
- **Photo**: ailism-mate `StillBody` (blink 2.5–6 s; mouth stills driven by the
  voice level instead of a random timer); a single photo gets a gentle
  breathing/sway and a level-driven pulse.
- **Live2D**: pixi.js 7 + pixi-live2d-display 0.5 (cubism4) as in Geny's
  `Live2DCanvas`; idle group, expressions/emotion motions, auto-blink, tap
  motions (hit area → group from `tap_motions`, fixing Geny's hard-coded
  `TapBody`), pointer focus inside the canvas.
- **Cubism Core is not bundled** (Live2D licence, see project-geny-app
  `live2d-runtime.ts`): `GET /api/mates/live2d/core` → `{installed}`;
  `POST /api/mates/live2d/core/install` (user accepted the licence in the UI;
  optional body `{accept_license: true}`) downloads
  `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`
  to the data dir (`<MATES_ROOT>/_runtime/`; checked to be the Core script, else
  502) → `{installed, size, source}`; served at `GET /api/mates/live2d/core.js`
  (404 until installed).

Asset upload / import:
- `POST /api/mates/{id}/assets` (multipart `file`, `path`) → `{path, url, size}`;
  `url` carries `?v=<mtime>`. `path` is relative (no `..`, no hidden parts);
  `pack-*` / `l2d-*` top folders are reserved for imports. Max
  `MATE_ASSET_MAX_MB` (200).
- `GET /api/mates/{id}/assets/<path>`: Range requests (video seeking),
  ETag/Last-Modified; `Cache-Control: immutable` for imported files and URLs
  with `?v=`, `no-cache` otherwise. Only media/JSON types are served as such;
  anything else (HTML, SVG, JS…) is `application/octet-stream`.
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
  server) → `{mate, imported: "ailism"|"pack"|"live2d"}`: an ailism content mate
  (the `mates/<key>.json` file; persona from `character.*` + `mate.greeting /
  address`, `{{user}}` filled in, example lines appended to `speech`; body from
  `../assets/<key>/rig.json`, else `doc.mate.body`), a folder with `rig.json`, or
  a Live2D model folder (`*.model3.json` up to 3 levels down; a Geny
  `model_registry.json` entry is used for tuning when there is no sidecar).
  Creates a new mate unless `mate_id` is given (then only its avatar changes).

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
- Engine (Claude Code, persistent like chats, same account pool):
  `--system-prompt-file <persona + mate contract + memories>` with
  `--system-prompt-snapshot off` (so an edited persona reaches the model on
  resume), `--tools ""` (no built-in tools: it can't run code or edit files),
  `--allowedTools mcp__mate`, `--mcp-config <0600 file: mate bridge>
  --strict-mcp-config`, `--disable-slash-commands --setting-sources local` (no
  user CLAUDE.md / hooks / plugins), no wait guide, model/effort from
  `mate.llm`. Editing name/persona/effort or the memory list (by the user)
  restarts the engine at the next turn (`--resume`, same conversation); a model
  change is applied live; what the mate `remember`s itself doesn't restart it.
- Reply format the prompt asks for: short conversational text in the mate's
  language, no heavy markdown; optional inline emotion tags at the start of a
  sentence: `[neutral] [joy] [smile] [laugh] [shy] [surprised] [sad] [angry]
  [thinking] [agree] [greet] [sleepy]`. The client strips tags for display and
  speech, and turns the latest one into the avatar's `react`.

## 4. Delegation (MCP server `mate`, stdio bridge → backend internal API)

Tools the mate gets (all others are disabled):

| tool | what |
|---|---|
| `list_sessions()` | chat sessions (not mates): id, title, workspace, provider/model, running, updated_at, last user + assistant snippet |
| `read_session(session_id, limit=10)` | recent messages, running state, current activity |
| `send_to_session(session_id, message)` | exactly like the user typing in that chat: idle → starts a turn; running → steers the running turn. Marked `via: {kind:"mate", mate_id, name}` (the chat shows "via <name>") |
| `create_session(workspace_path, message?, title?, provider?, model?)` | new chat for a folder (+ first message) |
| `find_folders(query)` | candidate project folders: workspaces of existing chats, then a bounded search of `/home` (depth ≤ 3, names/git repos) |
| `remember(text)` / `forget(id)` | the mate's memory (shown in Mate settings, injected into its system prompt) |

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
- `POST /api/mates/{id}/transcribe` (multipart `file`, webm/opus from
  MediaRecorder, ≤ 25 MB) → `{text, language?}` via openai
  (`gpt-4o-mini-transcribe` default) / whisper
  (`<whisper_url>/v1/audio/transcriptions`, `whisper-1` default); `stt.language`
  (or the persona's) is sent. `browser`/`off` → 400.
- `GET /api/mates/voices?engine=…` → `{engine, voices: [{id, name, language?, …}]}`:
  openai fixed list; elevenlabs via its API (key needed; `preview_url`);
  omnivoice via `/voices` (`emotions` = the profile's reference clips);
  `browser`/`http` → `[]` (the page lists its own).
- Client: replies are split into sentences/bubbles, synthesized in order with
  one-ahead prefetch, played through the voice bridge (level → avatar). Mic:
  push-to-talk button (and hands-free later).

## 6. Surfaces

The web console gains a **Mate** item above **Chat** in the sidebar (mate list,
avatar stage, conversation, mic, Mate settings: Profile · Avatar · Language
model · Voice · Memory). Extra full-page surfaces (no sidebar), used by the
desktop app:

- `/?surface=mate-overlay&mate=<id>` — transparent page: avatar + caption
  bubble only; plays the voice.
- `/?surface=mate-quick&mate=<id>` — one-line quick chat card.
- `/?surface=mate-chat&mate=<id>` — compact mate chat window.

## 7. Desktop app (Electron) — Mate only

The main window stays the console (chat with workers as today). New, all about
the Mate: tray menu, the avatar window (transparent, frameless, always on top,
click-through by default, move mode, remembered position/size), a hover action
bar, the quick chat card on a global shortcut (**Ctrl/Cmd+Shift+G**), the mate
chat window, start at login, Linux forced to X11/XWayland. The renderer surface
is the web app (§6), so features update without reinstalling.

Bridge (preload → `window.hrhNative.mate`):

```ts
mate?: {
  showAvatar(mateId?: string): Promise<void>; hideAvatar(): Promise<void>;
  setClickThrough(on: boolean): Promise<void>; getState(): Promise<{ visible: boolean; clickThrough: boolean; mateId: string | null; hotkey: string; autostart: boolean }>;
  moveBy(dx: number, dy: number): void; moveEnd(): void; setAvatarSize(w: number, h: number): void;
  openQuick(): Promise<void>; closeQuick(): Promise<void>; openChat(): Promise<void>; openConsole(): Promise<void>;
  setMate(mateId: string): Promise<void>; setHotkey(accel: string): Promise<boolean>; setAutostart(on: boolean): Promise<void>;
  onCommand(cb: (cmd: { type: string; [k: string]: unknown }) => void): () => void;
}
```

Android (Capacitor): the Mate view runs in-page; microphone permission added.

## 8. Backend notes

- Files under `MATES_ROOT` (default `~/.hr-harnessor/mates`): `<id>/assets/…`,
  `<id>/home/` (engine cwd), `<id>/engine/` (prompt + MCP config files),
  `_runtime/live2dcubismcore.min.js`, `_cache/tts/`.
- Code: `backend/app/mate/` (`store`, `files`, `prompt`, `service`,
  `mcp_bridge`, `voice`, `netio`: stdlib HTTP, no new dependencies); routers
  `app/routers/mates.py`, `app/routers/mate_internal.py`.
