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
  (keys are write-only, stored in the vault).

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
  `POST /api/mates/live2d/core/install` (user accepted the licence in the UI)
  downloads `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`
  to the data dir; served at `GET /api/mates/live2d/core.js`.

Asset upload / import:
- `POST /api/mates/{id}/assets` (multipart `file`, `path`) → `{path, url}`.
- `POST /api/mates/{id}/avatar/import` (multipart zip): an ailism-style pack
  (`rig.json` + files → video/photo) or a Live2D zip (finds `*.model3.json`;
  reads a geny-avatar `avatar-editor.json` sidecar: `emotionMap`,
  `idleMotionGroupName`, `tapMotions`, `display.kScale/initialXshift/initialYshift`).
- `POST /api/mates/import-local` `{ path }` (folder on this server): an ailism
  content mate (`mates/<key>.json` persona + `assets/<key>/` body) or a Live2D
  model folder.

## 3. Conversation = a session of kind "mate"

- Each mate has one conversation: a `sessions` row with `kind="mate"`,
  `mate_id`, workspace `~/.hr-harnessor/mates/<id>/home` (local).
  `POST /api/mates/{id}/conversation` returns it (creating it), `…/reset`
  starts a fresh context. The client streams it with the existing
  `/api/history/{sid}` + `/ws/chat/{sid}`, exactly like a chat.
- `GET /api/sessions` (the Chat sidebar) and every delegation listing **exclude**
  mate sessions.
- Engine (Claude Code, persistent like chats, same account pool):
  `--system-prompt <persona + mate contract>`, `--tools ""` (no built-in
  tools: it can't run code or edit files), `--mcp-config <mate bridge>
  --strict-mcp-config`, model/effort from `mate.llm`.
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
`<delegation_result session_id=… title=… status=ok|error|stopped>…final answer (trimmed)…</delegation_result>`
(event flag `internal: true`, rendered as a small card, not a user bubble); the
mate tells the user in its own words. Queued if the mate is busy; never loops.

## 5. Voice

- `POST /api/mates/{id}/speech` `{text, emotion?}` → audio (cached by content
  hash on disk); engines openai / elevenlabs / omnivoice (`/tts`, profile +
  emotion → `ref_audio_path`/`ref_text` like Geny's `_resolve_emotion_ref`) /
  http (OpenAI-shaped `/audio/speech`). `browser`/`off` → 204 (the page speaks).
- `POST /api/mates/{id}/transcribe` (multipart audio, webm/opus from
  MediaRecorder) → `{text}` via openai / whisper.
- `GET /api/mates/voices?engine=…` → available voices.
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
