# Lane C — the live show: exploration notebook

**Status:** brainstorming / pre-ADR. Owner's framing (2026-10-28): *"these are
seeds of ideas, not constraints — play with them in simulation and brainstorm
what might work as you build. Ideate and keep good documentation."*
Nothing here is decided; ideas graduate into ADRs when simulation validates them.

## The seed ideas (as planted by the owner)

1. Two hosts that are **developing characters** with persistent memory.
2. Users **create characters** — discussed as vibe-coding sessions.
3. **Interactive**: sidebar chat, ask characters questions mid-show, interrupt
   with a pause and redirect the conversation dynamically.
4. **Cache economics**: steering LLM works in small text deltas over a hot
   cached prefix; local system "steers the last mile to the speaker."
5. **Green room**: take a character aside in the chat panel, vibe-code their
   character file, then bring them into the discussion.
6. **Show-level vibe-coding**: describe the podcast you want; the system
   samples cheaply ("isn't generating a lot at once") so you iterate by ear.

## The unifying principle that fell out

> **Everything controllable is a versioned text file driving a live renderer.
> Chat is the editor. Git is the memory. The ears are the test suite.**

Characters, the show format, the article focus — all artifacts the owner edits
conversationally at any moment; effects are audible within a turn or two. One
mechanism (chat → file diff → hot-reload into the steering prompt) powers
redirection, character shaping, and format tuning alike.

## Concepts to play with

### 1. The green room (character forge)

- A 1:1 sidebar session where chat edits the **character file**. The character
  *auditions while being shaped*: their replies render in their voice, so you
  hear the persona as you tune it ("say that again, wearier").
- **Audition mode**: cycle candidate voices through the same line — a literal
  casting call (works with fixed Magpie voices today; cloned voices later).
- **Two creation modes**: *director mode* (you describe them in 3rd person; a
  casting agent asks seed questions — "what does she believe about X?" — and
  writes the sheet) and *method mode* (you perform them in 1st person; the
  system distills your performance into the persona).
- **Character file anatomy** (a directory, git-tracked):
  - `persona.md` — identity, worldview, speech patterns, tics, what they never say
  - `voice.yaml` — a **voice slot** (registry id) + style defaults; identity is
    abstracted from sound so voice upgrades never break the persona
  - `relationships.json` — dynamics with other cast members *and the producer*
  - `memory/` — episodic summaries + semantic memory (see §4)

### 2. The stage (live show mechanics)

- Steering LLM emits **turn objects** `{speaker, line, emotion, gesture}` —
  the emotion channel drives voice style now; the gesture channel is a
  future-avatar tile.
- **The interrupt dial** (not just an off switch): *cut now* (fade ≤1 word) /
  *wrap the thought* (host lands their point, then pivots) / *let them finish,
  then pivot* — plus free text for anything else.
- **@-mention routing**: "@Aria, what about…" addresses one character;
  "room: change subject to X" addresses the show. Producer shorthand.
- **Invitation turns**: if the producer is silent, hosts occasionally check in
  ("anything you want to push on?") — tunable in the show bible, from
  never-interrupt to check-in-every-segment.

### 3. The show bible (format as an editable file)

- `bible.md`: segment structure (cold open / main discussion / endpaper), tone
  words, exchange-length targets, how hosts disagree, forbidden phrases,
  running bits. Rendered into the steering prefix.
- **Show doctor session**: a green-room-style chat that vibes the bible itself
  ("punchier", "add a 60-second recap segment").
- **Rehearsal mode** (formalizing "vibe code samples"): *preview segment 2
  with this change* renders a bounded 30–60 s sample, not a whole show —
  iterate on format by ear at known cost.

### 4. Memory architecture

- **The said-aloud ledger**: orchestrator ground truth = turns whose audio
  actually played. Discarded (interrupted) material never happened —
  characters can't remember what you never heard.
- Three tiers: working transcript (last N turns verbatim) → episodic memory
  (per-show summaries) → **semantic memory** (post-show extraction of facts
  and opinions: "Aria now believes X about Y"). Semantic entries are citable:
  "last week, when we covered…" Character growth = the semantic tier.
- **The producer is a character too**: user interjections enter show history;
  relationships.json tracks how hosts relate to *you* over time.
- Post-show **condensation job** (local LLM) keeps the steering prefix bounded.

### 5. Cache economics (the owner's insight, formalized)

- Stable prefix = article + character sheets + bible + condensed memory →
  **prompt-cached server-side**; every interjection is a suffix delta; every
  response is a few sentences. Redirections keep the cache hot *because they
  change the suffix, not the prefix.*
- **Hierarchical article ingestion** for long documents: map-reduce section
  summaries + a sliding "focus window" of full text for the segment under
  discussion. Steering cost stays flat regardless of article length.
- Sim must **measure** this: tokens per turn, cache-hit rate, cost per hour of
  show — proving the economics, not asserting them.

### 6. Voice reality check (corrected 2026-10-28)

- The open Magpie 357M release **removed zero-shot cloning** — fixed speakers
  with emotion styles only. V1 casts = distinct fixed voices.
- Cloning arrives with the fish-speech/Chatterbox tier (Phase 2 benchmark) or
  the NGC gated Magpie builds. The **voice-slot indirection** (§1) is what
  makes this upgrade path painless.

### 7. Simulation-first build order (the cheap path to certainty)

**`lane-c-sim`** — a text-only orchestrator harness, built BEFORE any UI or
TTS wiring. The steering slot is pluggable: (a) scripted fixtures (free,
deterministic tests), (b) an API model, (c) human-in-the-loop. It validates
the genuinely hard parts, all LLM-agnostic: the interrupt state machine,
said-aloud vs planned memory, file hot-reload semantics, prompt assembly and
token budgets, cache economics. Deliverables: conversation transcripts,
token/cost measurements, and a state-machine test suite. Whatever survives
the sim becomes ADR-0009 and then real code.

## Open questions (parking lot)

- Repertory company (casts persist across all content) vs per-show casts —
  lean repertory, undecided.
- Where character files live: skald repo vs separate private data repo
  (characters are personal data, not code).
- Green-room LLM: same API model as the stage, or a local model (file editing
  is less demanding; privacy upside)?
- Do invitation turns feel welcoming or nagging? Sim will tell.
- Multi-listener rooms later (two producers whispering)? Pure tile for now.
