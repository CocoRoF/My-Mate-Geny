# Settings: where each one lives

One rule decides it: **what you set once and leave is in Settings; what you change now and then is next to the thing it
changes** — the mate (Mate settings), the chat (its controls), the moment (the composer, the tray, the avatar's bar).

- **One Settings.** The Mate view has no second "Global settings" any more; everything app-wide is in Settings.
- **Each setting in one place.** Anywhere else it is a link to that place, never a second copy.
- **Scope is said, not hidden.** A setting that holds for this device only says so (이 기기 · This device); a mate's
  setting is in her own settings and holds for her only.
- **Names don't collide.** 테마 (the look) is not 화면 공유 (sharing the screen); 메이트 설정 (her) is not 설정 (the
  app).

## Settings (설정) — the app, set once

| Group | Tab | What is there |
|---|---|---|
| 일반 | 업데이트와 다운로드 | the web console, the desktop and Android apps, the update source |
| | 계정 | user name and password · **the name your mates know you by** · sign out here / everywhere (Local execution: only your name — the app signs itself in; the sidebar shows it) |
| | 언어 | the app's language · **time zone** (the mates' clock) · **where you are** (her weather, your public holidays: from your connection, or a city you pick) |
| | 테마 | system / light / dark · this device only |
| | 알림 | notifications on this device |
| | 메이트 | (the desktop app) her on the desktop, the mate chat window on top, reset her place, the quick-chat shortcut, start at login · (this device) reading replies aloud and the volume · speaking first · screen sharing (asking first, picture size; always a PNG) · Live2D runtime · bring back the built-in mates · → image & voice services. **Who** is never asked: the mate picked in the Mate view does all of it (the built-in mate until another is picked) — there is no "default mate" and no "the desktop's mate". The Mate panel's 공통 tab shows the same. |
| 에이전트와 서비스 | 언어모델 공급자 · 이미지·음성 서비스 · MCP · 연결 · 사용량 · 관리자 | as before; an OpenAI / Google API key in 언어모델 공급자 also serves 이미지·음성 서비스 (said there; a key of its own wins); 관리자 → 보안 links to 계정 instead of repeating its password form |

## Mate settings (메이트 설정) — her, now and then

| Tab | What is there |
|---|---|
| 프로필 | name · who she is · personality · greeting · standing instructions |
| 대화 방식 | what she calls you (your name itself is in Settings → 계정) · what she calls herself · reply language · speech level · speech habits · length · emotion · warmth / humor / initiative · topics to avoid · whether she may change this herself |
| 아바타·의상 | as before (the Live2D runtime it may need: Settings → 메이트) |
| 음성 | her voice and how she hears you (the volume: Settings → 메이트, this device) |
| 언어 모델 | engine, model, reasoning |
| 관계와 기억 | relationship on/off, pause, sensitivity, her mood on the avatar, set by hand / recompute / start over · remembering by herself, recalling per message · forget everything |
| 삭제 | delete her |

The ♥ panel (기억과 관계) is for looking at the relationship and the memories; its 설정 button opens this tab (from
the desktop Mate chat window: the console, `/?view=mate&panel=settings-relation`). Her daily life is switched on and
off where it lives: the stage's status window.

## In the moment

- Reading a reply aloud for this mate: the composer's speaker (and the avatar's bar on the desktop).
- Sharing the screen, what with, and when she looks: the composer's screen control (+ → Share screen); the set-once
  part links to Settings → 화면 공유.
- The chat's engine, model, reasoning, mode, folders, MCP and Higgsfield: the chat's own controls.
- Showing the mate on the desktop, click-through, moving her: the tray and her bar.

## What moved

| Setting | Was | Now |
|---|---|---|
| Default mate | Profile toggle · Global settings → Defaults · Settings → Mate & voice | Settings → 메이트 |
| Your name (`prefs.user_name`, per mate) | each mate's 대화 방식 | Settings → 계정, one for all mates (a mate's old value is used until it is set) |
| Time zone | Settings → Mate & voice · Global settings → Defaults | Settings → 언어 |
| Volume | each mate's 음성 tab (it was this device's anyway) | Settings → 메이트 (this device) |
| Speaking first (먼저 말 걸기) | a tab of each mate (it was this device's, one mate) | Settings → 메이트 (this device, which mate) |
| Screen tab | each mate's settings (this device's capture settings, starting a share) | Settings → 화면 공유; the share itself in the composer |
| Live2D runtime | Global settings | Settings → 메이트 |
| Bring back the built-in mates | a mate's danger zone | Settings → 메이트 |
| Relationship and memory settings | the ♥ panel's "adjust", the notebook's options | 메이트 설정 → 관계와 기억 |
| Forget everything | the danger zone | 메이트 설정 → 관계와 기억 |
| Mate chat window on top, reset her place | the tray only | Settings → 데스크톱 앱 (and the tray) |
| Click-through, moving her, opening the chat | Settings → 데스크톱 앱 and the tray | the tray and her bar (the moment's) |
| Global settings (전체 설정) | the Mate view's header | gone |

## The first start

1. 언어모델 연결 — Claude Code / Codex: install, sign in (or later).
2. 메이트 — what she calls you, her on the desktop (the default mate), reading replies aloud. Done → the Mate view; no folder
   or chat to start.
