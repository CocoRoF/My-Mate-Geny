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

## What she decides

`do_activity` (offered while she has a day) takes her anywhere she decides to go, ahead of her routine. The tool holds only what isn't up to
her: that the activity exists, that the place is open, that she can pay. She can walk out of work; the prompt says she knows what that means.
Asking her along from the map is a message like any other, and she decides. Together (`with_user`) the way there is five times shorter, it warms
her, it is on them, her messages stop being by phone, and she stays while they keep talking.

## Raising

- **Skills** (`work`, `gaming`, `stamina`, `cooking`, `sense`, `courage`) grow slowly with what she does (`GROWTH`: a year of her life, not a week), less
  when she is frazzled, and they matter: stamina tires her less, work pays more, what she is good at draws her, courage makes crowds easier.
- **The plan** is nine slots of the week (each evening, weekend days and evenings). A suggestion leans her (`PLAN_LEAN`); she knows about it, and tired or
  hungry she does as she likes. Workouts and cooking hardly happen without one: that is what raising her is.
- **Story events** (`builtin/life/<key>.events.json`) have conditions on place, activity, day, hours, weather, skills, needs, money, relationship
  stage, flags and how long she has had a day, a chance per hour, and `once` or `repeat_days`. They change her needs, skills, money and flags and move how she
  feels with their title as the reason. She hears what happened (`says`) with the next message, told how long ago. Never one on top of another (`EVENT_GAP`).
- **Her journal**: each day (ending at 04:00) is summed up, with a few lines she writes herself. That is a bounded tool-less model call, only while someone
  still talks to her (`diary.TALKED_WITHIN`), and only tried once a day.
- **Gifts** cost coins, and coins come only from talking to her, a little a day. What a gift does happens at once, and how she takes it is hers: she hears
  right away if she can, else with their next message. What she keeps she is told she has.

## Her body

Clips of `kind: "life"` with a `doing` (eat, drink, game, read, walk, workout, work, sleep) leave her home pose and come back to it, in every set. While
idle she plays those for what she is doing, with her usual breathing among them; talking and listening go on as ever; asleep she has a clip of her own,
else she dozes. She changes into pajamas for bed and back in the morning, unless they are with her, she doesn't change clothes herself, or someone changed her
meanwhile. The clips of an existing set are encoded into its own box, so what is out there under its URLs stays as it is.

## What she is told

The system prompt says she has a life (stable, cached) and lists what she can do. The per-turn `<context>` says where she is, what she is doing, how her body is
and what is next, only when it changed (like how she feels). She answers from there: briefly between tasks at work, groggily when a message wakes her. A message
reaches her by phone wherever she is, unless the user is with her. When reach-out is on she may write first about news (`share`), or stay `[SILENT]`.

## Files

`app/mate/life/sim.py` (pure), `profile.py` (her world as data, checked), `runtime.py` (the clock, the one way in), `diary.py`; `builtin/life/*.json`;
`components/mate/life/` (the backdrop, her status on the stage, the Life panel); `builtin/assets/chaerin/places/` (ten places at four times of day, her map).
`prefs.life`: auto (on for a mate who comes with a world of her own), on (anyone else gets `default.json`), off. A memory wipe starts her day again.
