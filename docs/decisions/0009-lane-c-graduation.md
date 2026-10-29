# ADR 0009 — Lane C: graduate the simulated semantics; UI and steering next

- **Status:** Accepted (2026-10-29)
- **Trigger:** ADR-0003 and `docs/ROADMAP.md` declared the live-show design
  "graduates to an ADR when the `lane-c-sim` harness validates the core state
  machine." The harness now exists and passes — this is that ADR.

## Decision

Lane C (the produced live show — `docs/design/lane-c-explorations.md`,
[features doc](../features/live-show.md)) proceeds to implementation in three
graduated layers, each building only on the previous:

1. **Semantics — DONE, tested.** The said-aloud ledger (unheard turns never
   enter character memory), the interrupt dial (`cut_now` discards
   immediately; `wrap_thought` completes then redirects; `let_finish` queues),
   and the prefetch buffer are implemented and pinned by tests in
   `experiments/lane-c-sim/` (5/5). These are the invariants any
   implementation must preserve.
2. **Steering — next.** `SteeringLLM` slot gains an `OpenAICompatLLM`
   implementation (Ollama at `localhost:11434/v1` on the reference Thor;
   any OpenAI-shaped endpoint via env). The prompt assembly (stable prefix =
   article + character sheets + show bible + condensed memory; suffix =
   said-aloud turns + interjection) is fixed by the sim's
   `PromptAssembler`; token economics are logged per turn (ADR-0005-style
   honesty for the cache-economics claim).
3. **Surfaces — last.** The daemon grows a show endpoint (WebSocket or SSE:
   turn stream + interrupt control), and the extension grows the sidebar
   (transcript, question box, interrupt dial, character cards). No UI before
   1 and 2 are stable.

## Non-negotiable invariants (from the sim, pinned by tests)

- Character memory excludes unheard turns (`Ledger.memory()`).
- `cut_now` discards the prefetch buffer immediately at `interject()`.
- `wrap_thought` lets exactly the current turn complete, then lands the
  interjection.
- Prompt prefix is byte-stable across turns unless a file (character/bible/
  memory) actually changed — cache-economics depends on it.

## Voice reality

Character voices resolve through **voice slots** (ADR-0005 registry; see
`docs/features/voice-slot-indirection.md`): today `riva:mia`-style fixed
speakers with emotion styles; cloning stays with the Phase-2 tier
(zeroshot NIM / fish-speech) — personas must not change when the slot's
resolution does.

## Consequences

- `experiments/lane-c-sim/` graduates from experiment to **the reference
  implementation of Lane C semantics**; the daemon/UI implement against it.
- The REPL producer interface (`repl.py`) arrives with layer 2.
- A future ADR covers the sidebar UX contract (message shapes, interrupt
  control protocol) once layer 2 is live.
