# Mate life: a day of her own

The Mate is no longer only someone you talk to. She lives: on the real clock she gets up, goes to work, gets hungry, plays,
falls asleep; she is somewhere, doing something, and that shows behind her, in how she talks and in what she can say yes to.
You look after her, spend time with her and help her grow, in the spirit of a raising sim. Chat and avatar stay exactly what they
are: this is what is around them.

Designed for 한채린 (a QA engineer by day, a guild master by night), and data-driven so that any mate can have it.

## What it must never be

- **No punishment for being away.** She doesn't starve, sicken or die while you are gone. She lives her day and is glad when you
  come. Needs have ceilings and she looks after herself. She never guilt-trips (`_RELATION_RULES` already says so).
- **No rule gates on what she does.** As everywhere in the Mate (see `state.py`): state and reasons lean her, she decides. The
  engine only refuses what is impossible (a place that is closed).
- **Numbers stay out of her mouth.** She is told words, the UI shows the bars.
- **Affection is warmth.** The "affection" need is wanting closeness and attention; nothing sexual, ever (`_STORY_RULES`).
- **The model proposes, the engine decides.** What the model says never moves a number directly. Tools are validated and clamped.

## Time

Real time in the user's time zone (`store.tz()`), not game time. The simulation is pure and lazy: `advance(doc, profile, now)` replays
five-minute steps from `doc.at` to `now`, seeded by mate and minute, so being away for a week comes out the same whoever asks.
A background ticker runs it once a minute for mates who have it on, and announces what changed (`mates.changed`, reason `life`).

Slots of the day: morning 5–11, day 11–17, evening 17–20, night 20–5. They choose the background.

## Needs

Five pressures, 0 (fine) to 1 (urgent), that drift with the hours and fall with what she does:

| need | ko | rises | falls |
|---|---|---|---|
| `hunger` | 배고픔 | always | eating |
| `sleep` | 피로 | awake | sleeping |
| `affection` | 애정 | always, slowly, faster the closer you are | talking, being with you, kindness |
| `fun` | 놀이 | always, faster at work | playing |
| `stress` | 스트레스 | work, crowds, being broke | rest, play, a walk |

They feed `state.py` as floors with reasons, the way "it's late" already feeds `sleepy`: hungry → snappish, tired → sleepy, bored → low,
wanting affection → lonely, stressed → worried. So they reach her words and face through the emotion system that exists.

## Places and activities

`builtin/life/<key>.json` (else `default.json`): places (name, description, open hours, how crowded, travel time, backgrounds by slot),
activities (where, how long, what they do per hour to needs and stats, cost, how she likes them, what her body does), routine blocks.

What she does next is utility, not a script: obligations (work, sleep, a raid night) outweigh, and in the free time what relieves her
needs, what she likes, what she can afford and a seeded bit of chance compete. Changing place takes time on the street.

## What she is told

The system prompt says she has a life (stable, cached). The per-turn `<context>` says where she is, what she is doing, how her body is
and what is next, only when it changed (like how she feels). She answers from there: briefly between tasks at work, groggily when a
message wakes her. A message reaches her by phone wherever she is, unless the user is with her.

## Milestones

1. **A day of her own** — needs, places, activities, routine, simulation, ticker, API, prompt, needs into emotions.
2. **Places** — backgrounds for every place and slot, the stage behind her, weather, the status on the stage, the Life panel.
3. **Together** — `go_to` and `do_activity` tools, inviting her from the map, feeding her, gifts, tucking her in.
4. **Raising** — stats that grow, a weekly plan she mostly follows, money, story events with conditions, her diary and a daily report.
5. **Her body** — clips for what she does (eating, playing, working out…) in every outfit, pajamas, dressing for where she goes.
6. **Reaching out** — she writes first when something happens, the diary in her own words, the desktop app, a last pass over everything.

Each one is deployed when it is done.
