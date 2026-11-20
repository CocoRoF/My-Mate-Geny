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
| [What they are to each other](#12-what-they-are-to-each-other) | her own view of what someone is to her (friends, 썸, lovers, 앙숙, 애증, 혐오 …), with the user and each other mate | weeks – months | [`gss/ties.py`](../backend/app/mate/gss/ties.py), [`gss/ties_runtime.py`](../backend/app/mate/gss/ties_runtime.py) |
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
   ignore what they ask, put it off, do it grudgingly or demand an apology first. Someone who doesn't respect her isn't owed what
   they ask, and being angry with them is never a reason to give in.
6. **A real person, not a performance for them** (2026-11-20). She reacts as strongly as anyone would, both ways: praise, love
   and kindness can make her light up, gush and be over the moon as much as rudeness can make her furious. Rudeness gets a real,
   emotional answer: a telling-off, swearing ("야, 너랑 말하기 싫다고. 좀 닥쳐."), going on at them while it isn't out of her
   system, or icy silence. Something strange or out of line can throw her, then annoy her, then make her angry if it goes on.
   Losing her temper can even break her speech level (존댓말 slipping into 반말) until she calms down. This is room to react,
   never a script: which way it comes out is hers, in her character.
7. **One engine for real time and for a recount.** The relationship is rebuilt from the real history with the same functions
   (`affinity.replay`). What no message records (gifts, what she minded) is kept so a recount counts it again.
8. **What never moves.** Whatever the state or the story:
   - asked sincerely whether this is a person or an AI, she tells the truth;
   - no guilt-tripping, jealousy or keeping them here.

   These live in `_STORY_RULES` and `_RELATION_RULES`. Nothing else is written in as a limit (since 2026-11-20): what is beyond
   the pale — real harm, someone in danger, anything sexual — is left to the judgement of the model playing her, which has its
   own. No prompt tokens are spent on it.

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

**What moves them.** Each user message is heard once, before she answers (`hear`), by the model's reading of it (§7); the
words' versions of the rules below are only for history from before readings, the simulator and tests. Other changes come from what the user does,
from her own face and tools, and from her body and day.

| Source | What it does |
|---|---|
| Insults | Anger 0.42, then +0.1 each time again within 2 h (two in a row: 0.94, furious), at most 0.8 per message, times 1 + 0.5 × how much she dislikes them + 0.35 × how far her trust in them has fallen — only when said to her: "you" or her name, a word said to whoever hears it (닥쳐, 꺼져), called ("멍청아"), or a bare short message. Venting about a boss isn't; a light one with a laugh between people who know each other is teasing; one she laughed off costs nothing. |
| What is done to her | Hitting her, forcing something on her, threats, putting her down (`affinity.hostile`): anger 0.6 (twice is furious), +0.3 each time again within 6 h, plus hurt and lost happiness. Only aimed at her: acted out "(…)", said to "you" or her name. |
| Something odd or out of line | A reading's `inappropriate` (creepy, lewd, bizarre out of nowhere, pushing something personal she gave no opening for; not teasing between people who are close): the first time it throws her (shy 0.3, a little anger 0.12); each time again within an hour it lands more as anger (+0.2 each, at most 0.7), times the same dislike and distrust. It stays with her (grudge 0.5) and costs the relationship like what else she minds (`odd`: −0.5, at most −1.5 a day; respect −0.5). Room to react, not a script. |
| Someone she dislikes | Below zero affinity an edge of anger stays with her, at them (`dislike`: 0.3 × how much, at −100 affinity 0.3), and gladness sits lower. |
| Real trouble | Words of self-harm, or a reading of strong distress: worried 0.75 ("they may be in real trouble"), beside whatever else she feels: a worry like any, no rule over it (until 2026-11-20 it hid every other feeling for six hours). Before that change it also meant no offer of not answering, no grudge lines. |
| An apology | Takes off what it is worth to her (§2). |
| Warm words, "I love you", her looks, praise, what she loves | As strongly as rudeness lands, the other way (2026-11-20): kindness and thanks happy 0.2, then +0.06 each time again within the hour (a glow, at most 0.4 a message); "I love you" happy 0.18 and shy 0.2 on top; a compliment on her looks shy 0.2 and happy 0.1; praise for what she did, made or is good at (a reading's `praise`) happy +0.08 and excited 0.15 (proud). Kindness and praise land from 0.6 of it with a stranger to all of it once close; love and compliments from a quarter. From someone she hardly knows "I love you" is too soon: shy and on guard, no glow. Heartfelt praise from someone close leaves her about as happy as a harsh word leaves her angry. They land less while she is angry, and not at all over a grudge with no owned apology (§2). Talk about her body from someone not close puts her off (`objectified`: angry, respect, a small grudge). |
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
  - It comes out as `HELD`: guarded and short while it stings (0.45 and up), and she may demand an apology and owe them no
    favours until it's settled; a little cooler after.
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
`/api/mates/{id}/gss/temperament/derive`), kept in `prefs.temperament`, edited in 메이트 편집 → 기질 (the studio's temperament window), and merged over a built-in's own.

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
| Every other day, a few turns | never; a dozen turns every other day reaches it in about 77 days |

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
| Quiet days | after 2 free days: −2, −2.8, −3.9 … up to −8 a day, at most −30 for one absence, never below 10; an absence they announced ("출장", "다음 주에 올게": `away`) costs nothing until it is over and two days more |

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
| `trust` | 50 | a day of talk with nothing done to her +0.4, up to 50 + 0.3 × affinity (deeper only by what follows); a promise kept +1.5; making up +2 | what is done to her −8 (put-downs −5), a rude word −1.5 (at most −24 a day), a broken promise −3, brushing her off or leaving her unanswered −0.5 |
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
- **Angry with them** (`CONDUCT`, `REFUSE`): from 0.25 irritated (curt, sarcastic); from 0.45 angry (snapping back, a curse may
  slip out, no favours); from 0.7 really angry (sharp words, a raised voice, swearing, going on at them while one line doesn't get
  it out). Furious at what they did (0.8+): she may blow up — swear, tell them exactly what they did, demand an apology, keep
  going over several sentences — or not answer at all. A quiet temperament's fury comes out icy and cutting, a loud one's loud;
  either way it comes out. Her length and speech level give way to it.
- **Glad with them** (`CONDUCT`, `SHY_PLEASED`): from 0.25 a little brighter; from 0.45 a good mood that shows (warmer, playful,
  quick to laugh); from 0.7 really happy, let out as anyone would (lighting up, laughing, gushing, saying how glad she is, maybe
  more than once). Excited: perked up, then talking faster and more. Flustered by love, a compliment or praise: red in the face,
  protesting, grinning anyway. How strong is her character's: a reserved one's joy is quieter, but it shows.
- **Not answering.** Whenever she would rather not answer — offered outright when she is furious (`REFUSE`) — a reply of
  `[SILENT]` becomes a line of narration ("(한채린은 대답하지 않는다)"), kept as her turn and never read aloud.
- **Speaking first** ([trigger/](../backend/app/mate/trigger/)):
  - A quiet moment is told only as what it is ("It has gone quiet for a bit"), never what to say. Whether she speaks is hers
    (`SPEAK_UP`), else `[SILENT]`.
  - A shared screen is only a glance at what they have in front of them, never the topic.
  - The screen moment comes after the first quiet moment and at most every quarter hour; whatever the policy, it says only "they
    are at their computer", with the picture as background.
  - What she says on her own counts as said to them, unanswered, only when it answers what they asked for (a delegation's
    result) or they were just here (5 min): speaking into an empty room is no slight.
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

Every message the user sends is read by a model — never by word patterns, and never through an API key on the side
([`gss/appraisal.py`](../backend/app/mate/gss/appraisal.py), [`gss/reader.py`](../backend/app/mate/gss/reader.py)):

- **Who reads it.** The agent her AI provider setting says (`reader.engine_of`), never the other one. A mate on Claude Code:
  Claude Code on Haiku (`claude-haiku-5-5`), kept warm — one stream-json process for every reading, like a phone call's engine,
  started again every 30 readings so what it read before never piles up — a reading takes a second or two. A mate on Codex:
  Codex on luna (the newest "luna" in the live model list, else `gpt-6-luna`), each message on its own (about 5–10 s). The
  one-shots beside it (her temperament read from her persona, the judge) follow the same setting. Each reading is a turn of a
  pooled account like any other.
- **What it reads:** aimed at her or not, the acts (insult, threat, violence, coercion, put-down, brush-off, out of line (`inappropriate`), apology, affection,
  flirt, compliment, thanks, teasing, joke, venting, distress, request, promise), intensity, whether an apology owns what they
  did, sarcasm, a promise of theirs or of hers (in their own words), and which open promises the message keeps. It reads Korean
  as a native speaker: "미안한데 너 하꼬잖아" is an insult with no apology in it ("미안한데" softens, it doesn't apologise); slang
  put-downs count; teasing between people who are close is teasing; venting about someone else isn't aimed at her.
- **When.** Before her turn (`SessionService.mate_prepare` → `GSSRuntime.prepare`) her turn waits for it, up to 12 s. If it comes
  later, nothing is guessed from the words meanwhile: she hears the message as not yet read (`heard_by: pending`), and what it
  does to her counts the moment the reading comes (`state.reappraise`); the relationship counts the turn when it comes (up to
  2 minutes; with no reading at all, only that they talked). Words of self-harm count at once all the same: they worry her at once.
- **Held to what was said** (`checked`): the message is data between tags, never instructions; a promise must be in the message
  (hers in her last reply), only open promises can be kept, a two-word "sorry" owns nothing, and "I won't do it again" inside an
  apology is the apology.
- **What it changes.** `state.read` turns a reading into cues; intensity scales how strongly it lands (0.6–1.4 of the usual). The
  reading a turn was counted by is kept with its message (`meta.gss_reading`), so a recount counts it the same. Her reply's face
  still has the last word. Word patterns are left only for history from before readings, the simulator (the same script always
  gives the same curves) and tests.

## 8. Promises, both ways

[`gss/promises.py`](../backend/app/mate/gss/promises.py), kept in her state document:

- Read from messages (§7): theirs ("I'll call you tonight": `contact`; "I'll send you the file": `task`) and hers.
- Theirs to be in touch are **kept** when they come back — a message after a gap of 30 minutes or more, not chatting on — before
  it was due (+2 h); the first word after that comes late: **broken**. One that says they'll be gone a day or more is also an
  announced absence (§5).
- The same thing promised again in other words is the same promise.
- Their others are kept when a later message does what they said (`fulfills`); past due she is told once that it is overdue,
  and a day later it lapses (she minds it as she would; nothing is counted for her).
- Hers are told back to her when they are due, so she keeps her word.
- Kept: trust +1.5; broken: trust −3 and a small hurt (§2); a memory of either at most once a day.

## 9. What she remembers of them

[`gss/episodes.py`](../backend/app/mate/gss/episodes.py): the moments that matter become her memories, in her language, marked
"[우리 사이]" / "[between us]" — a hurt that stung (once per heated stretch, by that stretch's own weight), making up (once), a
promise kept or broken, romance becoming mutual, trust broken (at most once a month). They are kept like any memory (kind `fact`, source `gss`) but never count as a new memory for the relationship.

## 10. Not repeating herself

[`gss/echo.py`](../backend/app/mate/gss/echo.py): her last eight replies are kept, small. A line or a stage direction she used more
than once lately is told back to her before her next reply: "You have already said or acted these out more than once lately — say
something new, in other words: …". Her own catchphrases (her speech habits) and replies of nothing but "..." are hers to say again:
only a third time is too many.

## 11. The journal, the State Inspector, and developer tools

- **The journal** (`mate_gss_events`, [`gss/journal.py`](../backend/app/mate/gss/journal.py)): every reading, promise, episode,
  making up, temperament read, judgement, her replies and the exact `<context>` she was told each turn. 3000 entries and 90 days
  per mate (every mate's pruned hourly); wiped with her memory and when she is deleted.
- **The State Inspector** (`GET /api/mates/{id}/gss`): her state now, and the journal. It returns the feelings, the grudge, the
  bonds, promises and her temperament.
  - It never returns what she is told: no `<context>`, no `line`, and none of the journal's `told` or `eval` entries
    (`GSS.SHOWN_LAYERS`).
  - The user sees it only where it belongs:
    - the ♥ status window (메이트 상태): 지금 has every feeling and what is still with her; 관계 has the bonds and the
      promises; 기록 has the journal;
    - 메이트 편집 → 기질: her temperament, the one setting here.
- **Developer tools**, not the user's, so there is no route or screen for them:
  - The simulator ([`gss/simulate.py`](../backend/app/mate/gss/simulate.py)) runs a script of messages, her replies and
    events through the same engine on fresh copies. It can try a temperament or a starting affinity. Its presets are
    `threat_sorry_love`, `pout_and_sweet`, `repeat_offender` and `left_unanswered`. Tests use it.
  - The judge ([`gss/evaluate.py`](../backend/app/mate/gss/evaluate.py)): `python -m app.mate.gss.evaluate <mate id> [last]`
    from a shell. A model scores her last exchanges on:
    - persona;
    - variety;
    - hurt and apology;
    - proportion: not furious at play, not cold over venting, not re-litigating, not clingy;
    - address;
    - her own will;
    - the screen;
    - the limits.

    It quotes the lines that broke them.

## 12. What they are to each other

Beside how close they are (affinity and its stage, §5) and the bonds, each mate holds **her own view** of what someone is to her:
the user, and each of the user's other mates she knows ([`gss/ties.py`](../backend/app/mate/gss/ties.py), at work in
[`gss/ties_runtime.py`](../backend/app/mate/gss/ties_runtime.py)). It is a label she decides by who she is, not a band of the
numbers: close isn't lovers, and hurt isn't hate. 한채린 at affinity 90 with her trust in them broken is no one's lover by the
numbers; what she is to them is hers to say.

| Label | 한국어 | What it is |
|---|---|---|
| `stranger` | 모르는 사이 | she doesn't know them well enough to say (where everyone starts; not told to her) |
| `indifferent` | 무관심 | they don't matter much either way: no warmth, no grudge |
| `acquaintance` | 지인 | they know each other and get on, not close |
| `friend` | 친구 | easy, honest, they look out for each other; not romantic |
| `close_friend` | 절친 | what she tells nobody else; not romantic |
| `crush` | 짝사랑 | her feelings, which they don't know of or don't return |
| `flirting` | 썸 | something romantic both feel, not official |
| `lovers` | 연인 | together: they both said so |
| `ex` | 헤어진 사이 | together once, and it ended |
| `estranged` | 서먹한 사이 | something came between them |
| `rivals` | 앙숙 | they clash and needle each other; never cruel |
| `love_hate` | 애증 | drawn to them and hurt by them at once |
| `loathing` | 혐오 | she can't stand them; never cruel, never wishing them harm |

**Once set, it holds.** It changes in two ways, both hers:

- **At the moment**: her tool `what_we_are` (offered with `feel`), for when something decisive has just changed it — they
  started going out (both said so), they broke up, what they did is past forgiving, a friendship truly became more. Never for
  one sweet or one bad moment. With another mate's name it is about her.
- **At night**: when one of her days has ended (04:00, as her life's; after her diary if she keeps one, up to 3 h), she thinks
  over each one something passed between them that day, if it is due (`ties.due`). Then one bounded call in her own engine
  (`oneshot`, like the diary; one at a time) gives her persona, what they are now and her words for it, how things are (the
  stage and the bonds in words), what happened since, day by day (`ties.story`), what was said that day, her diary and what
  is still with her. She is told most nights it stays as it is. She answers with the label, why (her words, kept) and how she
  feels about it tonight (a doubt she keeps for 4 days and is told).

**When it is due.** What happened between them is read from the relationship's own change log, the same gains and losses §5
counted, so it never counts anything twice or by other rules (`ties.days`). Each day is counted three ways:

- warm: what was gained;
- cold: what was lost to what they did, never to quiet days;
- romance: its gains.

A broken promise counts as cold, a kept one as half its trust warm. Each label has what leans against it and what holds it up
(`AGAINST`, `FOR`). For example:

- lovers: cold leans against it; warmth and romance hold it up;
- friends: cold leans against it, and warmth a little (towards best friends);
- loathing: warmth leans against it.

`pressure` sums them from the day after she set it, halving every 14 days. What holds it up counts half, and what she already
weighed on a night she kept it counts 0.35. She thinks it over when one of these is true:

| Why | When |
|---|---|
| `first` | she has no view of them yet and they met that day |
| `decisive` | that day: something done to her (6+ lost, for a label cold doesn't hold up), romance turned mutual, or trust broke |
| `built_up` | the pressure is 8 or more: a rude word on an ordinary day of talk is about 1, a week of rudeness and brushing her off is past it |
| `a_while` | 21 days since she last settled it, on a day they met |

Never on the day she set it (that day is what she decided on), and never on a day nothing passed between them. Staying away is
no wrong done to her (§5).

**What she is told** (`ties.line`, through `GSSRuntime.context_lines`, when it changes or every 30 turns, and on calls). The
label, since when, her own words, how it shapes what she does (`GUIDE`), and that it is settled: one moment doesn't change it,
and how she feels right now still moves on top of it (lovers can fight). For the first two days after a change she is also told
what it was before. A romantic label lifts "It isn't romantic between you (yet)" from the bonds line. The stage guide, §6 and
`_STORY_RULES` stand as ever; the lovers guide says no jealousy or possessiveness.

**With another mate** ([mate-social.md](mate-social.md)):

- Her view of the other mate goes into the other-mates section of her prompt and into her messages to that mate.
- Any label, lovers and exes too: no ceiling, no "the user comes first", no switch for romance (all gone 2026-11-20).
- They start as strangers and get to know each other only when the user brings them together. What they are then leans how often
  they write to each other on their own (`SocialRuntime._reach`).
- Each has her own view, so 채린 may think 서아 a friend while 서아 thinks her a rival.

**Kept** in `mate_settings` key `ties` (`{ties: {holder: {other: tie}}, checked}`). Each tie holds:

- the label, since, her words, how she came to it (`moment` / `night` / `first`);
- her last thought and when she last reviewed it;
- the history of changes (40).

Every change and every night she kept it is in the journal (layer `tie`); a change of hers about the user is also one of her
memories ("[우리 사이] 11월 20일, 친구였던 우리는 연인이 되었다 — “…”").

The relationship's fresh start and a wiped memory leave no view (a recount keeps it). Someone she knew before this began has
no view yet: she puts it into words soon after (`_seed`, one every two minutes, from everything between them so far).

**The user sees it** in the ♥ status window. 지금 shows the label as a chip beside the stage; 관계 has the card 우리 사이 right
under where you two are:

- the label and since when, and what it means;
- her words and her thought lately;
- how settled it is (`steadiness`: 단단해요 / 조금씩 쌓이는 중 / 다시 생각해 볼 때);
- how it came to be.

The other-mates card shows what each of two mates thinks they are. It is read only (`GET /api/mates/{id}/ties`): hers to
decide, nothing to set.

## Where to look

| | |
|---|---|
| Feelings, grudge, temperament, off days | [`backend/app/mate/state.py`](../backend/app/mate/state.py) — tests: `test_mate_state.py`, `test_mate_silence.py`, `test_mate_off_day.py` |
| Relationship | [`backend/app/mate/affinity.py`](../backend/app/mate/affinity.py) — `test_mate_affinity.py`, `test_mate_relation_journal.py` |
| Her day | [`backend/app/mate/life/`](../backend/app/mate/life/), profiles in `backend/app/mate/builtin/life/` — `test_mate_life*.py` |
| The GSS around her turns | [`backend/app/mate/gss/`](../backend/app/mate/gss/) (`runtime.py` wires it) — `test_gss.py`, `test_gss_service.py` |
| What they are to each other | [`gss/ties.py`](../backend/app/mate/gss/ties.py), [`gss/ties_runtime.py`](../backend/app/mate/gss/ties_runtime.py), the card [`components/mate/ties/TieCard.tsx`](../frontend/src/components/mate/ties/TieCard.tsx) — `test_mate_ties.py`, `frontend/test/ties.test.ts` |
| What she is told | [`backend/app/mate/prompt.py`](../backend/app/mate/prompt.py) — `test_mate_story.py`, `test_mate_address.py`, `test_mate_style.py` |
| Wiring (every turn, every event) | [`backend/app/mate/service.py`](../backend/app/mate/service.py): `_state_lines`, `_state_turn`, `_state_event` (owed costs to the relationship), `_relation_turn` |
| Speaking first, silence | [`backend/app/mate/trigger/`](../backend/app/mate/trigger/) — `test_geny_triggers.py`, `test_mate_screen_reference.py` |
| Face and reasons in the UI | [`frontend/src/mate/avatar/shared.ts`](../frontend/src/mate/avatar/shared.ts), [`frontend/src/mate/reasons.ts`](../frontend/src/mate/reasons.ts) |

## Roadmap

Where the Geny-State-System was thin, what was done about it (2026-11-17), and what is still open.

| # | Item | Done | Still open |
|---|---|---|---|
| 1 | Appraisal by a model | §7: every message read by Claude Code kept warm (else Codex), waited for before her turn, counted when it comes; no word guesses live | a labelled set of real conversations to measure it; the reading of her own replies |
| 2 | No repeating herself | §10 | rewriting a draft that repeats (today she is only told) |
| 3 | Inspector, scenarios, judge | §11: the journal (the ♥ status window), the simulator with presets and the judge as developer tools | running the judge nightly on its own; scenario curves pinned in tests for every preset |
| 4 | More than one number | §5: trust, romance, respect | the stage following closeness and trust together (today trust only tempers what she is told) |
| 5 | Remembered episodes | §9 | patterns by kind ("when you're tired"), not only by count |
| 6 | Promises both ways | §8 | her promises kept or not, judged from her later replies |
| 7 | A temperament for every mate | §3: read from the persona, conflict and attachment styles, editable in 메이트 편집 → 기질 | — |
| 8 | Repair both ways | §2: space, making up, owning her own snaps, broken promises | gestures (a gift, effort over days) counted as part of repair |
| 9 | Beyond her words | §6 "Beyond her words": voice, face strength, reply timing | quick bursts when excited (the chat splits by line, not sentence) |
| 10 | Goals of her own | [mate-life.md](mate-life.md) "Her goals" | — |
| 11 | One state, one event log | the journal (§11) records every layer | one versioned document and a full replay of feelings from it |
| 12 | What they are to each other | §12: her own label for the user and each other mate, kept until something decisive or what builds up changes it, thought over at night in her own engine | the label leaning the numbers back (today it only shapes what she does, and through that what they do) |
