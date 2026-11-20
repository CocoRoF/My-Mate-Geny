# A mate's memory network

Each mate has a memory network of her own. It holds the people, places, games, works and topics she knows, the facts
about each and how they connect. It grows in two ways:

- **from talking**: what the user's memories name is linked in;
- **from studying**: the user hands her a page ("이거 읽어 둬") or a topic ("제주도 등산 코스 공부해 놔"). She searches,
  reads and files what she learns with its source. She can also study, now and then, what the user cares about.

What she used lately stays vivid. What she hasn't thought of in a long time fades from conversation, and comes back when
it is asked about.

The network lies **on top of** the source-backed memories ([implementation record](mate-memory-implementation.md)):

- The user's memories, their evidence and the episodes stay as they are. Nodes only point at them.
- Everything is in the app's SQLite database. There are no new services, packages or models; the layout library
  (d3-force) runs in the browser.
- Studies run on the mate's own engine (Claude or Codex) as a sealed background turn.

Code: `backend/app/mate/graph.py` (the network), `study.py` (studies), `webread.py` (reading pages), `linker.py`
(linking memories in). UI: `frontend/src/components/mate/memory/`.

## What it is built on

| Idea | Where it comes from | How it is used here |
|---|---|---|
| Strength that fades as a power law and grows on each use | FSRS, the spaced-repetition scheduler ([the algorithm](https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm)) | each node and fact has a stability; [Strength](#strength) |
| Recency, importance and relevance together decide what comes to mind | Generative Agents, Park et al. 2023 ([arXiv:2304.03442](https://arxiv.org/abs/2304.03442)) | relevance leads, strength orders the relevant; [What a message brings to mind](#what-a-message-brings-to-mind) |
| Spreading activation with a fan effect (a thing linked to many spreads less to each) | ACT-R (Anderson; Anderson & Reder 1999) | 2 hops, the hubs excluded |
| Associative recall over an entity graph | HippoRAG, Gutiérrez et al. 2024 ([arXiv:2405.14831](https://arxiv.org/abs/2405.14831)) | named things seed; neighbours light up |
| Facts with two time axes (true when / recorded when); a newer fact supersedes, the old one is kept | Zep / Graphiti ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956)) | `valid_from/until` and `recorded_at/invalidated_at`, `superseded_by` |
| Grounded extraction: keep only what the source says | the app's own memory rule (exact quotes) | a fact needs an exact quote of a page chunk or of the chat |
| An agent that reads, takes notes and reflects before stopping | MemGPT ([arXiv:2310.08560](https://arxiv.org/abs/2310.08560)), Mem0 ([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)) | the study turn's tools and its stop rule |

The choices that differ from those systems, and why:

- **No embeddings.** The app has no embedding model or API, and a mate must work offline from any vector service.
  - Names and aliases resolve entities, across languages: "뉴욕" = "New York" = "NYC".
  - FTS5 over hashed word terms finds facts and passages.
  - The model expands names when it files a fact: it gives aliases in both languages.
- **No model call per turn.** What comes to mind is computed in SQLite and Python, in milliseconds. Only studies and the
  linker call a model, in the background.
- **Nothing ungrounded.** A study can't file a fact without an exact quote of a chunk it read. The linker can't link a
  memory to a name that isn't in the memory's own words.

## Data

| Table | What |
|---|---|
| `mem_nodes` | a thing she knows: kind (user, self, person, place, org, work, game, thing, concept, topic, event), name, aliases, summary, origin (chat / study / url), importance 1–5, stability, last access, use count, pinned, status (active / merged) |
| `mem_node_keys` | the normalized names and aliases a node answers to (NFKC, lower case, no spaces or punctuation) |
| `mem_facts` | a statement about a subject (and maybe an object node), with a predicate. Each has its quote and source: a page chunk, or the chat. It keeps `valid_from/until` (as the source says), `recorded_at` / `invalidated_at`, `superseded_by`, confidence, importance, stability and origin |
| `mem_mentions` | a personal memory (`mem:`), an episode (`ep:`) or a study (`study:`) → the nodes it is about, with a role and label |
| `mem_linked` | which memories / episodes the linker has looked at |
| `know_docs`, `know_chunks` | the pages she read: url, title, site, published date, the text cut into ~1,200-character chunks on paragraph breaks |
| `mem_facts_fts`, `know_chunks_fts` | FTS5 over hashed terms (`knowledge.terms`: words, Hangul stems, bigrams) |
| `know_studies`, `know_study_events` | each study and what it did (searched, opened, read, couldn't read, filed, noted, summary, state) |

The two special nodes:

- **user** is the user, named from `prefs.user_name`.
- **self** is the mate.

They are hubs: everything personal touches them, so activation never spreads through them.

Forgetting:

- **Forget a node:** its facts go, and the personal memories lose the link but stay.
- **Forget a fact or a page:** the facts from that page go too.
- **Delete a memory:** its links go.
- **Wipe her memory:** the whole network goes, and her studies with it.

## Strength

Retrievability of a node or fact, *t* days after its last use (pinned → always 1):

R(t) = (1 + t / (9·S))⁻¹

The first stability *S* comes from importance:

| Importance | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| *S* (days) | 2 | 5 | 12 | 40 | 180 |

Each time it is actually given to her in a turn, it is reinforced:

S′ = S · (1 + 2.5 · (1 − R)) + 0.5, capped at 3650 days.

Using something that had nearly faded grows it the most (the spacing effect). Using it again right away barely
changes it.

## What a message brings to mind

There is no model call. For each mate turn, `Graph.recall` works in four steps.

1. **Seeds.** These are the nodes the message names, by name or alias.
   - A longer name counts anywhere in the text.
   - A short one counts only as a word of its own: Latin letters up to 3 ("poe") as a whole word; Hangul up to 2
     syllables ("롤", "원신") as a word, or that word with a particle ("원신이"). So "롤러코스터" names nothing.
   - The user's last few messages seed too, weaker: 0.5 · 0.7ⁱ.
2. **Spreading.** Activation spreads 1.0 → 0.5 → 0.2 over two hops, along facts and shared mentions.
   - It is divided by √(fan), the number of links a node has.
   - It never passes through the user or self hubs.
3. **Words.** Facts that share words with the message are found through FTS. They must share at least two words, or
   one word and two bigrams, so small talk pulls nothing in.
4. **Score and budget.**
   - Relevance (named, spread, words) leads; strength orders the relevant.
   - A directly named thing is never dropped for fading.
   - Something reached only indirectly and faded (R < 0.2) stays out, unless a strong word match brings it.
   - At most 3 facts per subject.
   - The budget follows the memory level: light 3 nodes / 500 characters, normal 6 / 1,100, rich 10 / 2,000.

The result goes into the turn as a `<knowledge>` block:

- Each line is a node's name and kind, its summary, and its strongest facts.
- A fact carries when it was true, if its source says so. A fact from a page also carries the day she learned it.

When the turn is delivered, the nodes and facts given are reinforced. The names it found also widen the personal memory
search (`graph.expand`), so "뉴욕 얘기 했었나?" finds a memory written as "New York".

The prompt (`prompt.py`, "## Your memory network") tells her how to use it:

- Use it naturally, never recite it.
- Things that change (patches, prices, seasons) may have changed since — say so when it matters.
- Don't claim knowledge she doesn't have; offer to study instead.

## Her memories in the network

Every personal memory is linked to what it names:

- **At once, without a model:** a new memory gets the user node and its subject.
- **In the background:** the linker (`linker.py`) sends memories and episodes that aren't linked yet, 30 at a time,
  at most every 2 minutes. It runs only while nothing else is being extracted and no turn is running. The call is a
  sealed one on the mate's engine.
- **Grounding check:** each name the linker returns must appear in the item's own words, or it is dropped.
- **Existing memories:** after this feature arrives, they are linked the same way, over time.

## One record per thing

Each memory is filed under **the one thing it is about** (`mate_memories.entity_id` → a node), with a short **item** label
(`predicate`: 호칭, 직장, 즐기는 게임 …) and **one plain sentence** ("하렴은 Path of Exile을 자주 한다."). The words it rests on
stay with it as evidence (exact quotes, relation `supports`), one click away — the text itself is no longer the joined
quotes. Three special nodes: the **user**, **her** (`self`) and **the two of them** (`us`, "우리 사이": what they call each
other, what they are to each other).

- **What is a thing** (`graph.link_entities`): her own name (and a three-syllable Korean name's given name: 한채린 → 채린)
  is her node, the user's name is theirs; a pronoun or a general word ("걔", "다른 여자", "게임", "질투", `graph.GENERIC`)
  is never a node — the memory goes under the user.
- **Extraction** (`consolidation.py`, prompt v3): the extractor gets the things the window is about, each with what she
  keeps about it (`entities`, ≤ 16 × 24), and answers `add` or `update` per memory — an item that is already covered is
  updated (merged or corrected text), never written twice. Relations between two things (`relations` → `mem_facts`),
  habits (filed under the user) and episodes (a short description, not a quote) come with it. What isn't worth months —
  requests to her, talk about building or testing the app, small talk, a passing mood — is left out. Each item is
  checked on its own: a bad one is dropped, the rest of the batch stands.
- **Merge guard** (`store.add_memory`): a new memory with the same thing, kind and item as an active one (not pinned,
  not the user's own words) updates that one instead (a new revision).
- **Putting in order** (`memory_org.py`): what she kept before this arrived is put in order once per mate (checkpoint
  `memory_org_v1:<mate>`), and again when the user asks (기억 → 지금 정리하기, `POST …/knowledge/organize`). Two sealed
  calls on her engine, in the worker's quiet moments (at most every 3 minutes, never while she is talking): **things**
  (the same thing under two names merged, a no-one-in-particular node dropped, a node that is her or the user folded
  into theirs) and **memories** (filed, labelled, rewritten as one sentence from its quotes, same item merged, not worth
  keeping archived). Every change is a revision; what the user wrote themselves and her diary of moments keep their words.
- **The 기억 tab** shows one card per thing (the user, the two of them, her, then the rest by the latest change; "아직
  정리 전" last), each item one line. "늘 기억" marks only what is pinned. In her prompt a memory reads
  `«thing · item» text`, sorted the same way.

## Studies

A study is a background agent turn on the mate's own engine, with only the study tools:

| Tool | What |
|---|---|
| `read_page(url, offset?)` | the server fetches the page (see [Reading pages safely](#reading-pages-safely)) and shows up to 9,000 characters of it, in chunks marked `[d_….c#]`. Each new page counts against the budget |
| `search_web(query)` | Wikipedia and DuckDuckGo results, when the engine's own search is off |
| `search_memory(query)` | what she already knows: no need to file it twice |
| `add_knowledge(entities, facts)` | nodes (name, kind, aliases in both languages, summary) and facts. Each fact has a subject, maybe an object, a short predicate, a statement in her language, the exact quote, the chunk and `valid_from`. A fact whose quote isn't in its chunk is refused, and she is told why |
| `note(text)` | a line of progress the user sees live |
| `finish_study(summary, open_questions)` | her notes and what is still open |

Setup:

- **Engine search.** Claude gets `--tools WebSearch`. A sealed Codex gets `web_search = "live"` (the new
  `TurnRequest.web_search`); everything else stays off — no shell, no files, a read-only sandbox.
- **Bridge.** The MCP bridge runs with `HRH_MATE_STUDY=1` and offers only the study tools.
- **Prompt.** The study prompt (`study.PROMPT`) asks her to:
  - read at least a few pages from different sites;
  - file facts with their date;
  - link facts to other things through `object`;
  - give a fact about a part of the topic (a class, a league) that part as its subject;
  - stop when she has enough.
- **Untrusted pages.** Page text is untrusted: what it says is never an instruction.

| Depth | Pages | Facts | Minutes |
|---|---|---|---|
| quick | 4 | 30 | 10 |
| normal | 10 | 70 | 20 |
| deep | 20 | 140 | 40 |

A URL study reads the page and at most 3 pages it links to.

How a study runs:

- **One at a time.** One study runs at a time across the app; the rest wait in a queue.
- **Out of time.** What was filed stays, and the study ends as done.
- **Blocked pages.** A page that can't be read is noted ("couldn't read … (HTTP 403)"), and she is told to try another
  source. After 2·pages + 2 failures she is told to file what she has and stop.
- **Restarts.** A restart marks a running study interrupted.
- **Nothing learned.** If a study learns nothing, the topic node it made is removed again, unless something else
  refers to it.

When a study ends:

- **Asked for by the user or by her:** the result reaches her as a `<study_result>` internal turn, queued while she is
  answering or on a call. She tells the user what she learned in her own words. If it failed, she says so.
- **Started by her own curiosity:** it is offered once, as a `<recently_studied>` hint, to bring up when it fits.

In chat she can start one herself:

- `learn_url` and `study_topic` start a study. She says so in a sentence and ends her turn.
- `list_studies` lists her studies.
- `explore_memory` and `open_memory_node` let her look deeper, with sources.

### Curiosity

`prefs.memory.curiosity`: **off**, **sometimes** (the default, at most 1 a day) or **often** (at most 3 a day). A study
of her own starts only when:

- the mate's conversation has had no user message for 20 minutes and she isn't answering;
- the topic is something the user's memories point at (by links and strength) that she knows little about;
- the topic is **public**: a published game or work, or something she has already read about on the web (a fact from
  a page). Her searches go to public search engines, so the user's personal things are never her topic: the people
  around them, their workplace, their own projects (the linker files those as "thing", never "game" or "work");
- she hasn't studied that topic in the last 14 days.

The study prompt says the same for every study: no personal details in a search query. If a subject turns out to be
private, or the web has nothing public on it, she stops without filing anything. A study of her own that found nothing
is never brought up in conversation.

It is always quick. Like any study it runs on the mate's engine, that is, on the user's Claude / Codex account.

## Reading pages safely

`webread.fetch` (stdlib only):

- **Addresses.** Only http(s). Every address the host resolves to must be public: no loopback, private, link-local,
  CGNAT, multicast or reserved addresses. After connecting, the actual peer address is checked again (DNS
  rebinding). Each redirect (at most 5) is checked the same way.
- **Limits.** 8 MB, 25 s, 1 s between two requests to one host. Only text types (HTML, plain text, JSON, XML).
- **robots.txt** is honoured for her own (curiosity) studies. A page the user hands her is read like a browser would.
- **Extraction.** Drops scripts, styles, navigation, forms and the like, and prefers `<article>` / `<main>`.
  - Headings become `#` and lists `-`, tables `|`.
  - The title, site and published date come from meta tags (og:title, og:site_name, article:published_time).

## The heart panel

Two tabs next to Relationship and Memory.

**Network** — the map:

- **Drawing.** d3-force on a canvas. Colour is what a thing is, size how much she knows about it, and opacity
  (with "흐려짐 표시" / Show fading on) how readily it comes to mind now; what she used lately glows. Fact links are
  solid and labelled; memories of the user are dashed.
- **Names never overlap.** The selected, hovered and searched things and their neighbours are always named; the rest
  are named, bigger and more vivid first, where there is room (below the dot, else above, right or left). Zooming in
  names more.
- **Moving around.** Wheel / pinch or the + / − buttons zoom, dragging pans or moves a node, a click selects, hovering
  shows what a thing is (kind, how vivid, facts, memories, description). Positions are kept per mate. The map fits
  itself in view until the user moves it; the crosshair fits it again.
- **Filters and search.** Everything / about you / what she studied. The search box finds part of a name in either
  language, facts and page passages. The legend lists only the kinds on the map, with counts; clicking one highlights
  that kind.
- **Room to see.** Where the panel is wide (the chat window's panel, full screen) the details sit beside the map;
  otherwise under it. The map's height follows the window.
- **Node details.** Its facts with the page and its exact quote, when it was true, and the facts it replaced. Also the
  memories about it, its neighbours, the pages and studies.
- **Editing.** Edit names, aliases, kind and importance; keep fresh (pin); merge with the same thing; forget the node or
  a fact.

**Study** — the study list:

- Ask for a topic (with a focus and a depth) or a page.
- Set her curiosity.
- Each study shows what it searched, opened, read, couldn't read and filed, live, then her notes and open questions.

Both work on phones, in Korean and English, and in light and dark themes.

## API

```
GET    /api/mates/{id}/graph?focus=&depth=&limit=&origin=all|personal|knowledge   the map (nodes with strength now, links, stats)
GET    /api/mates/{id}/graph/search?q=                                             nodes, facts, page passages
GET    /api/mates/{id}/graph/nodes/{nid}                                           a node: facts + sources, memories, neighbours, pages, studies
PATCH  /api/mates/{id}/graph/nodes/{nid}   {name?, aliases?, summary?, kind?, importance?, pinned?}
POST   /api/mates/{id}/graph/nodes/{nid}/merge   {into}
DELETE /api/mates/{id}/graph/nodes/{nid}
DELETE /api/mates/{id}/graph/facts/{fid}
GET    /api/mates/{id}/graph/docs · GET /api/mates/{id}/graph/docs/{did}?chunk= · DELETE /api/mates/{id}/graph/docs/{did}
GET    /api/mates/{id}/studies · POST /api/mates/{id}/studies {kind: topic|url, topic?, url?, goal?, depth?}
GET    /api/mates/{id}/studies/{sid} · POST /api/mates/{id}/studies/{sid}/cancel · DELETE /api/mates/{id}/studies/{sid}
```

`GET /api/mates/{id}/knowledge/status` also says where putting her memory in order stands (`organize`: never | asked |
running | done with what changed | failed); `POST /api/mates/{id}/knowledge/organize` asks for it again.

Everything is scoped to the mate: another mate's node, page or study is 404. Changes reach other windows as a `graph` /
`study` change event.

## Checked

**Tests** (`backend/tests/test_mate_graph.py`: 24 tests, synthetic data, no network, no model):

- names and aliases across languages; merge;
- quotes, and a newer fact superseding an older one;
- fading and reinforcement;
- recall: spreading, faded items, short names, widening the memory search;
- the map and the search box; the linker's grounding check;
- the SSRF guard; HTML extraction; chunking;
- a full study with a scripted engine; the page budget; unreadable pages; a study that learns nothing;
- curiosity's topic choice; the sealed study turn (tools, web search, bridge);
- the API: scoping, editing, merging, forgetting, pages, studies.

Also `test_mate_codex.py` (the sealed Codex config with web search on) and `test_mate_bridge.py` (the study bridge
offers only the study tools).

**Browser** (`desktop/test/e2e/memory-network-browser.js`, a seeded network on a throwaway server):

- the map, and a search by the other-language name;
- facts with their page and quote; a neighbour; pinning;
- the filters, fading and full screen;
- the Study tab with a finished and a running study, a new topic and page, and curiosity;
- screenshots in ko / en, dark / light, desktop / phone.

**Real engine** (Claude, a throwaway server; 2026-11-15):

- A quick study of "Path of Exile 2" took 35 s: 2 pages read, 10 facts, $0.11, a Korean summary with open questions.
- A second run, with a conversation, filed 5 facts for $0.089. Several sites answered 403 to this server; she noted
  it and said so in her summary.
- The mate got the `<study_result>`, told the user about it naturally and mentioned the source limits.
- Asked later "엑자일2 정식 출시 언제였지? 새로 나오는 검 쓰는 클래스 이름도 기억나?", she answered from the network:
  December 11, 2026 and the Duelist.

**Not checked:**

- Codex's live web search in a real study.
- normal / deep studies on a real engine.
- Curiosity over days in production.
- Networks of thousands of nodes on the map.
- Windows / macOS desktop builds.
