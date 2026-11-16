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
| [Temperament](#3-temperament) | how easily each feeling rises and passes, how readily she forgives | per character | `state.TEMPERAMENTS` |
| [Her body and her day](#4-her-body-and-her-day) | needs, places, activities, skills, events, her off days, the week, the sky, birthdays | hours – a year | [`life/`](../backend/app/mate/life/), `state.py` |
| [The relationship](#5-the-relationship) | affinity 0–100, the stage, milestones, anniversaries | days – months | [`affinity.py`](../backend/app/mate/affinity.py) |
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
- **Her face.** Video clips carry a `face` family (calm, angry, sad, worried, 무표정…). The avatar plays only the family that fits
  how she feels (`faceFor`, `moodPool`), with a 300 ms fade, so an angry mate stays angry between replies.
- **Not answering.** Furious at what they did (anger at them 0.8+), she is offered not answering at all (`REFUSE`). A reply of
  `[SILENT]` becomes a line of narration ("(한채린은 대답하지 않는다)"), kept as her turn and never read aloud.
- **Speaking first** ([trigger/](../backend/app/mate/trigger/)):
  - A quiet moment is told only as what it is ("It has gone quiet for a bit"), never what to say. Whether she speaks is hers
    (`SPEAK_UP`), else `[SILENT]`.
  - A shared screen is only a glance at what they have in front of them, never the topic.
- **Phone calls** ([mate-calls.md](mate-calls.md)): she calls them and they call her. The call shares the same state.

## 7. Where to look

| | |
|---|---|
| Feelings, grudge, temperament, off days | [`backend/app/mate/state.py`](../backend/app/mate/state.py) — tests: `test_mate_state.py`, `test_mate_silence.py`, `test_mate_off_day.py` |
| Relationship | [`backend/app/mate/affinity.py`](../backend/app/mate/affinity.py) — `test_mate_affinity.py`, `test_mate_relation_journal.py` |
| Her day | [`backend/app/mate/life/`](../backend/app/mate/life/), profiles in `backend/app/mate/builtin/life/` — `test_mate_life*.py` |
| What she is told | [`backend/app/mate/prompt.py`](../backend/app/mate/prompt.py) — `test_mate_story.py`, `test_mate_address.py`, `test_mate_style.py` |
| Wiring (every turn, every event) | [`backend/app/mate/service.py`](../backend/app/mate/service.py): `_state_lines`, `_state_turn`, `_state_event` (owed costs to the relationship), `_relation_turn` |
| Speaking first, silence | [`backend/app/mate/trigger/`](../backend/app/mate/trigger/) — `test_geny_triggers.py`, `test_mate_screen_reference.py` |
| Face and reasons in the UI | [`frontend/src/mate/avatar/shared.ts`](../frontend/src/mate/avatar/shared.ts), [`frontend/src/mate/reasons.ts`](../frontend/src/mate/reasons.ts) |

## Roadmap

Where the Geny-State-System is thin today, and what would deepen it, most important first.

### P0: accuracy and trust in what it reads

1. **Appraisal by a model, the lexicon as backup.**
   - *Today.* What a message does to her is guessed by Korean/English patterns (`_RUDE`, `_VIOLENT`, `_DISMISSED`, `_APOLOGY`,
     `_OWNED`, `_LOVE`). They miss sarcasm and indirect cruelty, can't weigh sincerity beyond keywords, and need care against false
     positives ("다 됐어" is not "됐어").
   - *Proposal.* A small, fast model reads each user message with the last few turns and returns a structured appraisal: aimed at
     her or not; the act (insult, threat, coercion, put-down, brush-off, apology, affection, compliment, request, venting, joke);
     intensity; sincerity and whether it owns what was done; sarcasm. `hear` takes that as its input.
   - The lexicon stays as a prefilter and offline fallback, and her reply's face keeps the last word.
   - *Done when* a labelled set of real conversations (both languages) scores clearly better than the lexicon.
2. **No repeating herself.**
   - *Proposal.* Keep her recent openings, stage directions and telling-offs. When a draft repeats one (n-gram overlap), tell her
     before the next turn or have her rewrite.
   - The screenshot that started §2 had the same stage direction twice in a row.
3. **A State Inspector and scenario tests.**
   - *Inspector.* A panel with the timeline of every feeling, the grudge and affinity, each change with its reason, and exactly what
     she was told on each turn.
   - *Scenario tests.* Scripted conversations ("threat → sorry → I love you", "a week away", "a pout and something sweet") with
     expected curves, run on every change.
   - *A nightly run on real models,* judged for persona consistency, apology handling, address use and repetition.
   - Tuning stops being guesswork.

### P1: depth of the relationship

4. **More than one number between them.**
   - *Today.* Affinity mixes familiarity, trust and romance.
   - *Proposal.* Split it into **closeness** (how well they know each other), **trust** (hurt and repair, promises), **affection /
     romance** (grows only from romantic exchanges, and only on trust) and **respect** (how they treat her work, her no, her time).
   - The stage then follows closeness and trust together. That allows "close, but she doesn't trust you right now" and romance that
     can't be farmed by talking a lot.
5. **What happened between them, remembered.**
   - Significant moments become episodes in her memory graph with their feeling: the first fight, making up, a kept or broken
     promise, a birthday they remembered.
   - She can bring them up weeks later, and patterns become visible to her ("you always do this when you're tired").
   - Builds on the memory graph that exists ([mate-memory-graph.md](mate-memory-graph.md)).
6. **Promises, both ways.**
   - "I'll call you tonight", "I'll do it right after the call": plans with a due date already exist as memories.
   - Follow them through: kept builds trust, broken costs it and she notices ("you said you'd…").
   - Her own promises too, which she keeps.
7. **A temperament for every mate.**
   - *Today.* Only 한채린 and 서아 have hand-tuned numbers; every other mate is "anyone else".
   - *Proposal.* Derive the temperament from the persona when a mate is created, adding two new traits:
     - a **conflict style** (blows up or goes quiet: which way `REFUSE` leans);
     - an **attachment style** (anxious: being ignored hurts sooner; avoidant: pressure makes her withdraw).

     Make it editable in the Studio with a live simulator.

### P2: presence

8. **Repair is a process, and it goes both ways.**
   - Making up fully, with an owned apology and kindness over the following days, can leave trust a little higher than before
     (rupture and repair).
   - Some hurts need time before any apology lands (space).
   - When she was unfair (her off day, hungry, stressed), she can own it later herself: "아까는 미안, 배고파서 예민했어".
9. **Her feelings beyond her words.**
   - Reply timing as behaviour: angry, she takes her time or leaves them on read; excited, quick bursts.
   - Her voice follows her state: TTS style and prosody per emotion.
   - Her face's intensity follows strength, not just family.
10. **Goals of her own.**
    - Beyond needs: things she wants this month (a raid clear, a subscriber milestone, saving up for something). They colour her
      mood, what she brings up and what she asks of them, so the relationship has two lives in it.
11. **One state, one event log.**
    - Feelings, the grudge, the relationship and her day live in three documents today, and only the relationship can be rebuilt
      from history.
    - One versioned Geny-State-System document with an event log of what happened would make every layer replayable, comparable
      before and after a tuning change, and inspectable (3).
