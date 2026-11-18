# Mates among themselves

The user's mates are not strangers to each other. The built-in ones already know each other; anyone the user makes meets them over
time, or when the user introduces them in a conversation. Friends message now and then, make plans, go out together, and afterwards
both remember it — what they did the same way, and each a small part only she knows. How it went moves how they get along. All of it
is in their days (docs/mate-life.md), in what each of them is told, and in the ♥ status window's 인맥 tab.

## What it must never be

- **Not a show for its own sake.** It happens on the real clock, slowly: a few outings a week between close friends, fewer between
  acquaintances, rarely between two who are awkward together. Nobody is told everything every turn.
- **No numbers in her mouth.** She is told words ("a close friend of yours; you like them a lot"); the user sees the bars.
- **She knows what she knows.** What both did, both know. What only one of them did (which book she picked, what she drank), only she
  knows. What a friend does with the user, she only knows if someone tells her.
- **No jealousy over the user.** Her friends are part of her life; the relationship rules (no guilt-trips, no possessiveness) stand.
- **A spark stays a spark.** Where it is on, between a man and a woman their personas say they are, a great time between fond friends
  may start a crush (설렘), one way or both (썸). It goes no further: nothing sexual, and it never makes her cold to the user. It is a
  shared mate setting (메이트끼리 설렘, on unless switched off); with it off nothing of it is told or shown.

## Who knows whom

`app/mate/social/ties.py` (pure): one document for all of them (`mate_settings` key `social`). A **tie** between two mates has:

| | |
|---|---|
| `how` | `builtin` (they always knew each other), `introduced` (by the user), `met` (over time) |
| `story` | how they know each other, in both languages |
| `fond` | how fond each is of the other, 0–100, one number each way |
| `close` | how close they are, 0–100, one number |
| `spark` | a crush, each way (only where it is on and fits) |
| `together`, `last`, `log` | how many outings, the last contact, what moved it and why |

What they are to each other follows: `awkward` (either fondness below 30) · `acquainted` · `friend` (close ≥ 25, both fond ≥ 45) ·
`close` (55, 60) · `best` (80, 75). Time apart: after two weeks without anything together, closeness fades a little each day, never
below a floor (25 for built-in friends); fondness settles back towards 50; a spark fades unless something feeds it.

- **Built-in**: `builtin/social/ties.json` — 채린 and 서아 met in the Dalmuri guild (서아 calls her unnie), 채린 and 마오 are quiet
  regulars of the same café, 서아 and 마오 met over her stream schedule. Made at the first minute both are there; a memory wipe starts
  hers again, and the built-in ones know each other again at once.
- **Over time**: two who don't know each other, once both have been around three days, have a small chance a day (`MEET_DAY`) to
  meet (`ties.json` `met`: the same café, the last snack on the shelf, the same walk, a comment on a post).
- **Introduced**: in a conversation, when the user introduces another of their mates or says the two should meet, she calls
  `introduce_friend` (name, what the user said). The name is matched against the user's other mates; someone else is just someone the
  user mentioned. The other one hears it with her next message ("the user told 채린 about you"), and they mean to meet soon
  (`boost`: plans are likelier for a week).

## What they do together

`app/mate/social/outings.py` (pure, seeded) and `builtin/social/outings.json`: a chat at a café, a walk (not in rain or snow), a
bookshop, karaoke, games out, eating out, a workout, gaming online and a long call (both from home).

- **Plans**: once an hour in waking hours each pair has a chance (`plan_chance`: from how close and fond they are; just introduced,
  much more) to make plans for between two hours and a day and a half ahead, on the half hour, never within two days of the last
  outing. What: what both of them like (their activities' `likes`), not out of doors on a wet day. When: a time both of their days
  have free (`sim.free_between`: no obligation of her routine — work, a stream, a raid night, her bedtime — then or within 45 minutes
  of it). A mate without a day of her own is free from 10 to 22.
- **Going**: at the time, each one goes in her own day (`sim.meet`): to her own place like it (a café of hers for a café) when she has
  one, else to the friend's (she is `out`, a hidden place every day has; her stage shows the friend's picture of it and its names).
  Her day knows who she is with (`with_mate`) until it ends; her status says so, and so does what she is told. Asleep, she misses it;
  with the user in person, it waits a little (three times twenty minutes), then is called off. Rain on an outdoor plan moves it into
  a café.
- **Afterwards**: how it went (`mood`: great, good, okay, awkward — fond friends mostly have a good time; stress and a cool tie make
  an awkward one likelier) moves fondness and closeness (`settle`); company does her needs good (`COMPANY`). They remember it:
  `compose` picks what both remember and a part of each one's own (a built-in mate's are hers: `details.json`). When someone still
  talks to one of them, a model writes it in their own words from that outline (`oneshot.ask` in the first one's engine, bounded,
  no tools; JSON with what both remember and each one's part); if that fails or is late, the outline is what they remember.
- **Messages**: between outings, friends message now and then (a chance a day, more the closer), a little warmth both ways.

## What she is told

- **System prompt** (`SocialRuntime.prompt`, part of the prompt key: a new stage restarts the engine like any change of who she is):
  "People in your life": each friend, what they are to her, how fond she is, how they met; her crush if she has one; the rules above;
  `introduce_friend`.
- **Per turn** (`SocialRuntime.lines`, acknowledged with the context): news not told yet (who she met, an introduction, a message, an
  outing — what both remember, and "Only you know: …" her part — plans called off), at most three, a week old at most; her plans
  ("Plans: tomorrow at 15:00 you and 서아 are meeting (a chat at a café)"); and, when she or the user names a friend in the message,
  the last few things they did together.
- **She may write first**: a great or awkward outing, a spark, someone new, plans called off — when reach-out is on, once in six
  hours at most (`_social_event`), in her own words, or `[SILENT]`.
- **Her diary** gets what she did with friends that day.

## What the user sees

The ♥ status window → **인맥**: each friend (picture, what they are to each other, a spark), how they met, how many times together,
three bars (her fondness, theirs, how close they are), their plans, and the last things they did together with her own part
("서아만 아는 것"); who she met or was introduced to lately. Her stage chip and the Now tab say who she is out with.
메이트 공통 설정 → **메이트끼리**: 메이트끼리 어울리기 (on/off) and 메이트끼리 설렘.

## Files

`app/mate/social/` (`ties.py`, `outings.py`: pure; `runtime.py`: the clock and the one way in), `builtin/social/` (`ties.json`,
`outings.json`, `details.json`), `app/mate/oneshot.py`; `sim.meet`, `sim.free_between`, `sim.ease`, the hidden `out` place
(`life/profile.py`); `GET /api/mates/{id}/social`; `components/mate/social/FriendsSection.tsx`. Tests: `tests/test_mate_social.py`.
