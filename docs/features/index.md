# Skald's novel features — supplemental documentation

This directory explains what skald does that its reference points (Read Aloud,
NVIDIA's pdf-to-podcast, generic TTS servers) do not. One document per
feature; each states the idea, why it's novel, how it works, and where it
lives in the code.

| Document | Feature | One line |
|---|---|---|
| [live-show.md](live-show.md) | **Lane C: the produced live show** | An interactive two-host podcast you direct mid-sentence — with a memory that only knows what you actually heard. |
| [cache-economics.md](cache-economics.md) | **Hot-prefix steering** | A big LLM steers the show with tiny paid deltas over a cached prefix; the local GPU renders everything you hear. |
| [character-files.md](character-files.md) | **Characters as versioned files** | Personas are git-tracked text (persona + voice slot + relationships + memory), edited conversationally, hot-reloaded into the show. |
| [asr-gate.md](asr-gate.md) | **ASR round-trip acceptance gate** | No TTS engine counts as "working" until a speech recognizer can transcribe what it says — machine ears before human ears. |
| [thor-first-benchmarks.md](thor-first-benchmarks.md) | **Power-context benchmarking** | No latency number exists without its power mode, clocks, and thermals — Jetson numbers are meaningless otherwise. |
| [voice-slot-indirection.md](voice-slot-indirection.md) | **Voice slots** | Characters bind to a voice *slot*, not a voice file — personas survive engine swaps, upgrades, and (later) cloning. |

## The methodology features

Two practices are as much product as the code (ADR-0007):

- **Tiles** — every path taken *and not taken* is documented with its reasons
  (ADRs never deleted, ideas never discarded, dated research notes). A future
  install may be optimized for exactly the option this one declined.
- **Live-system GAN loops** — when bringing up opaque vendor stacks, iterate
  against the running system's own error messages: instrument before guessing,
  treat the checkpoint/artifact as ground truth, and keep the fix where you
  own it (our model repo, not the vendor image). The 15-layer Riva repair
  (`daemon/riva-deploy/repair/`) is the worked example.
