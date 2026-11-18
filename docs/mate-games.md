# Little games with her

From the stage's **놀이** menu (or by asking her: "끝말잇기 하자"), the user plays a little game with their mate. She plays as herself,
in the conversation: to win, teasing, sulking a little when she loses. The app holds what isn't up to her — the rules, whose turn it is,
the score, and what she keeps secret — so she can't change her answer, and the user can't see it until the end.

| Game | How it goes | What the app holds |
|---|---|---|
| 끝말잇기 (`wordchain`) | She opens with a word; then each word starts with the last syllable of the one before | the start (두음법칙 too: 력 → 역, 리 → 이, 라 → 나 …), Hangul only, two syllables or more, no word twice |
| 스무고개 (`twenty`) | She thinks of something (with a category); they ask yes/no questions | her answer, fixed once set; twenty questions; a guess that names it wins |
| 초성 퀴즈 (`chosung`) | She picks a Korean word; they see its initials (ㄸㅂㅇ) and guess; five rounds | her word, the initials, wrong tries (after three she is told to give a hint), passes |
| 가위바위보 (`rps`) | They throw with buttons; first to three | her hand, by chance; she only reacts at the end |

- **Their moves are messages.** While a game is on, their next message is their word, their question or their guess (`games.heard`,
  once per message): a sentence isn't a word in 끝말잇기; "졌어", "항복", "포기" give up (초성 퀴즈: pass this word). The 놀이 window has
  a field that sends a message too, and give-up / pass and stop buttons.
- **Her moves are `play_game`** (the bridge: start, move, reject, secret, hint, give_up, stop). Her <context> says where the game
  stands and what is hers to do ("Your move: a word starting with 자 … call play_game first, then say it"; "Your secret answer is “펭귄”;
  never say it unless they guess it"). A move against the rules comes back as why, and she tries again or gives up. She may reject a
  word of theirs that isn't a real word; they try another.
- **Started from the menu**, she gets it going at once (an internal turn: her first word or her secret). A 가위바위보 match she hears
  about when it ends, and reacts.
- **Played to the end**, a game does her good (her day's fun, a little warmth: `GAME_EASES`) and counts a little for the relationship
  (`affinity.credit_play`, capped per day, kept in `played` for a recompute). The record (wins and losses per game) shows on the
  game cards.
- 초성 퀴즈 is only offered to a mate who speaks Korean.

The 놀이 button shows what is next at a glance while a game is on (the letter to start with, the initials, the questions asked, the
score).

Files: `app/mate/games.py` (pure), `MateService.game_*` / `_tool_play_game` / `_game_lines` (state in `mate_settings`
`game:<mate id>`), `GET`/`POST /api/mates/{id}/game`, `components/mate/stage/GamesWindow.tsx`, `useGame.ts`. Tests:
`tests/test_mate_games.py`.
