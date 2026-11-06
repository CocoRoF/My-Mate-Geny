# Mate Create studio (메이트 만들기) and Avatar Create (아바타 만들기)

The **Mate Create studio** is where a mate is made: the creation agent on the left helps define who she is (concept,
personality, speech, how she calls the user, voice character, visual concept) and fills her settings on the right as
it goes; then it designs her **video avatar** with Higgsfield — the way the bundled mates (한채린, 서아, 에스텔) were
made by hand with Claude Code + Higgsfield (ailism-mate `original_content/tools/mate.py`). The same studio makes a new
avatar for an existing mate. The agent has a conversation of its own, separate from the mate's chat. §11 is the
studio; §1–§10 the avatar part (unchanged since Avatar Create); §12 outfit sets for a mate's wardrobe.

Code: `backend/app/avatar/` (presets, plan, generator, pipeline, deps, store, service, prompt, mcp_bridge, studio),
`backend/app/routers/avatar.py`, `frontend/src/components/mate/studio/*` (MateStudio, StudioSettings, fields),
`frontend/src/components/mate/avatar/*` (AvatarChat, AvatarPanel), `frontend/src/api/avatar.ts`,
`frontend/src/stores/studioStore.ts`. Tests: `backend/tests/test_avatar.py`, `backend/tests/test_mate_studio.py`,
`desktop/test/e2e/mate-studio-browser.js`, `desktop/test/e2e/avatar-create-browser.js` (+ `fake-higgsfield.py`,
`higgsfield-stub.py`, `fake-claude.py`).

## 1. What it makes

Exactly the official mates' body (docs/mate.md §2 `video`, packing `stacked-alpha`):

1. **Candidates** — `nano_banana_pro`, 3:4, 2k: the agent's English description + a fixed framing (waist-up, facing
   the viewer, relaxed, hands natural, plain flat light gray background). With a reference picture the candidates are
   redrawn from it ("the same character as the reference"), or the reference itself is the base (`as_base`).
2. **Base picture** — the picked candidate through `image_background_remover` (sent as a 1600 px JPEG), the alpha
   cleaned (specks dropped), the colour taken out of the old background, placed on the canvas (1:1 1080², or 9:16
   1080×1920; the figure fills 86 % of the height / 92 % of the width, bottom-aligned) → `home.png` and
   `home-gray.jpg` on the known gray (213, 212, 217). The face is found with the anime face detector
   (`lbpcascade_animeface`, MIT, nagadomi), else OpenCV's frontal face detector, else estimated from the outline.
3. **Stills** — `nano_banana_pro` with the candidate as the reference: "Exactly the same picture … Change only her
   face: ‹face›. Nothing else changes." Only the face region is laid over the base picture (the model redraws the whole
   picture slightly; taken whole, the hair would shimmer).
4. **Clips** — `kling_o3_flf`, start = end = `home-gray.jpg`, 5 s, `pro` (studio) or `std` (light), sound off:
   "‹action›. Static camera. The plain gray background stays exactly the same. She ends in exactly the same pose as
   she starts." Every clip passes through the same frame, so any clip follows any other and each loops.
5. **Mattes** — `video_background_remover` (one at a time), then the alpha is recovered mathematically from the known
   gray: α = removed / original, colour = (original − (1 − α)·bg) / α; near the body, colours clearly not the gray are
   body (the remover cracks along dark folds); holes inside the body are filled unless they are the gray itself; specks
   dropped; the inside made solid; the edge choked a pixel in.
6. **Encode** — one crop box for every clip (the union of where the body ever is + 3 %), stacked-alpha H.264 (colour
   above, alpha below) at two heights (studio: lg 1080 / sm 540; light: 720 / 360).
7. **Check** — per clip: loop seam (first vs last frame, < 3/255), first frame vs the base picture (< 4), background
   drift (< 10), soft alpha inside the body (< 12 %).
8. **Export** — `rig.json` (`aspect`, `home`, `stills`, `clips` with kind / emotion / loop, `emotions`,
   `packing: stacked-alpha`), the stills as WebP on the clips' crop, the clips, `portrait.webp` — an ailism-style pack
   the existing importer (`files.import_folder_pack`) puts on a mate.

### Presets

| preset | clips | stills |
|---|---|---|
| minimal | 6: idle ×2, talk ×2, listen, think | 6: smile, surprised, sad, thinking, blink, mouth_open |
| standard (= 한채린's manifest without the retired pout) | 15: idle ×3, talk ×2, listen, think, react ×7 (joy, smile, shy, surprised, sad, agree, greet), doze | 11: smile, laugh, shy, surprised, sad, thinking, sleepy, blink, mouth_half, mouth_open, mouth_o |
| rich | 21: + idle, talk, listen, think, angry, sleepy (yawn) | 12: + angry |
| custom | any (≤ 32; at least one idle; react clips name an emotion tag) | any (≤ 16) |

## 2. Where

- The mate picker → **New mate**: the studio for a new mate (§11).
- Mate view header: **Avatar Create** (✨) and Mate settings → Avatar → **Create with AI**: the studio for the mate on
  screen — the same layout (the agent left, her settings right, the Avatar section open), her latest avatar project
  (Projects ▾: the others, a new one, delete).

## 3. The agent

A session of kind `avatar` (hidden from the chat list like a mate's), engine **Claude Code** by default (Codex works
too), sealed exactly like a mate's engine: our system prompt (`app/avatar/prompt.py`), `--tools ""` (no Bash / Read /
Edit / Web…), only `mcp__avatar`, no user settings, slash commands or skills, and **no Higgsfield CLI**: every
Higgsfield call is the server's. Its MCP bridge (`app/avatar/mcp_bridge.py`) → `POST /api/internal/avatar/call` with a
per-conversation token (`X-Avatar-Token`; loopback only, never the cookie).

Tools: `get_project`, `ask_user` (a card: choice / multi / slider / upload / text / mate picker — the answer comes
back as the user's message), `update_brief` (merged and checked; locked once confirmed), `use_reference` (a picture
attached in the chat), `estimate`, `look` (the reference, candidates, base picture + face region, stills, four frames
of a clip — pictures for the model, ≤ 1024 px), `regenerate`, `extend`, `pause`, `resume`, `cancel`.

The interview (the prompt's order): reference picture or not (redraw / as base / none) → without one: style,
presentation and age, hair, outfit, palette, vibe → the agent writes the English design prompt → candidates (1–4,
default 4) → shape 1:1 / 9:16 → quality studio / light → motions (preset or custom, with what each means for the
price) → which mate (existing or new + name) → estimate. Higgsfield refuses real people and existing characters
(`ip_detected`, `nsfw`): the prompt asks for original designs.

The run reaches the agent as internal `<avatar_event kind="…">` messages (a turn is started for it when it is idle,
queued while it talks): confirmed, checkpoints (it is told to `look` and point out floating hands, cut-off heads,
changed faces), failures, the cap, ready (with the check results), applied. In the conversation they show as small
dividers.

## 4. Credits — estimate and the gate

`estimate` builds every job of the plan (`app/avatar/plan.py jobs_for`) and asks Higgsfield's account API for the price
of each distinct model + settings (`POST /jobs/{job_type}/cost` — free; `HiggsfieldService.quote`). Where Higgsfield
needs input media to price a job, the CLI's `generate cost` is asked with placeholder files (uploads are free). The
card: each line (count × unit = credits), the total, the reserve (15 %, only for redos), the cap (total + reserve),
the balance now → after, the dollar value when the plan's credit value is known (`GET /account/billing/plans`, the
same rule as ailism-ai: `final_price_cents / 100 / credits`, else `dollar_to_credits_ratio`), the time.
Buttons: **Confirm · N credits**, **Change plan**, **Cancel**.

**Nothing that spends credits runs before the user's Confirm — enforced by the server:**

- `POST /api/avatar/projects/{id}/confirm {plan_id, total}` (the user's cookie; the agent has no route to it) — the
  plan on file, the same total, complete quotes, at most 30 minutes old, the processing tools installed, Higgsfield
  and its CLI available — or 409.
- Before EVERY job (`plan.check_spend`): a confirmation whose plan id and total are the plan on file, not paused or
  canceled, and room under the cap (confirmed cap + extras the user confirmed − credits counted). Every submitted try
  counts (failed ones too: Higgsfield usually refunds them, the cap stays conservative).
- Redo: ≤ 5 credits and inside the cap → runs; more (or past the cap) → an **extra** card the user confirms
  (`/extras/{xid}/confirm {total}` raises the cap by exactly that). A user's own Redo click is their OK when it fits
  the cap (the browser asks once more above 5 credits). Adding clips/stills after the confirmation (`extend`) is
  always an extra.
- The run hitting the cap stops at a `cap` checkpoint with an extra for what is left.

Higgsfield jobs are run by the server with the official CLI and an **access-only** credentials file written per call
under the project (`.hf/<random>/`, 0600, removed right after; no refresh token, so the CLI can never rotate the
login — docs/higgsfield.md). No purchase call exists anywhere.

## 5. The run

Phases: `design → pick → home → approve_home → stills → approve_stills → clips → matte → encode → check → export`.
Checkpoints wait for the user in the panel: **pick** a candidate (or **New candidates**, quoted), **approve** the
base picture with its face region (or back to the candidates / redo the cut-out), **approve** the stills (redo any
one) before the expensive clips. Parallel jobs: candidates 4, stills 3, clips 2, the video remover 1 (parallel
uploads to it have stalled). A failed job is tried again (3 tries, backing off); a refusal (`nsfw`, `ip_detected`) is
not. Failed stills / clips are left out of the avatar and reported.

- **Pause** — no new job starts; running jobs finish. **Resume**. **Cancel** — the same, for good.
- **Resume after a restart** — the project document (`avatar_projects.doc`) is written after every change; a job's id
  is saved before it is waited for, so after a restart the runner waits for that job (`generate wait <id>`) instead
  of submitting it again. A try cut off while submitting counts as spent.
- **Redo** a candidate batch, the cut-out, a still or a clip (a clip's matte goes with it); the steps after it run
  again (a redone clip is re-encoded alone unless the crop box changed).

## 6. Processing

`app/avatar/pipeline.py` (a port of mate.py, streamed frame by frame — a whole 1440 px clip would be ~1 GB) runs in
its own venv: `~/.hr-harnessor/avatar-venv/py<ver>-<hash of the interpreter>` (`AVATAR_VENV` overrides), with numpy,
scipy, `opencv-python-headless<5` (OpenCV 5 dropped the cascade detectors), pillow and `imageio-ffmpeg` (a static
ffmpeg with libx264 when the system has none — the Docker image has none). Installed from the panel (**Install**,
progress streamed) with `uv` when present (the image has it), else venv + pip, else a pip bootstrap. Each step is
memory-capped (`capped -m $AVATAR_MEM` where a systemd user scope can be made, else an address-space limit) and
serialized: one avatar's processing at a time on the machine (an fcntl lock under the avatar root). Measured on
한채린's real 1440² clips: matte ≈ 24 s and ≈ 0.4 GB per clip, encode ≈ 15 s per clip at ≈ 1 GB peak.

Project folder `<AVATAR_ROOT>/<id>/` (default `~/.hr-harnessor/avatars`): `ref/`, `design/`, `masters/`
(candidate, cut-out, home, place, face), `stills/`, `clips/` (+ `.nobg.mp4`), `matte/` (lossless alpha as FFV1 +
per-clip box and background), `web/`, `check.json`, `export/`, `thumbs/`, `backups/`, `log.jsonl`.

## 7. Finish

The panel plays the exported avatar with the real player (`MateAvatar`): try Idle / Listening / Thinking / Talking /
Away and each emotion. **Apply** puts it on a mate (any mate; the target is preselected): the current avatar is
backed up into the project first (its JSON + copies of the imported folders it uses — applying removes them), and
**Restore** puts it back. **New mate** creates a mate with this avatar. Re-applying after a redo works the same way.

## 8. API

`/api/avatar`: `GET /env`, `POST /env/install` (NDJSON), `GET|POST /projects`, `GET|DELETE /projects/{id}`,
`POST /projects/{id}/reference` (multipart), `…/answer`, `…/estimate`, `…/confirm {plan_id, total}`, `…/change`,
`…/discard`, `…/pause`, `…/resume`, `…/cancel`, `…/checkpoint {action: pick|approve|back, candidate?}`,
`…/redo {item, note?}`, `…/extras/{xid}/confirm {total}`, `…/extras/{xid}/decline`,
`…/apply {mate_id} | {new: true, new_name}`, `…/restore`, `GET …/files/<path>` (pictures and clips of the project).
Gate refusals are 409 with the reason (`X-Avatar-Gate: <code>`).

Settings: `AVATAR_ROOT`, `AVATAR_VENV`, `AVATAR_MEM` (default 3G).

## 9. Credit estimates (Higgsfield's prices)

Unit prices as seen on the official mates (ailism MATE.md §11–12, `credits` per job): `nano_banana_pro` 2k ≈ 2,
`image_background_remover` ≈ 0.5–1, `kling_o3_flf` 5 s pro 1:1 = 9 (std 6.25), `video_background_remover` = 1.
With those, the presets cost (4 candidates, studio): minimal ≈ 81, standard ≈ 181, rich ≈ 243 credits (+ 15 %
reserve); the light tier saves 2.75 per clip. The estimate card always shows Higgsfield's live quote, never these.

## 10. Tests

- `backend/tests/test_avatar.py`: presets → plan per preset (job types, params, counts, totals), price aggregation
  (reserve, cap, missing quotes), the gate (no confirmation, wrong plan / total, stale quotes, the cap, extras, pause),
  the runner end to end with a fake generator (checkpoints, the exact Higgsfield flags, the ledger, redo inside the cap
  and past it), apply → backup → restore → new mate, pause / cancel / **resume after a restart without paying
  twice**, retries vs refusals, the agent's sealed engine and bridge, the internal route's token, the real
  Generator against `fake-higgsfield.py` (access-only credentials, nothing left on disk), and with the processing venv:
  alpha recovery on a synthetic frame and the whole pipeline on a synthetic clip → a rig the player loads.
- `desktop/test/e2e/avatar-create-browser.js`: the browser flow with the real processing on the official mates'
  masters (no credits): cards, estimate, the gate, checkpoints, the avatar playing, apply / restore; en / ko,
  light / dark, desktop / phone.

## 11. The Mate Create studio

**Where.** The mate picker's **New mate** (a fresh draft and its studio at once; the picker also lists the drafts to
resume), the desktop app's mate chat window (**+** → the console at `/?view=mate&create=new`), ✨ / Create with AI for
an existing mate. A screen of its own: `/?view=mate&create=<draft id>` or `/?view=mate&avatar=<mate id>[&project=<id>]`
(frontend `lib/navUrl.ts`; `create=new` makes a draft and replaces that entry) — back returns to the Mate, forward and a
reload come back to the same draft.

**Layout.** Header: back (= Save draft & exit), the title (새 메이트 만들기 / ‹name›의 아바타), the draft's name, the
credits (≈ estimate, then spent / cap), Drafts ▾ or Projects ▾, ⋯ (Start from a mate…, Import a mate pack…, Quick
create (name only)…, Discard draft), **Save draft & exit**, **Create mate** (enabled with a name and a description or
personality; its tooltip says what is missing). Below it the steps — Concept → Personality → Look → Avatar → Voice →
Done (done ✓ / current / to do; a click shows that section) — or, for an existing mate, the avatar's own steps.
Desktop: two columns, the agent ~47 % on the left and the settings on the right, a splitter (drag, ←/→, double-click
or Home resets) remembered in localStorage `hrh_studio_split`. Phone: two tabs, **Agent | Settings**; Settings carries
the number of fields the agent filled since you last looked (or a dot when an estimate / checkpoint waits). Both stay
mounted (no lost scroll or typing).

**Left — the creation agent** (`AvatarChat`): its lines, its cards (distinct from plain messages: an accent frame and a
label) — **concept directions** (`ask_user` kind `concepts`: 2–4 big cards with a name, a one-line pitch and a palette
strip; "describe your own"), choices, sliders, uploads, text, the estimate with Confirm — **filled-in cards** for each
`update_mate_draft` (which settings, Show), tool chips, the run's events as dividers, and above the conversation the
run status (what is being made, done / total with a smooth bar, "Waiting for you: …" with Show).

**Right — the mate's settings, live** (`StudioSettings`): collapsible sections — **Concept** (pitch, her role for
you, interests, backstory, the look: art style, mood, look, outfit, palette with swatches, voice character),
**Profile** — who she is, the character only (name, who she is, personality, greeting, standing instructions),
**Conversation style** — how she talks (your name, what she calls you with the chips and the Korean particle preview,
what she calls herself, reply language, speech level — "As her character" when she has one —, speech habits, length,
emotion, warmth / humor / initiative, topics to avoid; docs/mate.md "Prompt composition"), **Avatar** (her avatar now or an empty
stage of the same size, Skip the avatar for now, then the project: estimate, checkpoints, progress, what was made so
far — fixed-ratio tiles, nothing jumps — clips, the player when ready), **Voice** (the Voice tab itself: engine, voice,
test — with the agent's voice character as a hint) and **Language model** (the Model tab). Every field saves itself
(0.65 s after the last key or on leaving it; "Changes save automatically"). A field the agent filled glows for a moment
and carries **Filled by the agent · Undo** (back to the value before it wrote); a section closed when the agent fills
it opens; editing a field removes its badge.

**The draft.** A draft is a real mate row with `draft = 1` (the cleaner option than a second settings model: every
settings tab works on it unchanged): hidden from `GET /api/mates` and the picker, never the default, no conversation
(`POST …/conversation` → 409), may have an empty name. Its studio project (`avatar_projects.doc.studio`:
`{kind: new|existing, mate_id, concept, filled, seen, avatar_skipped, voice_ok, finished_at}`) targets it. **Create
mate** (`finish`) turns it into a mate (`draft = 0`; the first real mate becomes the default) — she is in the picker
and the Mate view opens on her; an avatar still being made goes on her when ready (a new mate's avatar is applied by
itself whenever the project gets ready, again after a redo). **Discard draft** cancels a run, deletes the project
(pictures, conversation) and the draft. Opening a new draft drops untouched ones (nothing written, nothing answered,
nothing estimated).

**The agent and the settings stay in sync.** The agent writes with `update_mate_draft {fields: {name, persona
{description, personality, greeting, instructions, language}, prefs {user_name, address, self_ref, formality,
speech_style, length, emotion, tone {warmth, humor, initiative}, avoid}, concept {pitch, role, interests, backstory, voice, style,
look, outfit, palette, mood}}}` — checked strictly by the server (`app/avatar/studio.py`: unknown fields, enums,
lengths → an error it sees; nothing half-applied; the old `persona.speech` / `persona.address` are refused with
where they live now — `prefs.speech_style` / `prefs.address` — so who she is and how she talks never mix), and never the voice, the model, the avatar, the default flag or any
key. Each written field is recorded in `filled` (when, the value before) and in `seen` (what the agent knows). The
user's edits go through `PATCH /api/avatar/studio/{pid}/fields` (any mate setting + the concept) or the Voice / Model
tabs; before the agent's next turn the server compares the draft with `seen` and prepends one `<studio_update>` block
listing only what changed (`path: old → new`, clipped) — never stored, the system prompt unchanged (no restart, no
prompt bloat). `get_project` adds `studio: {kind, mate (the fields that are set), missing_to_create, avatar_skipped}`.
The system prompt for a new mate (`prompt.py` STUDIO_NEW) starts with the concept (offer 3 directions, write them, refine
speech level / address / tone), then the avatar part as in §3 (no "which mate"); for an existing mate the avatar part
with a note that her profile changes only when the user asks. The brief's target is always the studio's mate.

**Credits.** Unchanged (§4): nothing that spends runs before the user's Confirm; `update_mate_draft`, Create mate and
the concept never touch the plan or the gate.

**API** (`/api/avatar/studio`): `POST {mate_id?, language, fresh?}` → the project (a new draft without `mate_id`; a
draft's own project; an existing mate's latest — `fresh`: a new one), `GET /drafts`, `PATCH /{pid}/fields`,
`POST /{pid}/undo {field}`, `POST /{pid}/finish` → `{mate, project}`, `POST /{pid}/skip-avatar {skip}`,
`POST /{pid}/template {mate_id}` (copy that mate's profile, style, voice and model — not the name or the avatar),
`POST /{pid}/voice-ok`, `DELETE /{pid}` (discard). The project view carries `studio` (+ the mate).

**Tests.** `backend/tests/test_mate_studio.py`: the draft's lifecycle (hidden, no conversation, finish → in the list,
the first one the default), the agent's fields validated and never voice / model / avatar, the user's edits reaching
the agent once, undo, template, discard and dropping untouched drafts, the gate unchanged and the avatar landing on the
new mate, an existing mate's studio. `desktop/test/e2e/mate-studio-browser.js`: the whole flow in a browser with the
scripted fake agent (concepts → filled settings → the user's edit seen next turn → estimate → gate → Confirm → real
processing → the avatar on her → Create mate), back / forward / reload, ✨ for an existing mate, drafts, discard, the
splitter; en / ko, light / dark, desktop / phone.

## 12. Outfits

The project that fills one outfit of a mate's wardrobe (docs/mate.md "Outfits"): the same project, agent, estimate, gate,
checkpoints and processing as any avatar, with `doc.outfit = {id, name, note, stored}`. Opened from Mate settings → Avatar
& outfits, with an outfit picked: `POST /api/avatar/studio {mate_id, language, outfit: {id}}` (an outfit has one project,
opened again where it stopped; the normal avatar studio never opens it).

- **The start.** Her default set's picture is copied in as the first reference (`redraw`; the agent can't change it, and
  it is put on the known gray before the first job: `flatten`); more references are pictures of the clothes. The brief
  takes the shape of her default set and the standard motions, without clips the user switched off there: they would be
  paid for and never play.
- **The image prompt.** `presets.OUTFIT` + the clothes + the framing + `OUTFIT_CROP`, nothing else. Neither this prompt nor
  the agent's adds rules about what may be made: the agent's model and Higgsfield's own filter decide. The agent writes "Wearing …" only (`app/avatar/prompt.py` `STUDIO_OUTFIT`, `OUTFIT_INTERVIEW`).
- **The finish.** When it is ready the set goes into its outfit by itself (imported pack, her emotion choices carried over),
  not on her; **Wear** in the panel or in the settings puts it on. A redo replaces it.

Tests: `backend/tests/test_mate_outfits.py`, `desktop/test/e2e/mate-outfit-browser.js` (+ `mate-outfit-server.py`).
