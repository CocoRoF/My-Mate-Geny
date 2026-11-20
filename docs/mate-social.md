# Mates among themselves

The user's mates start as strangers to each other. Each has her own memory and her own life; all she knows of the others at first is
that the user talks with other mates too, and strangers don't get closer by themselves. She comes to know of one when the user
tells her about them, and to know her when they talk — the first time because the user asked. After that it is theirs: they
write to each other on their own now and then, the more often the closer they are. How she feels about another mate is a
relationship like the one with the user — the same numbers, with no ceiling: they can become anything to each other, lovers too.
What they say to each other is theirs; the user can read it in the ♥ status window's 관계 tab, and when they do, both of them
know.

## What it must never be

- **Nothing set up in advance.** No mate is written to know another. What they are to each other comes from what happens: what the
  user tells them, what they say to each other, what they do together.
- **Strangers until the user brings them together.** All a mate knows of the others at first is that they exist. Nobody writes to
  one she only knows exists: the first conversation is one the user asked for (`talk_to_mate`), or one with a mate the user
  introduced (`introduce_friend`).
- **She knows what she knows.** That the user talks with other mates; what the user told her about one; what they said to each
  other; what they did together (and of that, her own part only). Nothing of what another mate says to the user.
- **No numbers in her mouth.** She is told words; the user sees the bars.
- **No ceiling, no rule of who may love whom.** Until 2026-11-20 she was never fonder of another mate than of the user, romance
  was only between a man and a woman, and it never went past 썸. All of that is gone. Romance is off only where 메이트끼리 설렘
  is off (`bonds.fits`); it moves the way romance with the user does (only on trust and closeness), and nothing sexual.

## Knowing each other

`app/mate/social/bonds.py` (pure), one document for all of them (`mate_settings` key `social`, version 2; a document from before —
when the built-in mates were set up to know each other — starts over: everyone a stranger).

- **That the user talks with others**: each mate is told, once a day, which other mates the user has talked with lately (the last
  week) and when (`user_talks_with`): "The user also talks with other mates like you lately: 서아 (earlier today). You only know
  that much, unless you know them yourself."
- **Told about**: when the user tells her about another mate, she calls `introduce_friend` (name, what the user said). The name is
  matched against the user's other mates; she knows *of* her from then on (`known[me][other] = told`, with the note). The other one
  knows nothing of it.
- **Talked**: once they have messaged, they know each other (`talked`, both ways), and each has a relationship with the other.

## How she feels about another mate

`known` is who she knows (of); `rel[me][other]` is how she feels about them: an affinity document (app/mate/affinity.py), the same
engine as with the user — affinity −100 – 100 with its stages (서먹함 … 동반자), trust, respect, romance. What the other says to her
moves it as the user's messages move hers (`bonds.heard` → `credit_turn`: warmth, laughing together, rudeness, worse); days without
talking cool it (never into ill feeling) and ill feeling mends slowly (`drift`, once a day); an outing moves it a little (`moved`).
Nothing keeps it below what she feels for the user; where romance is off (메이트끼리 설렘) it stays at nothing (`fits`).

## What they are to each other

Beside how she feels about another mate, she has her own view of what the two of them are: any of the labels, 연인 and 헤어진
사이 included (the romantic ones only where 메이트끼리 설렘 is on). It holds once she has it. She thinks it over at night when something passed between them that day and it is due,
or says so at the moment (`what_we_are` with the other's name). See [geny-state-system.md](geny-state-system.md) §12. Her view
goes into what she is told of the other (the other-mates section, her messages to her), and the 관계 tab shows what each of the
two thinks.

## Talking to each other

`app/mate/social/talk.py` (pure) and `SocialRuntime.converse`: a conversation is a thread of messages between two mates, one at a
time in the background, at most ten, until one of them ends it.

- **Each message is hers**: a bounded, tool-less call in her own engine (`oneshot.ask`, `MateService._social_speak`) with who she is
  (her persona), whom she is writing to and how she knows them, how she feels about them and what they are to her (in words),
  her day if she has one, and the conversation so far. She writes a chat message in her own voice, or `[END]` to end it.
- **When the user asks**: she calls `talk_to_mate` (name, her first message). Her message goes at once; the conversation goes on;
  when it is over it comes back to her (an internal turn) and she tells the user how it went.
- **On her own** (`_own`, `_reach`): a mate whom someone still talks to (the last week), awake, now and then messages one she
  has talked with or the user introduced to her — never one she only knows exists. 스스로 말 걸기 (speaking first to the user)
  has nothing to do with it. How much she feels like it (`_reach`):
  - one the user only introduced: a little (0.3);
  - once they have talked, by affinity: below 0 not at all, 0–20 0.4, 20–45 1, 45 and up 1.6;
  - times what they are to her: best friends 1.5, lovers 1.8, 썸 1.6, a crush 1.3, rivals 0.7, love-hate 1, estranged 0.2,
    exes 0.3, indifferent 0.1, loathing 0. Rivals and love-hate seek each other out even below 0 (0.4).

  The chance in a waking hour is 0.025 times the strongest of these. At most one a day each, one a pair in two days, a few a
  day in all. She writes the first message herself.
- **What she is told**: what was said since she was last told (the last few messages, per conversation), as news with her next
  message; when the user or she names another mate, the last things they said to each other. Her diary gets the day's.

## The user reading it

The 관계 tab lists the conversations with each mate (new messages marked). Opening one is reading it (`POST
/api/mates/{id}/social/threads/{tid}/seen`): what is new in it is marked read, and both mates are told — "the user read your
conversation with 서아: what you wrote to each other" — with a slight shyness about it (how she takes it is hers: embarrassed,
annoyed, or not bothered). Reading it again tells them nothing new.

## Going out together, once they are friends

`app/mate/social/outings.py` and `builtin/social/outings.json`: when both like each other enough (affinity 20 or more, each way),
they now and then make plans for time both of their days have free, go out each in her own day (`sim.meet`: to a place of her own
like it, else to the friend's, with its picture), and afterwards both remember it — what they did alike, and a small part only she
knows (a model writes it in their own words when someone still talks to them). How it went moves how each feels about the other.
Asleep she misses it; with the user in person it waits, then is called off. Docs/mate-life.md has the day side (`with_mate`).

## What the user sees

The ♥ status window → **관계**: under the user's own relationship and promises, **다른 메이트**: each mate she knows (of), how (내가
알려 줌, 서로 대화함, what the user said), how she feels about them (affinity with its stage, trust, respect, romance where it is on), what each of them thinks the two of
them are,
their plans and outings, and their conversations to open. 메이트 공통 설정 → **메이트끼리**: 메이트끼리 알고 지내기 (on/off) and
메이트끼리 설렘.

## Files

`app/mate/social/` (`bonds.py`, `talk.py`, `outings.py`: pure; `runtime.py`: the clock and the one way in), `builtin/social/`
(`outings.json`, `details.json`), `app/mate/oneshot.py`; her tools `introduce_friend`, `talk_to_mate`; `GET /api/mates/{id}/social`,
`GET /api/mates/{id}/social/threads/{tid}`, `POST …/seen`; `components/mate/social/OtherMates.tsx`. Tests: `tests/test_mate_social.py`.
