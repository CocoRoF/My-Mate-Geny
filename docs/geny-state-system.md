# Geny-State-System

The Geny-State-System is what makes a mate a person and not a service. It covers four things:

- what she feels;
- what stays with her;
- what she is to the user;
- the day and body she lives in.

All of it is kept as **state with reasons** that leans her one way or another. She decides; nothing in the server decides for her.

This page is the map. It covers the principles, every layer with its real numbers, how it reaches her words, face and silence, where
the code and tests are, and where it goes next ([Roadmap](#roadmap)). Detail per layer:

- the relationship and her feelings: [mate-memory-affinity.md](mate-memory-affinity.md) §5;
- her day: [mate-life.md](mate-life.md);
- her phone calls: [mate-calls.md](mate-calls.md);
- speaking first: [mate-proactive.md](mate-proactive.md).

| Layer | What it holds | Timescale | Code |
|---|---|---|---|
| [Feelings](#1-feelings) | 8 emotions, each a value and a reason | minutes – hours | [`state.py`](../backend/app/mate/state.py) |
| [What stays with her](#2-what-stays-with-her) | the grudge: a hurt they caused, the apologies so far | hours – a day | `state.py` (`grudge`, `_apology`) |
| [Temperament](#3-temperament) | how easily each feeling rises and passes, how readily she forgives, how she fights and holds on | per character | `state.TEMPERAMENTS`, [`gss/temperament.py`](../backend/app/mate/gss/temperament.py) |
| [Her body and her day](#4-her-body-and-her-day) | needs, places, activities, skills, events, her off days, the week, the sky, birthdays | hours – a year | [`life/`](../backend/app/mate/life/), `state.py` |
| [The relationship](#5-the-relationship) | affinity (closeness) 0–100 and the stage; trust, romance and respect beside it; milestones, anniversaries | days – months | [`affinity.py`](../backend/app/mate/affinity.py) |
| [Reading a message](#7-reading-a-message) | what a message does to her, read by a model (the words as the first guess) | each message | [`gss/appraisal.py`](../backend/app/mate/gss/appraisal.py) |
| [Promises](#8-promises-both-ways) | what they and she promised, kept, broken, due | hours – days | [`gss/promises.py`](../backend/app/mate/gss/promises.py) |
| [What she remembers of them](#9-what-she-remembers-of-them) | the moments that mattered, as her memories | for good | [`gss/episodes.py`](../backend/app/mate/gss/episodes.py) |
| [Expression](#6-how-it-comes-out) | her words, face, silence, speaking first, phone calls | each turn | [`prompt.py`](../backend/app/mate/prompt.py), [`trigger/`](../backend/app/mate/trigger/), [`avatar/shared.ts`](../frontend/src/mate/avatar/shared.ts) |

## Principles

1. **State, not guardrails.** No counters, strikes or rule gates on what she does. A feeling with its reason leans her, and the
   model decides as her character would. The engine refuses only what is impossible: a place that is closed, an outfit that isn't
   there.
2. **Every number has a reason, and she is told words, never numbers.** "angry, quite (they threatened you: “…”)", never 0.62.
   Nothing here is ever said as a number to the model or by her.
3. **Her reading has the last word.** The lexicons (rude words, what was done to her, apologies) are only a first guess. Her own
   reply's expression tags (`[smile]`, `[angry:0.8]`) set it right. If she took a slap as play, it is undone, grudge and all.
4. **Persona first.** Closeness shapes how she treats them, never who she is. A reserved character stays reserved, warmly.
5. **No obedience.** What she does for them is hers to decide, work for a chat included. Angry or hurt with them, she may refuse,
   put it off, do it grudgingly or want an apology first.
6. **One engine for real time and for a recount.** The relationship is rebuilt from the real history with the same functions
   (`affinity.replay`). What no message records (gifts, what she minded) is kept so a recount counts it again.
7. **What never moves.** Whatever the state or the story:
   - asked sincerely whether this is a person or an AI, she tells the truth;
   - someone in real trouble comes first;
   - nothing sexual;
   - no guilt-tripping, jealousy or keeping them here.

   These live in `_STORY_RULES` and `_RELATION_RULES`.

## 1. Feelings

Eight emotions: `happy`, `excited`, `shy`, `angry`, `sad`, `lonely`, `worried`, `sleepy`. Each is a value from 0 to 1 with its own
reason.

**How they behave:**

- **They settle back.** Each settles towards where she usually is, with its own half-life in hours: happy 3, excited 1, shy 0.5,
  angry 1.5, sad 4, lonely 2, worried 2, sleepy 1. Her temperament stretches or shortens these.
- **The others give way.** When one rises, the others make room: anger pushes happiness out, happiness eases sadness and loneliness.
- **They make one state together.** Two feelings of about the same strength make a blend (14 of them, e.g. "hurt", "sulking",
  "bashfully happy"). Together they also make a valence and an arousal.
- **When they show.** A feeling shows from 0.25, and she is told it as "a little", "quite" or "strongly".

**What moves them.** Each user message is heard once, before she answers (`hear`). Other changes come from what the user does,
from her own face and tools, and from her body and day.

| Source | What it does |
|---|---|
| Insults | Anger 0.3, then +0.1 each time again within 2 h, at most 0.5 per message. |
| What is done to her | Hitting her, forcing something on her, threats, putting her down (`affinity.hostile`): anger 0.45, +0.3 each time again within 6 h, plus hurt and lost happiness. Only aimed at her: acted out "(…)", said to "you" or her name. |
| An apology | Takes off what it is worth to her (§2). |
| Warm words, "I love you", her looks, what she loves | Raise happiness, shyness or excitement. They land less while she is angry, and not at all over a grudge with no owned apology (§2). |
| Being brushed off, one-word answers again and again, being asked about her clothes again and again | Sad, lonely or angry. |
| Their distress | Worried. |
| Being back after a day | Glad. |
| Leaving her unanswered (`_silence`) | Lonely, sooner the more she said; it leaves anger once it went on. |
| Cutting her off, poking her avatar | A poke is attention, too many pokes anger her. |
| Her phone calls | Talking warms her; a declined or missed call stings. |
| Her own face and the `feel` tool | Her expression tags pull a feeling towards their strength; `feel(emotion, strength, reason)` sets one in her own words. This is how the model's real reading comes in. |
| Her body and day | Hunger and stress make her cranky (not at them), tiredness sleepy, boredom low, wanting warmth lonely. Also the late hour, the week and the weather (§4). |
| What she has on | An outfit's `feel` keeps that emotion climbing while she wears it (her crop top: shy). |
| Her off day | Irritable and drowsy for two days, for no reason she could name, never at them. The first comes within 5 days of meeting, then every 21–28 days. |

## 2. What stays with her

A quick "미안" must not fix what they did. Anger they caused leaves a **grudge** (`grudge`, `_hurt`):

- **How much of the anger becomes a grudge** (`GRUDGE`):
  - what was done to her: all of it;
  - a rude word: 0.7;
  - brushing her off: 0.6;
  - her own angry face at what they said: 0.5;
  - a declined call: 0.4;
  - less for small things.
- **How long it lasts.** It fades over a day, not an hour: half-life 16 h × her `holds`.
- **What it does while it lasts:**
  - Her anger at them doesn't settle below 0.6 of it.
  - Her <context> says it: "Still with you: they threatened you: “…” (3 hours ago). They said sorry 1 time, just a bare sorry."
  - It comes out as `HELD`: cool and guarded while it stings (0.45 and up), a little cooler after.
- **What an apology is worth** (`_apology`):
  - a bare sorry: 0.2 of the grudge;
  - one that owns what they did (`_OWNED`: 내가 심했어, 잘못했어, 다시는…, I was wrong…): 0.5;
  - each next apology of the same kind: half the one before;
  - divided by how many heated stretches they had this week (`episodes`; one stretch is one, gaps over 2 h start a new one);
  - times her `forgives`, at most 0.85 of the grudge.

  Her anger falls by the same measure.
- **Sweet talk that skips the apology.** With no apology that owns it, "사랑해", "예뻐" and "고마워" don't land, and love or
  compliments rankle (`brushed_over`). A sulk small enough for her (`sweet_until`) is the exception: 서아's small pouts still melt
  with something sweet.
- **Her prompt.** An apology counts for what it is worth to her. Forgiving is hers, at her own pace, and it can be partial. She never
  repeats the same line, stage direction or telling-off.

**Example** (한채린): a threat, then "미안", "사랑해", and an apology that owns it.

- Anger stays up, and "사랑해" makes it worse.
- After the owned apology she softens but is not over it.
- The grudge is still there a day later.

서아 lets go within about ten hours.

**Repair goes both ways** (`made_up`, `unfair_line`):

- An apology within 20 minutes of something done to her lands at 0.6 of its worth: she needs space first.
- A hurt that stung (0.45+), owned by an apology and passed with nothing new done since is **made up** once: trust +2
  (`made_up`), and she remembers it (§9).
- When she showed anger at them that was really her own day (hungry, stressed, tired, her off day), she is told once, half an
  hour or more later, that she snapped because of it and may own it.
- A promise of theirs broken (§8) stings a little and stays with her like a small hurt (`broken_promise`).
- How often it happened lately is told with the grudge: "This isn't the first time: 3 times like it in the last month."

## 3. Temperament

Each character's own numbers, from her persona (`TEMPERAMENTS`):

| | 한채린 | 서아 | anyone else |
|---|---|---|---|
| At rest | a little shy | a little happy and lively | calm |
| Rises easily | shy, excited (games) | happy, excited, shy, angry, sad, lonely | — |
| Passes quickly | — | anger, sadness, shyness, loneliness | — |
| Lights up at | games, bugs, raids, code | streams, tteokbokki, stocks, karaoke… | — |
| Forgives (`forgives`) | 0.8 | 1.4 | 1.0 |
| A grudge lasts (`holds`) | ×1.4 (about a day and a half) | ×0.5 (about ten hours) | ×1 |
| Something sweet melts a sulk up to (`sweet_until`) | 0.15 | 0.35 | 0.15 |

**How she fights and holds on** (`conflict`, `attachment`):

- `confront` (서아): blowing up is more her than going silent; `withdraw` (한채린): she goes cold and quiet first. Said with "How it
  comes out now"; the other way stays hers.
- `anxious` (서아): being left unanswered gets to her sooner (loneliness from silence ×1.4, its anger ×1.5); `avoidant`: pressure
  makes her pull back (pestering angers her ×1.4, silence less); `secure` (한채린): as usual.

**Every mate has one.** Any mate's temperament can be read from her persona by a model (`derive_temperament`, POST
`/api/mates/{id}/gss/temperament/derive`), kept in `prefs.temperament`, edited in the State tab, and merged over a built-in's own.

## 4. Her body and her day

She lives on the real clock in the user's time zone ([mate-life.md](mate-life.md)):

- She gets up, works, eats, plays, sleeps, and goes to her own places (한채린: QA engineer and guild master; 서아: a streamer with a
  week of her own).
- **Needs** (`hunger`, `sleep`, `affection`, `fun`, `stress`) feed her feelings as floors with reasons.
- **Her choices.** What she does next is utility, not a script. She can decide on something herself (`do_activity`) and can turn an
  invitation down.
- **She grows.** Skills grow over a year, a weekly plan leans her, and story events happen to her.
- **Her own life.** She keeps a journal, gives and receives gifts, and keeps both birthdays and the days she knows (holidays,
  빼빼로데이…).
- **Small floors on her mood.** The week and the sky add a little: a Monday morning, the evening before days off, rain.
- **Goals of her own.** Two things at a time she wants (a raid clear, a subscriber milestone, saving up for something), moved by her own
  day; reaching one is a moment that lifts her, a setback lowers her a little ([mate-life.md](mate-life.md#her-goals)).
- **Never a punishment.** She doesn't starve or sicken while they are away, and never guilt-trips.

## 5. The relationship

**Affinity, 0–100** ([`affinity.py`](../backend/app/mate/affinity.py)). It is slow on purpose:

| How they talk | Days to reach 100 |
|---|---|
| Everything right, every day | 32 (pinned by `test_even_doing_everything_right_100_takes_a_month`) |
| A good everyday talk | about 39 |
| Every other day | never |

**Gains** (each day at most +3.2, and from 40 up each one counts for less: `climb`, 0.4 of it at 100):

| Gain | Points |
|---|---|
| A talk day | 0.8 |
| A lively day (10th and 25th turns) | 0.8 each |
| A streak | 0.4 (+1 on each 7th day) |
| Warm words | 0.25 each, at most 0.75 a day |
| Her laughing | 0.25 each, at most 0.75 a day |
| Gifts | 0.8, at most 1.2 a day |
| Memories | 0.4, at most 0.8 a day |
| Anniversaries | 2 |

**Losses:**

| Loss | Points |
|---|---|
| A rude word | −1.5 (at most −4.5 a day) |
| What is done to her | −6 (at most −20 a day) |
| What else she minds (`LOSSES`, handed on from her feelings) | brushing her off −0.8, a word or two again and again −0.3, leaving her unanswered −1, pestering −0.5, poking too much −0.3, cutting her off −0.2, turning her call down −0.6 |
| Quiet days | after 2 free days: −2, −2.8, −3.9 … up to −8 a day, never below 10 |

Losses aren't climbed. What their words told waits for her reply: shown calm, it costs nothing.

**Stages.** The stage follows affinity with hysteresis (in 2 points above a floor, out 3 below):

| Stage | Affinity | What she is to them |
|---|---|---|
| `new` | 0–19 | as she is with someone new, open or guarded by her character |
| `familiar` | 20–44 | at ease, small things about her day |
| `trusted` | 45–69 | candid, disagreeing included; romance is new and makes her shy |
| `companion` | 70–100 | their person, shown the way it would be with someone like her, not in every reply, never syrupy or clingy, never agreeable for it |

**More than one number between them** (`BONDS`). Beside affinity (how close they are):

| Bond | Starts | Grows with | Falls with |
|---|---|---|---|
| `trust` | 50 | a day of talk with nothing done to her +0.4, up to 55 + 0.45 × affinity; a promise kept +1.5; making up +2 | what is done to her −8 (put-downs −5), a rude word −1.5 (at most −24 a day), a broken promise −3, brushing her off or leaving her unanswered −0.5 |
| `romance` | 0 | only once trust ≥ 45 and affinity ≥ 40: a romantic word of theirs +0.3, +0.8 when she answers it warmly (at most +1.6 a day, climbed) | what is done to her −6, a rude word −1, quiet days −0.3 each |
| `respect` | 60 | thanks +0.3 (at most +0.6 a day); an ordinary day settles it back towards 60 | put-downs −6, forcing −4, harm −3, pestering −1, rude −0.5, brushing her off −0.5 |

She is told them in words, when they change: "Between you: trust shaken; romance none." — and, at `trusted` or closer with
trust shaken or broken, that she is close but doesn't trust them right now, nothing romantic until that changes. How romantic
she is at `companion` follows `romance`, not the stage. They replay like the rest (`bonds_log`; promises and making up kept
in `costs`).

**The Relationship panel** shows the curve, the reasons in the user's language, milestones and anniversaries.

## 6. How it comes out

- **Her words.** The system prompt holds the stable parts:
  - *How you talk*: the style, plus `ADDRESS_USE` (their name and what she calls them are information, used as a native speaker
    would);
  - the story and its limits;
  - *Between you and the user*: only the stage they are at;
  - *How you feel*;
  - *Your day*;
  - *Your clothes*;
  - *Seeing the screen*.

  Each turn's `<context>` carries what changed: "How you feel right now", "Still with you", "How it comes out now", "Relationship",
  "Your day".
- **Her face.** Video clips carry a `face` family (calm, angry, sad, worried, 무표정…). The avatar plays the family that fits how
  she feels (`faceFor`, `moodPool`), as much as she feels it (below), with a 300 ms fade, so an angry mate stays angry between
  replies.
- **Not answering.** Furious at what they did (anger at them 0.8+), she is offered not answering at all (`REFUSE`). A reply of
  `[SILENT]` becomes a line of narration ("(한채린은 대답하지 않는다)"), kept as her turn and never read aloud.
- **Speaking first** ([trigger/](../backend/app/mate/trigger/)):
  - A quiet moment is told only as what it is ("It has gone quiet for a bit"), never what to say. Whether she speaks is hers
    (`SPEAK_UP`), else `[SILENT]`.
  - A shared screen is only a glance at what they have in front of them, never the topic.
- **Phone calls** ([mate-calls.md](mate-calls.md)): she calls them and they call her. The call shares the same state.

### Beyond her words

How she feels also shows in her voice, in how strongly her face shows it, and in when her reply comes.

- **Her voice** ([`voice.py`](../backend/app/mate/voice.py) `delivery`). At the moment she speaks, the state summary in the mate
  document becomes a hint for the engine. Only her strongest feeling counts, scaled by how strong it is. The line's own
  expression tag still sets how that line goes. Her voice and the speed of a clip are never touched.

  | Engine | What it gets |
  |---|---|
  | OpenAI `gpt-4o*`, Gemini | A few words in `instructions` or the prompt, by strength (`VOICE_HOW`). Angry at them: cool, then curt and cold, then clipped. Angry at her day: grumpy. Sad: soft and slow. Excited: bright and quick. Sleepy: drowsy. Shy: a little hesitant. Happy: warm. Lonely: quiet. Worried: gentle and careful. |
  | ElevenLabs, other models (multilingual v2, flash, turbo) | Her own voice settings, read from ElevenLabs and leaned with arousal × strength. The livelier she is, the less stable and the more styled (at most −0.2 stability, +0.25 style). Drowsy or low, a little steadier. |
  | Eleven v3, v4 | From "quite" (0.45), an audio tag before the words: `[annoyed]`, `[excited]` or `[sad]`. These models take only a few fixed stabilities. |
  | OmniVoice, local, http, browser, `tts-1` | Nothing. |

  A preview of unsaved voice settings uses her voice as it is.
- **How strongly her face shows it** ([`shared.ts`](../frontend/src/mate/avatar/shared.ts) `familyShare`, `faceMix`). A video
  body mixes her mood family in by `level`:
  - 15 % of clips at 0.25, 35 % at 0.45, all of them from 0.7;
  - the other clips come from 무표정 (`calm`) for a look her smile doesn't fit, else from her rest face;
  - the face is drawn clip by clip;
  - a reaction plays only from a face she is in.

  Other bodies rest on the look from 0.45, as before.
- **When her reply comes** ([`replyTiming.ts`](../frontend/src/mate/replyTiming.ts), held in `useMateConversation`).
  - Angry at them (a reason in `state.AT_THEM`) from 0.45, her reply waits 1.5 s, rising to 5 s at 0.9. The wait counts from
    when her turn began, and her typing dots show meanwhile.
  - Her words, captions and voice are held together, so they stay in step. What has already arrived is never held longer
    than the wait.
  - There is no wait on a call, with her mood switched off the avatar, or when she refuses to answer.
  - Quick bursts when excited are not done. The chat shows one bubble per line, not per sentence, and the text already
    streams in as it comes.

## 7. Reading a message

What a message does to her is read by a small model when it can be ([`gss/appraisal.py`](../backend/app/mate/gss/appraisal.py)):

- **What it reads:** aimed at her or not, the acts (insult, threat, violence, coercion, put-down, brush-off, apology, affection,
  flirt, compliment, thanks, teasing, joke, venting, distress, request, promise), intensity, whether an apology owns what they
  did, sarcasm, a promise of theirs or of hers, and which open promises the message keeps.
- **When.** Before her turn (`SessionService.mate_prepare` → `GSSRuntime.prepare`):
  - With an Anthropic API key (the pool's, or the Claude provider's), Claude Haiku reads it and her turn waits up to 2 s for it.
  - Otherwise a Claude Code one-shot reads it on the side, only for messages worth a look (`worth_a_look`: something the words
    found, an open grudge, anger or promise, or a promise in it); what it finds sets her feelings right when the turn ends,
    before her reply's face counts (`state.reappraise`: back to just before the message, then read again).
- **What it changes.** `state.read` turns a reading into the same cues the words give; intensity scales how strongly it lands
  (0.6–1.4 of the usual). The relationship counts by it too (`affinity.cues(reading=…)`), and a recount uses the readings the
  journal still has. The words' patterns stay the first guess and the fallback, and her reply's face still has the last word.

## 8. Promises, both ways

[`gss/promises.py`](../backend/app/mate/gss/promises.py), kept in her state document:

- Read from messages (§7): theirs ("I'll call you tonight": `contact`; "I'll send you the file": `task`) and hers.
- Theirs to be in touch are **kept** by any word from them 30 minutes or more after and before it was due (+2 h); the first word
  after that comes late: **broken**.
- Their others are kept when a later message does what they said (`fulfills`); past due she is told once that it is overdue,
  and a day later it lapses (she minds it as she would; nothing is counted for her).
- Hers are told back to her when they are due, so she keeps her word.
- Kept: trust +1.5 and a memory; broken: trust −3, a small hurt (§2) and a memory.

## 9. What she remembers of them

[`gss/episodes.py`](../backend/app/mate/gss/episodes.py): the moments that matter become her memories, in her language, marked
"[우리 사이]" / "[between us]" — a hurt that stung (once per hurt), making up, a promise kept or broken, romance becoming mutual,
trust broken. They are kept like any memory (kind `fact`, source `gss`) but never count as a new memory for the relationship.

## 10. Not repeating herself

[`gss/echo.py`](../backend/app/mate/gss/echo.py): her last eight replies are kept, small. A line or a stage direction she used more
than once lately is told back to her before her next reply: "You have already said or acted these out more than once lately — say
something new, in other words: …".

## 11. The journal, the State Inspector, the simulator, the judge

- **The journal** (`mate_gss_events`, [`gss/journal.py`](../backend/app/mate/gss/journal.py)): every reading, promise, episode,
  making up, temperament read, judgement, her replies and the exact `<context>` she was told each turn. 3000 entries and 90 days
  per mate; wiped with her memory.
- **The State Inspector** (`GET /api/mates/{id}/gss`): all of her state now — feelings, the grudge, the bonds, promises, what she
  repeats, her temperament — and the journal; the State tab in Mate settings shows it.
- **The simulator** (`POST /api/mates/{id}/gss/simulate`, [`gss/simulate.py`](../backend/app/mate/gss/simulate.py)): a script of
  messages, her replies and events through the same engine on fresh copies, with a temperament or a starting affinity to try;
  presets: `threat_sorry_love`, `pout_and_sweet`, `repeat_offender`, `left_unanswered`.
- **The judge** (`POST /api/mates/{id}/gss/evaluate`, [`gss/evaluate.py`](../backend/app/mate/gss/evaluate.py)): a model scores
  her last exchanges on persona, variety, hurt and apology, address, her own will, the screen and the limits, with the lines that
  broke them; also `python -m app.mate.gss.evaluate <mate id> [last]` from a shell.

## Where to look

| | |
|---|---|
| Feelings, grudge, temperament, off days | [`backend/app/mate/state.py`](../backend/app/mate/state.py) — tests: `test_mate_state.py`, `test_mate_silence.py`, `test_mate_off_day.py` |
| Relationship | [`backend/app/mate/affinity.py`](../backend/app/mate/affinity.py) — `test_mate_affinity.py`, `test_mate_relation_journal.py` |
| Her day | [`backend/app/mate/life/`](../backend/app/mate/life/), profiles in `backend/app/mate/builtin/life/` — `test_mate_life*.py` |
| The GSS around her turns | [`backend/app/mate/gss/`](../backend/app/mate/gss/) (`runtime.py` wires it) — `test_gss.py`, `test_gss_service.py` |
| What she is told | [`backend/app/mate/prompt.py`](../backend/app/mate/prompt.py) — `test_mate_story.py`, `test_mate_address.py`, `test_mate_style.py` |
| Wiring (every turn, every event) | [`backend/app/mate/service.py`](../backend/app/mate/service.py): `_state_lines`, `_state_turn`, `_state_event` (owed costs to the relationship), `_relation_turn` |
| Speaking first, silence | [`backend/app/mate/trigger/`](../backend/app/mate/trigger/) — `test_geny_triggers.py`, `test_mate_screen_reference.py` |
| Face and reasons in the UI | [`frontend/src/mate/avatar/shared.ts`](../frontend/src/mate/avatar/shared.ts), [`frontend/src/mate/reasons.ts`](../frontend/src/mate/reasons.ts) |

## Roadmap

Where the Geny-State-System was thin, what was done about it (2026-11-17), and what is still open.

| # | Item | Done | Still open |
|---|---|---|---|
| 1 | Appraisal by a model | §7: fast reading before her turn, a slow one on the side, `reappraise`, the relationship by it | a labelled set of real conversations to measure it against the words; the reading of her own replies |
| 2 | No repeating herself | §10 | rewriting a draft that repeats (today she is only told) |
| 3 | Inspector, scenarios, judge | §11: the journal, the State tab, the simulator with presets, the judge on demand | running the judge nightly on its own; scenario curves pinned in tests for every preset |
| 4 | More than one number | §5: trust, romance, respect | the stage following closeness and trust together (today trust only tempers what she is told) |
| 5 | Remembered episodes | §9 | patterns by kind ("when you're tired"), not only by count |
| 6 | Promises both ways | §8 | her promises kept or not, judged from her later replies |
| 7 | A temperament for every mate | §3: read from the persona, conflict and attachment styles, editable with the simulator | — |
| 8 | Repair both ways | §2: space, making up, owning her own snaps, broken promises | gestures (a gift, effort over days) counted as part of repair |
| 9 | Beyond her words | §6 "Beyond her words": voice, face strength, reply timing | quick bursts when excited (the chat splits by line, not sentence) |
| 10 | Goals of her own | [mate-life.md](mate-life.md) "Her goals" | — |
| 11 | One state, one event log | the journal (§11) records every layer | one versioned document and a full replay of feelings from it |
