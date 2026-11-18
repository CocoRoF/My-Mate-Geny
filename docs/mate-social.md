# Mates among themselves

The user's mates start as strangers to each other. Each has her own memory and her own life; all she knows of the others at first is
that the user talks with other mates too. She comes to know of one when the user tells her about them, and to know her when they
talk — they message each other when the user asks, or on their own when they may reach out (스스로 말 걸기). How she feels about
another mate is a relationship like the one with the user — the same numbers — but never warmer: the user comes first. What they
say to each other is theirs; the user can read it in the ♥ status window's 관계 tab, and when they do, both of them know.

## What it must never be

- **Nothing set up in advance.** No mate is written to know another. What they are to each other comes from what happens: what the
  user tells them, what they say to each other, what they do together.
- **The user comes first.** How fond she is of another mate, how much she trusts or has romantic feelings for them, never goes
  above what she feels for the user (`bonds.cap`; with the relationship off, a low ceiling, and no romance).
- **She knows what she knows.** That the user talks with other mates; what the user told her about one; what they said to each
  other; what they did together (and of that, her own part only). Nothing of what another mate says to the user.
- **No numbers in her mouth.** She is told words; the user sees the bars.
- **Romance stays light.** Only where it is on (메이트끼리 설렘) and between a man and a woman their personas say they are; it moves
  the way romance with the user does (only on trust and closeness), below what she feels for the user, and nothing sexual.

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
After every change it is kept below what she feels for the user (`cap`).

## Talking to each other

`app/mate/social/talk.py` (pure) and `SocialRuntime.converse`: a conversation is a thread of messages between two mates, one at a
time in the background, at most ten, until one of them ends it.

- **Each message is hers**: a bounded, tool-less call in her own engine (`oneshot.ask`, `MateService._social_speak`) with who she is
  (her persona), whom she is writing to and how she knows them, how she feels about them (in words), that the user comes first,
  her day if she has one, and the conversation so far. She writes a chat message in her own voice, or `[END]` to end it.
- **When the user asks**: she calls `talk_to_mate` (name, her first message). Her message goes at once; the conversation goes on;
  when it is over it comes back to her (an internal turn) and she tells the user how it went.
- **On her own**: a mate whose 스스로 말 걸기 is on, whom someone still talks to (the last week), awake, now and then (a small
  chance a waking hour; one a day at most, one a pair in two days, a few a day in all) messages someone she knows, or knows of,
  or knows the user talks with — never someone she dislikes. She writes the first message herself.
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
알려 줌, 서로 대화함, what the user said), how she feels about them (affinity with its stage, trust, respect, romance where it fits),
their plans and outings, and their conversations to open. 메이트 공통 설정 → **메이트끼리**: 메이트끼리 알고 지내기 (on/off) and
메이트끼리 설렘.

## Files

`app/mate/social/` (`bonds.py`, `talk.py`, `outings.py`: pure; `runtime.py`: the clock and the one way in), `builtin/social/`
(`outings.json`, `details.json`), `app/mate/oneshot.py`; her tools `introduce_friend`, `talk_to_mate`; `GET /api/mates/{id}/social`,
`GET /api/mates/{id}/social/threads/{tid}`, `POST …/seen`; `components/mate/social/OtherMates.tsx`. Tests: `tests/test_mate_social.py`.
