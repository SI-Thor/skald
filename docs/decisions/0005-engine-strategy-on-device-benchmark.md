# ADR 0005 — Engine strategy: pluggable multi-engine, selected by on-device benchmark

- **Status:** Accepted (2026-10-28); benchmark outcome pending
- **Update 2026-10-29:** first real row landed — two rows: **riva/magpie-357m** (HF
  path, repaired — plumbing green, audio later found unintelligible → parked:
  0.182/0.213/0.61 @120 W, 20/20 stability) and **riva/official-trtllm**
  (intelligible, deployed default: 0.150/0.165/0.55 @MAXN). Both meet the
  Lane A sub-second budget pre-tuning; only the official row counts for
  quality claims. Evidence: `benchmark/evidence/`.
  See `docs/research/2026-10-29a-magpie-speaks.md` and
  `daemon/riva-deploy/repair/`.

## Context

The owner wants *choices* they can evaluate while using: some voices for listening
quickly through dense research papers, more expressive voices for news, voices with
flair for stories. No single engine serves all three best. Verified landscape
(2026-10, see research notes): Kokoro-82M is the standout lightweight default
(Apache-2.0, 54 voices, CPU or ~2–3 GB VRAM, no cloning/emotion); fish-speech S2-Pro
(4B) is the strong cloning/expressive candidate but its published RTF (0.195) is an
H200 number — meaningless for an embedded Blackwell; Chatterbox (MIT) and Orpheus-3B
(emotion tags) round out the expressive tier; Piper is the ultralight control; Coqui
XTTS is dead and license-restricted.

## Decision

1. The daemon's engine layer is a pluggable registry; the extension's Engine dropdown
   just changes request params. No engine is hardwired.
2. Engine selection is decided by an **on-device benchmark harness** (`benchmark/`),
   not by published specs. Scorecard per engine:
   - time-to-first-audio (streaming, cold and warm)
   - real-time factor on the Thor's Blackwell GPU (and CPU fallback)
   - VRAM / unified memory footprint
   - stability across a long document (10k+ words, no degradation/desync)
   - subjective quality rating per use case: paper / news / story
3. Tiering: a *fast tier* (sub-second start, for live reading) and an *expressive tier*
   (cloning/emotion, for stories and podcast lanes) — both may be the same engine if it
   wins both, but they don't have to be.
4. Cloud engines (OpenAI-compatible endpoint + user key) remain in the dropdown as an
   optional tier, clearly labeled as sending text off-device.

## Consequences

- The benchmark harness is a first-class deliverable, not a script — it doubles as the
  acceptance test when engines are added or JetPack/CUDA updates land.
- License hygiene: engine weights carry their own terms (fish-speech = Fish Audio
  research/community licenses: fine for this personal install, no redistribution of
  model-derived audio commercially). The daemon records each engine's license in the
  registry metadata so installers can filter by client requirements.
- For other installs: the benchmark harness is hardware-agnostic — rerun it on any
  target board and the registry tiers re-rank themselves for that hardware.
