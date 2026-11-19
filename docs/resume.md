# Chats that go on by themselves

A chat's agent can be cut off by something that is nobody's choice: the server goes away under it (a deploy, a reboot,
a crash, a power cut — every engine and the processes it started die with it), or the connection to the model drops
(the engine gives up on its own retries and the turn ends in a connection error). Then the chat carries on by itself
once it can (`backend/app/services/turn_resume.py`, `SessionService` "turns cut off from outside").

## How it knows

**The journal** (table `turn_journal`, one row per chat): a turn writes its row when it starts and deletes it when it
ends on its own — done, stopped by the user, or failed for a reason waiting won't mend. A running turn refreshes it
about once a minute.

- **A clean shutdown** (a deploy, `docker restart`): the first thing on the way down (`begin_shutdown`, app/main.py)
  marks the running turns *interrupted (restart)*, says so in their chats ("The server restarted — this goes on by
  itself once it's back", not "Stopped by user"), and ends them before their engines die under them — so no failed
  badge and no "done" call.
- **A crash, a reboot, a power cut**: nothing runs on the way down; the rows are still *running*, which at startup says
  the same.
- **Turns from before the journal** (the restart that deploys it): a chat whose last turn started in the last 6 hours
  and never ended.
- **A dropped connection**: the turn's error is read (`cut_reason`): the connection or a briefly unavailable service
  (`Connection error`, `ECONNRESET`, timeouts, 500/502/503/504/529, overloaded) is *network*; the agent's process
  dying under it (or not answering) is *engine*; a key, a limit, a bill, a too-long prompt or a stop are not cut-offs.

## How it goes on

Once the model is reachable again (a TCP knock on its API, through the proxy if there is one; up to 30 minutes, the
chat says it is waiting), the chat's engine session is resumed — everything up to the cut is in it — with a note in
place of a user message: what happened, that whatever it was running (background commands, servers, sub-agents) has
stopped, to check what actually got done first, and to carry on with the user's request. The chat shows that note as a
line ("서버가 다시 시작되어 하던 일을 이어서 해요 (1)"), not as something the user said.

- After a restart: about 8 seconds after startup, the chats one after another, 6 seconds apart (each starts an
  engine).
- After a connection error: 15 s, 45 s, 2 min, 5 min (the chat says when).
- Never forever: 3 continues in a row after restarts, 4 after connection errors, 2 after the engine itself stopped —
  then the chat says it stopped trying (its Continue button is there). A turn cut off more than 12 hours ago is left as
  it was.
- The user's own message takes over a continue that is still waiting.
- Agent chats only: a mate's or an avatar's turns are of the moment.
- The engine has already seen the cut-off turn's request (Claude's transcript is written as it goes; the watermark is
  set as soon as the engine works on it), so the continue doesn't hand it over a second time.

`RESUME_CUT_OFF=false` turns it off (the chats then stay stopped, with their Continue button); the tests run with it
off except `tests/test_turn_resume.py`.
