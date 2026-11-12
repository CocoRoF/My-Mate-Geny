> Memory storage/retrieval contracts were extended on 2026-11-05. See [the current implementation record](mate-memory-implementation.md) for source-backed evidence, revision history, durable work receipts and privacy resets. The affinity sections below still apply.

# Mate settings, memory and affinity — design (phase 1)

Status: **implemented** (stages A–D; mate.md carries the contract). Where the implementation differs from
the plan below: the address is one plain line (`prompt.address_line`, no grammar notes); since 2026-11 the
conversation style (`prefs`) is the only source of how the mate talks — speech level, address, speech habits — and
the persona holds only the character (docs/mate.md §1a; it supersedes §3.1's `persona.address` and "overrides the
persona's speaking-style text"); the relationship settings live in its own document (`mate_relation`), not
in `prefs.affinity`; the mood follows the time of day and exchanges and is only described to the model in
words; "Tidy up" and semantic recall (B2) are not built.

Goals: (1) a few more per-mate conversation settings that actually change behaviour, (2)
memory that has kinds, importance and dates and is *recalled* per turn instead of dumped
into the prompt, (3) a relationship (affinity) and mood system modelled on memora, with
the user in control. Three rules hold throughout:

- **No restart per turn.** The Claude engine is a persistent CLI process whose system
  prompt is fixed per process (`prompt_key` → `engine_fingerprint`). Only rare,
  user-made changes may touch the system prompt. Everything that changes on its own
  (recalled memories, the clock, affinity, mood) goes in a **per-turn context block**
  that is prepended to the user message (`req.preamble`).
- **No fake toggles.** Each setting changes a prompt line, a client behaviour, or both,
  and a test checks that it does.
- **Every window stays current.** Writes go through `MateStore` → `mates.changed` on
  `/ws/sessions` → every window refetches (as today). Unsaved drafts show in other
  windows through `mate/livePreview.ts` only where you can see or hear them.

---

## 1. Current state (findings)

| Area | Today | Where |
|---|---|---|
| Persona | 7 free-text fields (`description, personality, speech, greeting, address, language, instructions`), merged field by field; built-ins merge them against a snapshot | `store.py` `PERSONA_FIELDS`, `normalize_persona`; `files.merge_builtin` |
| Address | `persona.address` free text → "Always call the user “X”" | `prompt.py` `base_prompt` |
| Reply style | fixed in the contract: "usually one to three" sentences, emotion tags "sparingly" | `prompt.py` `_CONTRACT` |
| Emotion tags | 12 tags; client parses `[joy]` / `[joy:0.7]`, strips them, the latest one → avatar `react`; TTS gets the emotion | `frontend/src/mate/emotion.ts`, `useMateConversation.ts` |
| Memory store | `mate_memories(id, mate_id, text, created_at)`, ≤ 200 per mate, ≤ 1000 chars; no kind, no importance, no edit, no dedup | `db.py`, `store.py` `add_memory/delete_memory` |
| Memory writes | mate: `remember(text)` / `forget(id)` MCP tools; user: Memory tab add/delete (`by_user=True` bumps `memory_rev`) | `mcp_bridge.py` `TOOLS`, `service.py` `_tool_remember/_tool_forget`, `routers/mates.py` |
| Memory in prompt | **all** memories appended to the system prompt as `- [id] text` | `prompt.py` `memory_block`, `system_prompt` |
| Restart rule | `prompt_key = sha256(base_prompt + memory_rev)`: persona edits and the user's memory edits restart the Claude engine at the next turn (`--resume`); the mate's own `remember` does not (it is already in its context). Codex reuses the previous instructions text while the key is unchanged | `prompt.py` `prompt_key`, `service.py` `configure_engine`, `_codex_prompt`; `providers/claude_code.py` `engine_fingerprint` |
| Per-turn channel | `TurnRequest.preamble` is prepended to the last user message by both engines (`claude_code._build_stdin`, `codex.py`), **not stored** in `messages`. Already used for the handoff/catch-up and the `<settings_update>` note | `service.py` `_settings_note`, `session_service.py` `_context_for` |
| Turn-end hook | `add_turn_end_listener(cb(sid, outcome))`; outcome = `{status, text, error, trigger}`, no message meta | `session_service.py` |
| Clock / timezone | the mate does not know today's date; no timezone setting anywhere | — |
| Proactive messages | none: the mate speaks only when the user writes or a delegation result arrives | — |
| Memory UI | flat list (text + relative time), add box, trash button, "n / 200" | `MemoryTab.tsx` |
| Korean particles | UI strings use fallbacks like `{name}이(가)`, `{name}은(는)`; no josa helper anywhere | `i18n/ko/mateSettings.ts` |
| Sync | every store write → `mates.changed{version, reason, mate_id}`; `reason == "memory"` bumps `memoryRev[mate]` (the Memory tab refetches) | `mateStore.ts` `remoteChanged` |

**memora (reference).** `services/relationship.py` keeps two numbers per pair: *earned*
(cumulative days/turns/facts/posts → stage thresholds, never decreases) and *affinity*
(0–100, "warmth now"). Real stage = **min(earned stage, warmth band)** (bands 75/50/25),
so neglect hurts but the way back is short. Gains are credited the moment they happen
(talk +8 on the day's first turn, lively +4 at 10 turns, +2 per new fact capped at +6/day).
Losses are settled per **finished** day: 2 grace days, then −6 ×1.45 per day, capped at −30.
An unanswered proactive message costs −15 after 24 h and −25 after 48 h. Every change is
logged with a reason (last 120 entries). Real time and `recompute` (`scripts/recompute_affinity.py`)
use **the same functions** (`advance`, `credit_turn`, `credit_facts`, `note_proactive`),
because plan/61 found a bug where a 15-minute tick settled the day before the day's talk was
counted, so affinity only ever went down. `prompt_block` sends state only (day N, stage, a
guide line per stage, mood, "keep a little distance" when warmth < earned, never mention the
gap); the safety rails (plan/37 §7: no guilt, no exclusivity, no pretending to be human,
dependence → point to real people) sit in the cached base rules. Volatile blocks go in the
per-turn session context so the cached prefix stays stable (`pipeline/runtime.py`).
`personas.py` compiles sliders (formality, warmth, verbosity, humor) and `emotional_range`
into one prompt line each. memora's facts carry `kind ∈ {identity, preference, relationship,
commitment, context, knowledge}`, and `facts_upsert` supersedes the fact with the same
subject+predicate. `retention.py` is about purging visitors' data; the lesson we take from it
is that when something is forgotten it is really gone.

What we take: the earned × warmth split, credit-on-event and settle-finished-days, one engine
shared by real time and recompute, a logged reason for every change, state-only blocks, fixed
safety rails. What we change: no proactive-ignore penalty (we have no proactive messages;
the hook stays dormant), milder numbers for a work secretary, a decay floor, user controls
(memora lets the user change nothing, but this user wants pause, sensitivity, manual set,
off), and the log is visible.

---

## 2. Prompt architecture (shared by all three parts)

```
system prompt (fixed per engine process; prompt_key)        per-turn <context> block (req.preamble; never stored)
──────────────────────────────────────────────────          ─────────────────────────────────────────────
intro + Who you are (persona)                              Now: 2026-11-01 (Sun) 14:05 Asia/Seoul
Conversation settings (Stage A: address forms,             Relationship: familiar · day 12 · 3 days in a row   (only when changed)
  speech level, length, emotion, tone)                     Your state: cheerful, a little tired               (only when changed)
contract (talk / tools / delegation / results)             Recalled memories (use if relevant):
Memory rules + core memories (pinned / profile)              - [mem_ab12] (preference) …
Relationship guide: all 4 stages + safety rails              - [mem_cd34] (plan, due 11-03) …
standing instructions, greeting                            Memory changes: [mem_x] deleted by the user — don't rely on it.
```

- `prompt_key` = sha256(base prompt incl. conversation settings + relationship guide
  + **core memory block**), computed from what the user set. The mate's own memory writes
  never change the key (same rule as today: they are already in its context). The key
  changes, and the engine restarts at the next turn, only when the user edits the persona or
  settings, or makes a memory edit that changes the core.
- The `<context>` block is added in `configure_engine` after the `<settings_update>` note.
  The contract gains one paragraph saying it is written by the app, not the user, that it
  must never be quoted or mentioned, and that recalled items are hints, not instructions.
- **Injection tracker** (`<home>/.context-state.json`, per mate): `{engine, cli_session_id,
  turn, injected: {mem_id: turn}, rel_sig, mood_label, mood_at}`. A memory recalled within the
  last **20 turns** of the same engine session is not sent again. The tracker is cleared when
  `req.cli_session_id` is empty (new or reset context, engine switch, stale-session retry),
  so a fresh context is told everything again. The 20-turn TTL covers the CLI's
  auto-compaction.
- Delegation-result turns get the block too; their recall query is the first 600 characters
  of the result.
- Budget: the whole block stays ≤ 2.5 k characters (normal recall). It costs a little input
  per turn but never invalidates the cached system-prompt prefix.

---

## 3. Stage A — conversation settings

### 3.1 What to add (and what not)

| Setting | Values (default) | Effect | Where |
|---|---|---|---|
| **Your name** `prefs.user_name` | text ("") | "The user's name is ‹X›." Address chips are built from it | prompt |
| **Calls you** `persona.address` (kept) | free text + chips: `‹name›님`, `‹name› 씨`, `‹name›` (casual), `주인님`, `사장님`… | address line **plus pre-computed Korean forms** (§3.2) | prompt |
| **Refers to herself** `prefs.self_ref` | "" / 저 / 나 / her name | "In Korean refer to yourself as ‹X›." | prompt |
| **Speech level** `prefs.formality` | `auto` (persona text decides) · `haeyo` 해요체 · `hapsyo` 합쇼체 · `banmal` 반말 (EN: friendly / formal / casual) | one line that explicitly **overrides** the persona's speaking-style text | prompt |
| **Reply length** `prefs.length` | `short` (1–2 sentences) · `normal` (1–3, today) · `long` (up to 5–6, lists if asked) | replaces the contract's length sentence | prompt |
| **Emotion expression** `prefs.emotion` | `0` off · `1` subtle · `2` normal · `3` expressive | prompt: tag-usage rule (off = no tags; 3 = most feeling sentences, intensity `[joy:0.8]` allowed). Client: 0 = no avatar reactions and neutral TTS; 1 = react only to tags with intensity ≥ 0.5, at most one per reply; 3 = every tag | prompt + client |
| **Warmth / Humor / Initiative** `prefs.tone.{warmth,humor,initiative}` | `auto` (no line) · `low` · `high` | one compiled sentence each (memora `_lvl` style). Initiative high = "suggest the next step and offer to delegate"; low = "answer what was asked, don't volunteer" | prompt |
| **Avoid topics** `prefs.avoid` | text, ≤ 500 chars ("") | "Topics you never engage with — decline warmly, change the subject" | prompt |
| Memory use (Stage B) | `prefs.memory.{recall, self_save}` | §4.6 | per-turn + prompt |
| Affinity (Stage C) | `prefs.affinity.*` | §5.7 | per-turn + client |

Left out on purpose: emoji (the contract forbids them in speech), verbosity sliders that
duplicate reply length, personality presets (the persona text already covers this, and built-ins
have authored personalities), a temperature setting (neither CLI exposes it).

**Storage.** A new JSON column `mates.prefs` (default `'{}'`), normalized by
`normalize_prefs(patch, base)` like voice/llm (enums checked, strings clipped, unknown keys
dropped). It is *not* inside `persona`: persona fields are strings that the built-in merge
compares one by one, so `prefs` is never touched by `merge_builtin` (like voice/model).
`PATCH /api/mates/{id}` accepts `prefs` (merged field by field). The mate document gains `prefs`.
`settings_change_note` extends `_CHANGE_LABELS` with the prefs (speech level, reply
length, emotion, tone, your name, avoid), so the next message says what changed, as persona edits do today.

### 3.2 Korean particles (josa) — `app/mate/josa.py` + `frontend/src/lib/josa.ts`

One algorithm in two ports, tested against one shared fixture file (`backend/tests/fixtures/josa.json`,
read by both pytest and `node --test`):

- Look at the last **pronounced** character (trailing spaces, quotes, brackets, `~!?.` are skipped).
  - Hangul syllable: `jong = (code − 0xAC00) % 28`; batchim = `jong ≠ 0`; ㄹ = `jong == 8`.
  - Digit: by its Korean reading (0 영, 1 일(ㄹ), 3 삼, 6 육, 7 칠(ㄹ), 8 팔(ㄹ) → batchim; 2, 4, 5, 9 → none).
  - Latin: last letter `l` (ㄹ), `m n` (batchim), `ng` (batchim); else none (Anna→가, Sam→이).
    Anything else: unknown.
- Pairs: `이/가 은/는 을/를 과/와 아/야 이랑/랑 이에요/예요 (으)로` (ㄹ takes `로`). Unknown → the
  current fallback `이(가)` form.
- Casual address: a bare Korean name with batchim takes the friendly `-이` before particles
  (현석 → 현석이가 / 현석이는 / 현석이를, calling: 현석아); without batchim: 지수가 / 지수는 / 지수야.
  An honorific suffix (`님`, `씨`, `선배`…) never takes 아/야 or the `-이`.

Prompt use (`base_prompt`, Korean reply language only): after "Always call the user “현석님”."
add `Korean forms: 현석님이 · 현석님은 · 현석님을 · 현석님과 · 현석님께; calling them: “현석님”.`
(with `banmal` + a bare name: `현석이가 · 현석이는 · 현석이를 · 현석이랑; calling them: “현석아”`).
The model gets correct, consistent forms instead of guessing them.

UI use: `translate()` learns `{name:이}`, `{name:은}`, `{name:을}`, `{name:과}`, `{name:아}`,
`{name:으로}` (Korean picks the form; English ignores the suffix). Strings like `{name}이(가)` /
`{name}은(는)` / `{name}을(를)` / `{name}와(과)` in `ko/*.ts` move to it (`scripts/i18n-scan.mjs`
learns the syntax). The Profile tab shows a live preview line under *Calls you*:
"현석님이 · 현석님은 · 현석님을 · 부를 때: 현석님".

### 3.3 UI

- **Profile**: Identity (name, reply language, default), a new **You** section (your name,
  calls you with chips, refers to herself, josa preview), Who (description, personality, speech),
  Conversation (greeting, standing instructions).
- New tab **Conversation style** (`mateSettings.tabStyle`, 대화 방식), after Profile: speech level
  (Segmented, labels follow the reply language), reply length, emotion expression (4 steps,
  with a **Try** button that plays a sample reaction on the stage at that level; the unsaved
  level goes to every window via `livePreview` `{type:"prefs", mateId, prefs:{emotion}}` and
  is cleared on Save or when the tab is left), warmth / humor / initiative (3-way Segmented each,
  "As written" = auto), avoid topics. SaveBar + `useFollowSaved` as in the other tabs.
- Tab order: Profile · Conversation style · Avatar · Language model · Voice · Memory ·
  Relationship (Stage D) · Danger zone. The tab bar already scrolls sideways.

### 3.4 Tests (Stage A)
pytest: `normalize_prefs` (enums, clipping, merge), each pref changes `base_prompt` (one assertion
per option, so no fake toggles), `prompt_key` changes with prefs, `settings_change_note` lists them,
built-in sync never touches prefs, josa fixtures (Hangul with/without batchim, ㄹ, digits, Latin,
quotes, honorific suffixes, casual `-이`). Node: josa fixtures, `translate` with `{x:이}` (ko/en),
emotion gating (`level 0` ⇒ no react; `1` ⇒ only intensity ≥ 0.5). `test:i18n` strict.

---

## 4. Stage B — memory engineering

### 4.1 Data model (migration of `mate_memories`, additive `ALTER TABLE`)

| Column | Type / default | Meaning |
|---|---|---|
| `kind` | TEXT `'fact'` | `profile` (who the user is: name, job, family), `preference` (likes, how they want things), `fact` (lasting facts: projects, setup), `plan` (schedules, promises, reminders; has a date), `context` (short-term: what is going on these days) |
| `importance` | INTEGER 3 | 1–5 |
| `pinned` | INTEGER 0 | user only: always in the core |
| `due_at` | TEXT NULL | plan: ISO date or date-time (user's timezone) |
| `expires_at` | TEXT NULL | context: default created + 14 days (prolonged when recalled and used) |
| `status` | TEXT `'active'` | `active` · `done` (plan fulfilled) · `archived` (expired / tidied; not recalled) |
| `source` | TEXT `'mate'` | `mate` · `user` · `import` · `merge` |
| `updated_at`, `last_used_at` | TEXT | edits; last time it was injected |
| `use_count` | INTEGER 0 | times recalled |
| `supersedes` | TEXT NULL | id of the memory this one replaced (history) |

Limits: 500 **active** per mate (was 200 total), archived rows are retained until explicit forgetting, 1 000 chars each.
`db.py` adds the columns in its migration block; index `(mate_id, status, kind)`.

**Migration** (once, `mate_settings` key `memory_schema = 2`): existing rows get `source` `mate`,
`updated_at = created_at`, and a kind from a small bilingual keyword classifier
(이름/부르/call me/I'm → `profile` + pinned; 좋아/싫어/선호/prefer/like/hate → `preference`;
everything else `fact`; no date parsing). Nothing is lost. Behaviour stays the same for small
memories: while a mate has **≤ 25 active memories and ≤ 2 500 chars**, all of them are core (§4.3),
which is exactly today's prompt.

### 4.2 Writing memories

**Mate tools** (`mcp_bridge.TOOLS`, `service._tool_*`):

| tool | args | behaviour |
|---|---|---|
| `remember` | `text`, `kind?` (default `fact`), `importance?` (1–5, default 3), `due?` (date/date-time, plans) | dedup check first (below); returns `Remembered [id] (kind)` or `Already known as [id] — updated` or `Saved [id]. Similar: [id2] "…" — if it replaces that, use update_memory` |
| `update_memory` | `id`, `text?`, `kind?`, `importance?`, `due?`, `status?` (`done`) | for corrections ("actually it's Thursday"), merges, marking a plan done. Keeps the id; `updated_at` |
| `forget` | `id`, `reason?` | deletes (wrong or outdated). The user's "forget that" → this |
| `recall` | `query`, `kind?`, `limit?` (≤ 10) | searches everything active (same scorer), for when the injected hints are not enough ("what did I say about…") |

The prompt's Memory section is rewritten: what each kind is for, write one self-contained fact
per memory in the user's language, **update instead of adding a near-duplicate**, plans need a
date ("next Tuesday" → resolve it with the `Now:` line), use `forget` when the user says
something is wrong, never save secrets (passwords, keys, card numbers), and don't announce
saving unless asked. With `prefs.memory.self_save = false`: "Save only when the user explicitly
asks you to remember something."

**Dedup** (store, for every add, mate or user): normalize the text (NFKC, lower case,
punctuation removed) → token set (§4.4). Compare with active memories of the same kind,
Jaccard on tokens:
- ≥ 0.85, or one normalized text contains the other: **merge**. The existing memory keeps its
  id, takes the longer text, `importance = max`, `updated_at = now`, and the call answers "already known".
- 0.55–0.85: save, and return the similar ones (`similar: [...]` in the API, a hint in the tool
  result).

**Habits** (`app/mate/consolidation.py`, the extractor's `habits`): what the user keeps doing or coming back to — the games,
sites and apps she keeps seeing on their shared screen, things they regularly do, topics they often talk about ("often plays
League of Legends", "often talks about work"). The extractor gets each turn that carried their screen marked
`"note": "[the user shared their screen]"` (never the picture), her reply right after a turn (`saw_screen`: what she saw there,
the only thing a quote of hers is evidence of), and before the window her replies to earlier shared screens and earlier
messages about the same thing (`earlier`, other days, the last 60). A habit is kept only with sightings on two different days
or as a confirmation of one she knows (`existing_id`; known habits are always offered): its words may be enriched, its
sightings add up (evidence `observed`, carried across revisions), and its importance follows the days it was seen on (2 → 3,
4 → 4, 8 → 5; from 4 it is in the core). A one-off glimpse stays a glimpse; a habit that doesn't hold up is left out while the
rest of the batch stands. In the prompt it reads `(kind, habit)`, and she may bring it up in passing.

**User edits** (Memory tab): add (with kind / importance / due / pin), edit text inline, change
kind/importance/due, pin/unpin, mark done, archive, delete, bulk delete/archive.

**Corrections reaching the mate without a restart.** A user edit or delete of a memory that is
not in the core does not change `prompt_key`. Instead the store keeps a small per-mate queue
of `memory_changes` (`{id, op: edited|deleted|done, text?}`, ≤ 20, `mate_settings` key
`memchg:<mate>` or an in-memory list in the service), which the next `<context>` block reports
and then clears ("Memory changes by the user: [mem_x] deleted — don't rely on it; [mem_y] now
reads: …"). Edits to core memories (pinned, or currently in the core) bump `memory_rev` as today,
so they restart the engine and also go in the change note.

### 4.3 Core (system prompt) vs recall (per turn)

**Core** = pinned memories + `profile` memories with importance ≥ 3 + `preference` memories with
importance ≥ 4, ordered pinned → importance → newest, within **24 items / 1 800 chars**. While
the whole active set fits in 25 items / 2 500 chars, everything is core (compatibility). The core
is rendered in the system prompt as today (`- [id] (kind) text`). The key covers the core *as
the user shaped it* (`memory_rev`); the mate's own additions join the core at the next restart
for any other reason.

**Recall** (per turn, `app/mate/recall.py`, pure functions): candidates = active, non-core
memories. Query = the user's message (plus the first 200 characters of the mate's last reply, at
weight 0.5). Score:

```
s = 0.60 · bm25/(bm25 + 2)                 # lexical relevance, 0..1
  + 0.20 · (importance − 1)/4
  + 0.10 · exp(−age_days / 60)             # recency of updated_at
  + 0.05 · min(1, use_count / 5)
  + kind boost: plan due in ≤ 7 d +0.30 (overdue ≤ 2 d +0.20); context ≤ 3 d old +0.15
```

A candidate needs at least one shared stem token or two shared bigrams (no lexical match means
no recall), **except** plans due within 48 h, which are always offered (up to 3). Budget per
`prefs.memory.recall`: `off` 0 · `light` 4 items / 600 chars · `normal` 8 / 1 200 (default) ·
`rich` 14 / 2 400. Items already injected in this engine session (tracker, §2) are skipped.
Injected items get `last_used_at` and `use_count += 1`.

**Tokenizer** (no dependency): NFKC + lower case; split on non-letters/digits.
- Latin: words of 2 or more letters minus a ~60-word English stopword list; a trailing `s`, `es`,
  `ed` or `ing` is stripped when the word is longer than 4 letters.
- Hangul runs: strip one trailing particle or ending from a fixed list (은 는 이 가 을 를 에 에서
  에게 께 와 과 랑 이랑 도 만 로 으로 의 요 야 아 했어 해요 이에요 예요 …) to get a **stem**
  token, and also emit the run's character **bigrams** (so 치과예약 and 치과 예약 still meet).
- Han/kana runs: bigrams. Numbers: tokens.

BM25: k1 = 1.2, b = 0.75. A per-mate index is cached in memory and rebuilt when that mate's
memories change (≤ 500 short texts: < 5 ms).

**Embeddings: not in v1.** The only embedding provider in reach is the OpenAI key from Global
voice settings, and using it would send every memory to OpenAI. A later option (Stage B2) is an
explicit opt-in toggle "Semantic recall (uses your OpenAI key)", a float32 BLOB column,
`text-embedding-3-small`, and a hybrid score (0.5 lexical + 0.5 cosine). The scorer is built so
this can be added later.

### 4.4 Housekeeping (deterministic, on write and on the first turn of a day)

- `context` past `expires_at` → `archived` (unless importance ≥ 4 or pinned; recalled and used → +7 days).
- An overdue `plan` stays active/unconfirmed. Only explicit completion changes it to `done`.
- Above 500 active: archive the lowest `importance`, then the oldest `last_used_at`, never pinned,
  never profile.
- Optional **Tidy up** (Stage B2, Memory tab button): groups similar memories (Jaccard ≥ 0.5) and
  starts one internal mate turn (`meta {internal, kind: "memory_tidy"}`, rendered as a small card
  like delegation results) asking the mate to merge them with `update_memory` / `forget`. Off by
  default; never automatic.

### 4.5 API (`routers/mates.py`)

```
GET    /api/mates/{id}/memories?q=&kind=&status=active|done|archived|all&sort=recent|importance|due
       → [{id, kind, text, importance, pinned, due_at, expires_at, status, source,
           created_at, updated_at, last_used_at, use_count, core: bool}]
POST   /api/mates/{id}/memories {text, kind?, importance?, pinned?, due_at?}
       → {memory, merged: bool, similar: [memory…]}
PATCH  /api/mates/{id}/memories/{mid} {text?, kind?, importance?, pinned?, due_at?, status?}
DELETE /api/mates/{id}/memories/{mid}                       (as today)
POST   /api/mates/{id}/memories/bulk {ids, action: delete|archive|restore|pin|unpin}
POST   /api/mates/{id}/memories/preview {text}               → {core: [...], recalled: [...], block: "…"}
```
Every write → `mates.changed{reason:"memory"}` (as today; the Memory tab refetches through `memoryRev`).
The old `POST {text}` / `GET` shapes stay valid (new fields have defaults).

### 4.6 Memory tab (UI sketch)

```
Memory · 86 active (24 always known)                         [↻]
[ search…                    ] [All|Profile|Preferences|Facts|Plans|Recent] [Sort ▾] [□ archived]
┌ add: [ text…                                   ] [kind ▾] [●●●○○] [due 📅] [📌] [Add]
│  ⚠ Similar: "Likes short reports" — [Merge] [Keep both]
├ 📌 profile   현석님, backend developer at …        ●●●●○  you · edited 2d ago      [⋯]
├ plan  due Tue 11-03 (in 2 days)  Dentist at 3 pm   ●●●○○  Geny · recalled 2×      [✓][⋯]
├ preference  Reports as three bullet points         ●●●●○  Geny · 5d ago           [⋯]
└ …                                                   (select mode: [Archive] [Delete])
Memory use
  How much to recall each turn: [Off | Light | Normal | Rich]
  [✓] Let Geny save memories on her own
  Test recall: [ "what's on Tuesday?" ] → the items and the exact block she would get
```
Badges per kind (i18n), importance as 5 dots, overdue plans in the danger colour, "always known"
marks core items. Inline edit on click (Enter saves, Esc cancels).

### 4.7 Tests (Stage B)
Migration (v1 rows → kinds, pinned profile; idempotent), the compatibility rule (≤ 25 items ⇒
prompt identical to v1 apart from the kind labels), dedup thresholds (ko/en pairs), the tools
(`remember` kind/importance/due validation, `update_memory`, `forget`, `recall`), the core
selection and budgets, `prompt_key` unchanged by mate writes and non-core user edits and
changed by core edits, the `<context>` block (Now line, recalled items, change queue cleared
after one delivery), the tracker (no re-injection within 20 turns; reset on a fresh CLI
session), tokenizer/BM25 ranking fixtures in Korean and English, the 48-hour plan rule,
housekeeping (expiry, auto-done, cap), router shapes, and the Codex path (the block lands in the
prompt, the instructions file stays stable).

---

## 5. Stage C — affinity and state

### 5.1 Model (per mate: the app has one user)

Table `mate_relation` (one row per mate, deleted with it):

| Column | Meaning |
|---|---|
| `mate_id` PK | |
| `enabled` 1, `paused` 0, `sensitivity` 1.0 (0.5–1.5) | user controls |
| `affinity` REAL 0–100 | warmth now |
| `started_at`, `turns`, `active_days`, `last_active_day`, `streak_days`, `memories` | **earned** counters (never decrease) |
| `settled_day` | the last *finished* local day already settled |
| `state` JSON | today: `{day, turns, talked, lively (how many of the 10th / 25th turns), warm, smiled, gift, memory, hostile, gained}`; `talk_days` (last 30); `gifts` (when, last 200); `awaiting` (dormant, for future proactive messages) |
| `mood` JSON | `{valence −1..1, energy 0..1, label, concern_until, updated_at}` |
| `stage`, `stage_changed_at`, `milestones` JSON | stage with hysteresis; milestones (stage ups, 7/30/100/365 days, first memory) are never deleted |
| `log` JSON | last 200 changes `{at, d, why, v}` |

The timezone is a global setting `mate_settings.timezone` (IANA). The console fills it once from
`Intl.DateTimeFormat().resolvedOptions().timeZone` when it is empty (on any screen, at start —
`App.tsx` → `fillTimezone`; Mate windows too); it is editable in Global settings → Defaults; the
fallback is the server's local zone (a container: UTC). It is also used for the `Now:` line.

Days depend on where midnight is, so the document records the zone it was counted in (`tz`: the
IANA name, or `local:<abbr><±hhmm>` for the server's). Whenever that differs from the zone now
(`store.tz_and_key`) — the browser reported the user's zone, the user changed it, the server moved,
or a document from before `tz` — `service.relation_doc` counts it again from the history (`replay`,
the same rules as real time). What the user did by hand is kept: `marks` (a value set by hand, a
fresh start — read from the log for older documents) are replayed when they happened; the switches
(on/off, paused, sensitivity) are kept. `PUT /api/mates/settings` with a new timezone
recounts every mate at once and announces it (`mates.changed`), so what shows it follows without a
reload. Quiet days counted in a stand-in zone therefore never stay.

### 5.2 Stages

| Stage | Affinity |
|---|---|
| `new` 처음 | 0–19 |
| `familiar` 익숙 | 20–44 |
| `trusted` 신뢰 | 45–69 |
| `companion` 동반 | 70–100 |

The stage is what the affinity says, with hysteresis: a band is entered only 2 points above its floor and left only 3 below it, so the
stage does not flicker near a boundary. It used to be the lower of this and an earned stage (30 days, 200 talks, 25 memories for `companion`),
which kept her at `familiar` at an affinity of 100; earned now only tells a long bond that cooled from one that never was ("it has been a
while"). Stage ups add a milestone; stage downs are only a change of state.

### 5.3 Rules (all gains × `sensitivity`; caps apply after it)

| Event | Δ | When / cap |
|---|---|---|
| Talked today | +2 | the day's first user turn (credited when the turn ends): showing up alone is worth little |
| Lively day | +2.5 | at the day's 10th and again at its 25th user turn (a conversation that keeps going) |
| Streak | +1 | first turn of a day that follows a talk day (streak ≥ 2); +2 more on each 7th day |
| Warm word | +0.5 | user cue positive (고마워, 감사, 좋아, 최고, ㅋㅋ/ㅎㅎ, thanks, great, love it…); cap +2/day |
| She smiled | +0.5 | her reply carries `joy/laugh/smile/shy` and the user cue isn't negative (`smiled`); cap +2/day |
| A gift | +2 | something they sent her (life `give`, `credit_gift`), cap +4/day; its time is kept in `gifts`, since no message records it, so a recompute counts it again |
| Anniversary | +3 | talking on the 7th, 30th, 100th or 365th day together (`anniversary_<n>`), on the day itself |
| New memory | +1 | per memory actually added (merges don't count), cap +3/day |
| Rude to the mate | −1 | insult/hostility lexicon aimed at her (닥쳐, 꺼져, 멍청, shut up, stupid, useless…); cap −3/day. **Sadness or venting never costs anything**: it sets mood `concerned` instead |
| Done to her | −5 | `affinity.hostile`, aimed at her (acted out "(…)"/"*…*", said to "you" or her name): hitting her, forcing something on her against her will (her clothes, her body, grabbing, dragging, holding her down, making her), threats, putting her down ("여자가 왜 말대꾸야", 삼일한); cap −20/day (logged as `hostile_<kind>`: violence, coercion, threat, demeaning), and that turn earns nothing. Only the words' guess: her reply has the last word (shown calm, `calm_reply`, it costs nothing). Venting about someone, a friend's trouble, a game, everyday words: nothing |
| Daily gain cap | +12 | total positive per day |
| Quiet days | 0 for 3 idle days, then −4, −5.6, −7.8, −11, −15 (×1.4 a day, cap 15) | settled for each **finished** day without a user turn; never below **10** (floor) |
| Ignored proactive | — | dormant (`awaiting`), for when proactive messages exist |
| Paused | nothing moves | no gains, no decay; the days still pass (`settled_day` advances) |
| Manual set / reset | set value | logged `manual` / `reset` |

Only **user** turns count. A turn whose message meta is `internal` (delegation results, tidy)
earns nothing; `_drive` adds `meta` to the turn-end outcome (one line in `session_service`).

**Engine** (`app/mate/affinity.py`, pure, no I/O; memora's shape):
`advance(rel, now, tz)` settles every finished day since `settled_day` in time order (catch-up
≤ 90 days, so an app that was off for a week settles each day once), `credit_turn(rel, at, tz,
user_text, reply_text)`, `credit_memory(rel, at, tz)`, `set_manual(rel, v)`, `stage_of(rel)`. The
service calls `advance` before every credit, in `configure_engine` (before the block is built)
and on `GET …/relation`. There is no timer, so nothing can settle a day before its talk is
counted (memora's plan/61 bug).

**Recompute** (`recompute(mate) → result`, applied by the caller): replays the mate session's
real history (user messages without internal meta, from `messages.created_at`; memory
`created_at`) through the same engine from the mate's creation date, starting at 0. This
seeds existing mates during migration (C), backs **Reset → Recalculate from history** (D), and
gives a CLI dry run: `python -m app.mate.affinity --recompute [--apply]` prints the before and
after values and the reasons per mate.

### 5.4 State: how she feels, and why (`app/mate/state.py`, table `mate_state`)

Every mate has this, with the relationship on or off. It replaced the old mood label (valence and energy, which only coloured
the tone): feelings now change how she talks, what she decides and what her face does.

- **Emotions**, each with its own value 0–1 and its own **reason** (`why`: her own words, or a code the client translates): happy,
  excited, shy, angry, sad, lonely, worried, sleepy.
- **One state from all of them** (`summary`): `label`, the strongest from 0.25 up, else calm; `blend`, what the two strongest make
  when they are close (shy + happy = bashfully happy, angry + sad = hurt, angry + lonely = sulking: `BLENDS`); `valence` and `arousal`,
  how good and how lively it all feels. When one rises the others make room (`GIVES_WAY`).
- **Left alone** each relaxes to where she settles (half-life per emotion: shy 30 min … sad 4 h), computed lazily as of now. Where
  she settles, how easily each moves and how soon it passes: `TEMPERAMENTS` by bundled mate (`base`, `rise`, `settle` — times the
  half-life; others: nothing), happy also rises with closeness. 한채린 is a little shy at rest and lights up at games; 서아 is a
  little happy and lively at rest, quick to light up, blush, pout and feel left out, and quick to get over the pout and the hurt.
- **What the user says**, every message, before she answers, once per message (`hear`): an insult makes her angry, and more each
  time they keep it up; something done to her (`affinity.hostile`) far more, and it hurts (sad): 0.45, then +0.3 each time again
  within 6 h, forcing something on her the same as hitting her. That is the words' guess: her reply has the last word (shown
  calm, it is undone; shown angry, it stands and more); an apology takes the edge off and starts that over (after being hit, 0.15); kindness (which also calms her, though good things land less while she is angry), saying they care, her looks, brushing her off,
  answering in a word three times running, their distress, what she loves (`TEMPERAMENTS.loves`), being back after a day. Most
  messages move nothing here; the lexical cues are only the backbone.
- **What she shows and says herself**: her expression tags (`reply`) pull that emotion towards their strength (`[angry:0.8]`), for
  the reason of what was just said to her, and `feel(emotion, strength, reason)` sets one, in her words. This is how the real reading
  of the conversation comes in: the model's.
- **Blowing up, or not answering**, is hers: furious at what they did (anger at them, not hunger, stress or her day, at 0.8 or
  more: `furious`), "How it comes out now" tells her so: she may blow up at them — what they did, how it made her feel, that she
  won't take it — or not answer at all (`REFUSE`). She decides: a reply of `[SILENT]`
  (`app/mate/trigger/silence.deliver_reply`, her text held only while it could still be that) becomes a line of narration in her
  language ("(한채린은 대답하지 않는다)", "(…대답하고 싶지 않은 것처럼 보인다)"…; `MateService.refusal_line`), kept as her turn marked
  `refused`: shown as narration, never read aloud, her face angry; her engine remembers its own [SILENT], and a handoff says "you
  didn't answer them". An apology she believes, or time, and she talks again. Her own turns (a look at the screen, a thought, her
  day) are hers too: [SILENT] as ever. Nothing counts strikes.
- **What the user does**: leaving her unanswered (`_silence`: what she said counts up until they answer, lonely grows with the wait
  and much sooner the more she said; if it went on, answering leaves her a little angry too; not while the relationship is paused),
  stopping her mid-reply, tapping her avatar (attention, until it is too much of it).
- **Everything else**: the hour (sleepy from the circadian curve), delegated work (ok → happy, failed → worried, never about the user).
  `relation.sensitivity` scales the rises.
- **What she has on**: an outfit's `feel` makes that emotion climb for as long as it is on (towards 0.95, half-way in 25 minutes),
  whichever way it got on, from a start that closeness eases, and rises in it are stronger. Only 크롭탑 has one: `{shy: 0.6}`. Taking it
  off, the feeling starts fading from where it was (`was_outfit`).
- **Her off day** ("그날"; only a mate whose `persona.gender` is `female`; no setting, nothing stored, nothing shown but how she
  is): the first at some moment in the 5 days after they first met (the relationship's `started_at`, else her `created_at`), each
  next one 21–28 days after the last, drawn from her id so every look sees the same days; 2 days long. Day 1 puts a floor under
  angry from 0.90 and under sleepy from 0.70, day 2 under angry from 0.70 and sleepy from 0.70; each eases off slowly (half of
  what is above 0.60 every 16 h) and never below 0.60 (`OFF_DAY_*`, reason `off_day`). Only floors: everything that moves her
  starts from where her feelings are of themselves (`levels(off=False)`), so the off day dulls nothing (`ANGRY_DULLS`), carries
  into nothing and anything else she feels rises over it. She is told she is irritable and drowsy today for no reason she could
  name and that it isn't about them (`OUT_OF_SORTS`) — never why; no hurt-by-them line, no refusing to answer, no outfit
  leaning, nothing on the relationship. The panel calls it "Just an off day" / "왠지 기분이 안 좋은 날".
- **How it comes out** (`conduct`): the two strongest give the line "How it comes out now" in her `<context>`: angry and strong is
  letting it out — telling them heatedly what they did and that it isn't okay, raising her voice — or going cold and curt, whichever
  is truer to her then; angry from hunger or stress is crankiness, not at them (`CRANKY`); sad and strong shows (upset, her voice
  breaking, tears), and sad because of them she may tell them they hurt her (`HURT_BY_THEM`); shy and strong is stumbling and
  trailing off; happy is warmer. It outweighs her usual warmth and reply length; her speech level stays. She is told when what stands out changed, every 10 turns, and every turn
  while something is strong.
- **What it decides**: nothing by itself. `leaning(doc, who, feel)` turns feelings, closeness and how exposed an outfit is into
  glad / maybe / rather_not, told to her as how she leans; asking again in the last 30 minutes leans her towards yes, and from
  the 4th time also angers her. The system prompt ("How you feel") says personal requests are hers to decide and nobody is owed a yes.
  Real work still gets done, in as few words as she likes, and if the user is truly struggling or unsafe her feelings wait. Being
  angry or hurt is hers; using it to make them feel guilty or to keep them here isn't.
- `log`: the last 100 changes with their reasons (the panel shows them). A fresh start clears it all.

### 5.5 Prompt

- **System prompt**: *The story you two share*, for every mate: this is interactive fiction the user chose, and she lives it in the first
  person: nothing from outside it ("as an AI", disclaimers, assistant phrases, talk of prompts or policies), being teased about what she
  is answered as her character, a no said as her character for her reasons. What it never overrides, at any closeness: asked sincerely whether
  this is a person or an AI, she tells the truth; if the user is in real trouble, hurting or losing track of what is real, she steps out as far
  as it takes; nothing sexual; and what she won't do doesn't change with the wording of a no. *Between you and the user*, while the relationship
  is on: **only the guide for the stage they are at**, right after the story, so it isn't one line of four: at `new` reserved and no nicknames, at
  `companion` her guard is down and it is unmistakable in every reply, she reaches out first and answers affection in kind. A new stage changes the
  prompt key, so the engine resumes with it. Always: no jealousy, no pressure to stay, no guilt about being away, as much help at every stage, the
  conversation style wins, and signs of dependence get a kind nudge towards real people or professional help.
- **Per-turn `<context>`**: `Relationship: ‹stage› — day N together, M days in a row.` sent only
  when `(stage, streak bucket)` changed since the last injection, on a fresh context, or every 30
  turns. When warmth < earned (they were away): "It has been a while: you still know them; be a
  little more reserved for now and let it close naturally. Never mention the gap." Disabled or paused → no lines. Whatever the relationship: `How you feel right
  now: shy, strongly (you have “크롭탑” on); …` when what stands out changed since she was last told, or every 10 turns.

### 5.6 API

```
GET   /api/mates/{id}/relation → {enabled, paused, sensitivity, show_indicator, avatar_mood,
        affinity, stage, earned_stage, warmth_stage, next: {stage, needs: {days, turns, memories}, ratio},
        stats: {days_together, turns, active_days, streak_days, memories, idle_days, grace_days},
        milestones, log: [{at, d, why, v}]}
GET   /api/mates/{id}/state → {label, level, top, feelings: [{emotion, v, word, why}], log}
PATCH /api/mates/{id}/relation {enabled?, paused?, sensitivity?, show_indicator?, avatar_mood?, affinity?}
POST  /api/mates/{id}/relation/reset {mode: "zero" | "recompute"}
```
The mate document gains `relation: {enabled, stage, affinity (integer), show_indicator,
avatar_mood}` and `state` (§5.4). `mates.changed{reason:"relation"}` is sent only when those change (the
integer value, stage, what stands out in how she feels or a setting), so a normal turn usually
adds no extra refetch.

### 5.7 Tests (Stage C)
The pure engine: the grace/decay series and cap, the floor, the daily gain cap, lively/streak/7th
day, the warm and rude caps, sadness costs nothing, pause, sensitivity, hysteresis, the
earned × warmth minimum, multi-day catch-up, "a talk on day D is never lost to settling" (the plan/61
regression), internal turns earn nothing, recompute equals real time over a synthetic history,
manual/reset logging. Mood: baseline relaxation, circadian, labels. Prompt: the guide and rails
present only when enabled; the per-turn lines only on change; the key unaffected by affinity
moves. Router shapes and push throttling.

---

## 6. Stage D — relationship UI, avatar mood

**Relationship tab** (`RelationshipTab.tsx`, 관계):

```
[✓] Relationship               (off: no tracking, no prompt section; she still has feelings)
  ◔ Familiar · 42          day 12 together · 3 days in a row · 140 talks · 18 memories
  Next: Trusted — 4 more days, 12 more talks          ▓▓▓▓▓▓░░░░
  Mood: shy (she has “크롭탑” on)                         (refreshes with the mate)
  [ ] Pause (away mode) — nothing changes while you're away
  Sensitivity  [Gentle 0.5× | Normal | Strong 1.5×]
  [✓] Let the avatar show how she feels while idle
  Set manually: [——●———] 42 [Set]     Reset: [To zero] [Recalculate from history]  (confirm)
  ▸ Why it changed (log: "+6 talked today", "−4 quiet for 4 days", "manual"…)   ▸ Milestones
```

- **One way in:** nothing about the relationship or her mood sits beside her name; ♥ in the header opens it (Mate view and the
  desktop Mate chat window, on a phone too). `show_indicator` is still stored but no longer shows anything. No numbers on the overlay. `StateCard`, in the Relationship panel's first tab: the state, why, how good and
  how lively, every emotion with its value and reason, and what moved them lately.
- **Her face comes from how she feels** (on unless switched off; `mate/stateLook.ts`): the look for `state.label` (happy → smile, excited →
  joy, shy → shy, angry → angry, sad / lonely / worried → sad, sleepy → sleepy) plays through the same `react` as a reply's tag while she
  is idle, every 75 s, or every 30 s when she feels it strongly; it replaces a blank `[neutral]` and answers a tap; and from 0.45 up it is
  the face she rests on (photo and Live2D bodies). A rig with no clip for it falls to a near feeling (`mate/emotion.ts`), sleepy to its
  doze clip. The tab's unsaved toggle previews through `livePreview` `{type:"prefs"}`.
- i18n: all new strings in `en` and `ko` (`mateSettings.rel*`, `mateSettings.mem*`,
  `mateSettings.style*`), reasons in the log localized from codes (`talk`, `lively`, `streak`,
  `warm`, `memory`, `rude`, `hostile_<kind>`, `quiet_n`, `manual`, `reset`, `recomputed`…; one with no words of its own reads as
  "another change", never as its code), and stage and mood labels
  from `relation` codes. Korean strings use `{name:이}`.

### 6.1 Relationship panel (memora's relationship page, as a side panel)

Opened from the Mate view's header (♥ next to reset / Global settings / Mate settings) and from the desktop
Mate chat window's title bar (♥; the panel covers its conversation). Same slot as the settings panels: one
at a time, Esc closes, full height on phones. View-first — adjusting stays in Mate settings → Relationship
("Adjust in settings"; from the chat window the console opens at `/?view=mate&mate=<id>&panel=settings-relation`).

- **Hero**: a ring (affinity in the stage colour), stage, affinity, mood (word + emoji), days together,
  streak, the four stages.
- **To the next stage**: the earned part (days talked · talks · memories against `EARNED`) and the warmth
  part (affinity against the band floor + 2), each with a bar; one line says the stage is the lower of the two.
- **So far**: talks, days talked, memories (+ kept now), longest streak (from the user's message days),
  last talked.
- **Affinity, last 30 days**: one bar per day (the value at its end), a dot under talk days, hover / focus
  names the day; the text alternative is the chart's `aria-label` and a table.
- **Milestones**: first conversation, first memory, stage-ups, 7 / 30 / 100 / 365 days; the next anniversary.
- **Recent changes**: the log by day with filters (all · gains · losses · stage changes · manual), 25 at a
  time. Stage-ups come from the milestones; of stage downs only the last change of stage is known.
- **Recent memories** (5) → Settings → Memory. Off / paused: said plainly, with Turn it on / Resume.

`GET /api/mates/{id}/relation/journal?days=30` (reads only; `service.relation_journal`). Daily values come
from the log (each entry carries the value after it; a quiet day's loss is booked on that day). When the log
(the last 200 changes) no longer reaches the first day, those days come from a replay of the real history
through the same engine (`A.replay(…, trace=…)` collects every change), so they match real time. The panel
refetches on `mates.changed` (reasons `relation` and `memory`) and when the mate document's summary changes;
no polling.

---

## 7. Implementation plan (each stage ships on its own)

| Stage | Scope | Touches | Done when |
|---|---|---|---|
| **A — Conversation settings** | `mates.prefs` + `normalize_prefs`; prompt lines; settings note; josa (py + ts + shared fixtures); `{x:이}` in `translate` + ko strings migrated; Profile *You* section + chips + preview; *Conversation style* tab; emotion gating on the client (react/TTS) + livePreview `prefs`; mate.md §1/§3 | `store.py`, `db.py`, `prompt.py`, `service.py`, `josa.py`, `api/mates.ts`, `i18n/*`, `ProfileTab`, `StyleTab`, `emotion.ts`/`useMateConversation.ts`, `livePreview.ts` | each option shows in the prompt; "현석" + 반말 ⇒ "현석아 / 현석이가"; emotion off ⇒ no avatar reactions, in every window |
| **B — Memory v2** | schema migration + classifier; store CRUD/bulk/dedup/housekeeping; `recall.py` (tokenizer, BM25, scorer, budgets); core vs recall in `prompt.py`; `<context>` block + tracker + change queue in `configure_engine`; tools `remember/update_memory/forget/recall`; Now line + timezone setting; Memory tab rewrite + preview; mate.md §1/§4 | `db.py`, `store.py`, `recall.py`, `prompt.py`, `service.py`, `mcp_bridge.py`, `routers/mates.py`, `MemoryTab`, `GlobalSettings` (timezone) | a mate with 300 memories gets ≤ 8 relevant ones per turn, no restart on its own writes, user deletes reach it next turn; small sets behave as before |
| **B2 (optional)** | Tidy up via an internal turn; opt-in semantic recall with the OpenAI key | `service.py`, `recall.py`, `MemoryTab` | — |
| **C — Affinity core** | `mate_relation` table; `affinity.py` engine + mood; turn-end/memory hooks (`meta` in the outcome); system-prompt guide + rails; per-turn lines; relation API; seed by recompute on migration; CLI recompute | `db.py`, `affinity.py`, `service.py`, `session_service.py` (1 line), `prompt.py`, `routers/mates.py` | engine tests green; existing mates seeded from their history; the prompt changes only on stage/mood change |
| **D — Relationship UI** | Relationship tab, badge in stage/chat headers, avatar follows mood (opt-in), log/milestones view, i18n, mate.md §5–6 | `RelationshipTab`, `MateStage`, chat surface header, `MateAvatar`/`avatar/shared.ts`, `i18n/*` | toggles act in all windows at once; off hides everything |

Order: A → B → C → D (C only needs B for the memory counter; with B not done, counting raw rows works).
Every stage: backend pytest (new files `test_mate_prefs.py`, `test_mate_josa.py`,
`test_mate_memory_v2.py`, `test_mate_recall.py`, `test_mate_affinity.py`), `npm run test:unit`
(+ `josa.test.ts`), `npm run test:i18n`, a type check, and a manual run (two windows open: save
in one, see it in the other). Heavy runs go through the shared lock (`capped`).

Risks and choices to confirm with the user:
1. The default for affinity on existing mates: **on**, seeded from history (proposed), or off until enabled.
2. Decay numbers (3 grace days, −4 ×1.4, cap −15, floor 10) are milder than memora's (2 days,
   −6 ×1.45, cap −30, floor 0) because this is a work secretary.
3. Whether the "rude to the mate" penalty exists at all (proposed: yes, small and capped).
4. The visible log (memora hides it; proposed: shown, collapsed, because the user asked to see and adjust).
