# Lane C: the produced live show

> The killer-app feature: an interactive two-host podcast about whatever
> you're reading, where you are the producer — and the hosts only remember
> what you actually heard.

## The idea

Text-to-speech reads documents. Podcast generators batch-render MP3s. Lane C
is neither: it's a **live, generative conversation** between characters about
the article in front of you, which you can question, redirect, or cut at any
moment — like a radio producer whispering into the hosts' ears.

- You read a page; two characters discuss it out loud, generated turn by turn.
- You type (later: say) a question → a host answers *in their voice* within
  conversational pause (~1.5 s budget).
- You hit cut → audio stops within a word; the hosts pivot to your point.
- You take a host "aside" in a green room → shape their personality → bring
  them back to the stage.

## What's novel

**1. The said-aloud ledger.** Character memory records only turns whose audio
actually played. Interrupted material never happened — the hosts can't
"remember" a sentence you cut off. This is the semantic difference between a
chat history and a *broadcast*: implementation in
`experiments/lane-c-sim/show.py` (`Ledger`; tests prove unheard turns never
reach memory).

**2. The interrupt dial.** Not an on/off switch but a director's toolkit:
*cut now* (buffer dies instantly), *wrap the thought* (host lands the point,
then pivots), *let them finish*. Each mode has precise, tested buffer
semantics (`Show.interject`, `Show.tick`).

**3. The producer is a character.** Your interjections enter the show's
history; `relationships.json` tracks how each host relates to *you* across
sessions. Over weeks, the hosts develop — the design doc's "developing
characters" made concrete via three memory tiers (working transcript →
episodic per-show summaries → semantic facts extracted post-show).

**4. Everything is a versioned file** (see [character-files.md]).
Characters, the show bible (format/tone/segment structure), even the article
focus — all text files the producer edits conversationally at any moment,
hot-reloaded into the steering prompt next turn. Chat is the editor; git is
the memory; your ears are the test suite.

## How it works (validated parts)

`experiments/lane-c-sim/` implements the hard semantics text-only, 5/5 tests:

```
producer interjection ──▶ interrupt dial ──▶ prefetch buffer policy
       │                                            │
       ▼                                            ▼
 steering prompt  ◀── said-aloud ledger ◀──── playhead advance
 (cached prefix + suffix deltas)                 │
       │                                         ▼
       └──▶ steering LLM (small text deltas) ── next turn ──▶ TTS voice
```

- **Prefetch buffer**: 15–30 s of TTS renders ahead; interruptions discard it
  (local GPU seconds — cheap), so the show feels continuous yet is fully
  interruptible.
- **Latency budget**: question → host's voice under ~1.5 s (steering LLM
  first sentence ~0.4–1 s cache-hot + local TTS ~0.3–0.6 s). The measured
  engine (TTFA 0.15–0.19 s) leaves margin.

## Status

- ✅ Semantics proven in simulation (this repo, 5/5 tests + headless runs)
- ✅ Voice + emotion palette live on the Thor (Mia/Jason/Aria × 5 styles)
- 🔜 Steering LLM slot wired to local Ollama; REPL producer session
- 🔜 Firefox sidebar (transcript, question box, character cards) — the
  design lives in `docs/design/lane-c-explorations.md`
- 🔜 ADR-0009 once the sim informs the final state machine
