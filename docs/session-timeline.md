# Going back in a chat, and copying one

Code: `backend/app/services/session_timeline.py`; the engines' side in `providers/claude_code.py` and
`providers/_codex_app_server.py`; on screen `components/chat/RewindButton.tsx`, `lib/rewind.ts` and the chat menu in
`components/layout/Sidebar.tsx`. Tests: `backend/tests/test_session_timeline.py`, `frontend/test/rewind.test.ts`,
`desktop/test/e2e/session-rewind-browser.js` (+ `session-rewind-server.py`). Chats only: a mate's conversation has neither.

## Where an engine stands

Every completed turn records where its engine's CLI session stands: `cli_session_id` and `cli_at` on `turn.complete`, the
main conversation's last assistant message for Claude and the turn id for Codex. Both CLIs can continue from a **copy** of a
session up to such a point and leave the original alone:

| | whole session | up to a point |
|---|---|---|
| Claude | `--resume S --fork-session` | `+ --resume-session-at <uuid>` |
| Codex | `thread/fork {threadId}` | `+ lastTurnId` |

`sessions.cli_sessions[provider]` holds what the next turn should do: `{id, seen}`, plus `fork: true` and `at` after a rewind
or a copy. That turn makes the copy; its new id replaces the entry, flags gone. `seen` keeps its meaning: whatever came after
it reaches the engine as the usual catch-up, so turns another engine ran, or a turn that was cut off before it completed, are
never lost.

**Every failure ends in the same place.** A turn from before `cli_at` existed gives no point: the engine has no entry and
gets the conversation handed over from the chat's own history, as after switching engines. A session or point that no longer
exists makes the CLI refuse (`_STALE_RESUME`), and the turn retries the same way. So this works whatever the provider, the
account or the host, with less detail in the agent's memory in those rare cases and nothing wrong.

## Rewind

`POST /api/sessions/{sid}/rewind {message_id, restore_files}`; `GET` the same path with `?message_id=` says what it would take
back. On any message the user sent (not one a mate sent, or the system made).

1. **Stop.** A running turn is stopped and waited for: going back right after sending the wrong thing is the main use. The
   engine is shut down (it holds the conversation being cut), which also ends its background tasks. Remote jobs started from
   that message on are cancelled; earlier background ones go on. No new turn starts until it is done.
2. **Files, if asked.** The files those turns changed go back to how they were before the first of them, on each host, and
   only those. Every turn records what it starts from (`turn.snapshot`) and, however it ends, what it changed (`turn.changes`).
   The turn at work right now hasn't reported yet, and one the server went down under never will: those are read from the
   snapshots. This comes before any deletion: if a folder can't be read or compared, the rewind fails with that reason and the
   chat is untouched. Commands, commits, pushes and anything else outside the files aren't undone; the dialog says so.
3. **The chat.** In one transaction: the messages and events from there on go, native task rows of those turns too, the
   `/clear` floor goes back if the rewind passed it, each engine's entry becomes where it stood, and the title resets if it was
   made from the only message. A mate's memory that only those messages support is retracted (saying the same thing again teaches it again).
4. **The composer.** The message's text returns with its files, which are unsent uploads again, waiting as of now. What was queued comes back too:
   it must not go out by itself when the stopped turn ends. Files of later messages and what the turns made are deleted.

Other windows hear `session.rewinding` first (what they have queued goes back to their composer, so it can't go out when the
turn stops) and `session.rewound` after (they reload). Nothing is left behind in the chat: no divider, no notice.

**A message added while a turn worked** (a steer) is a point inside that turn. What came before it stays, as a turn stopped
there. What that turn had already changed can't be told apart, so those files stay, and the dialog says so; turns after it are
restored as usual.

**What was spent stays spent.** The terminal events of those turns move to `rewound_usage`, which the Usage page counts with
the rest. They are gone when the chat is deleted, like its events.

## Copy

`POST /api/sessions/{sid}/copy` → a new chat `{title}_copy_{n}`, at once. Every column of `sessions` is copied (so a column added
later is too), apart from identity, timestamps, the last run's result and the engine state. Its messages get new ids, its events
keep their order, its files are hard links in its own folder (a copy costs no space, and either chat can be deleted). Tool
pictures in events point to the copy's files, and finished tasks show in its list.

Each engine's entry gets `fork: true`: the first turn on an engine copies that engine's session. Nothing happens in the CLIs
until then, which is why copying is instant. A running turn isn't copied: the copy stops where the last turn ended, with the
engine state as of then. What still runs belongs to the original.

Copied terminal events carry `usage_copied`: the copy shows the same costs, the Usage page counts them once.
