# ADR 0001 — Build the extension from scratch rather than forking Read Aloud

- **Status:** Accepted (2026-10-28)
- **Context:** Spec discussions, October 2026.

## Context

The motivating dissatisfaction is with the "Read Aloud: A Text to Speech Voice Reader"
extension (LSD Software, MIT, <https://github.com/lsdsoft>). The complaint is *not* about
its TTS quality or text extraction — it's about the control surface: you cannot view or
change voice type and speed while listening; you must stop playback to reach settings.

Read Aloud is open source, so forking was a real option.

## Decision

Build a lean, fresh extension (target: low thousands of lines) instead of forking.

## Why

- The delta we want is concentrated in UI/UX and control flow — exactly the parts that
  would require extensive rework in any fork.
- Read Aloud's codebase is large, MV2-era, and intertwined with its hosted backend
  services (cloud voice proxies). Carrying that for a single-user system costs more than
  rewriting the small surface we need.
- Text extraction and sentence highlighting are well-trodden problems
  (Readability-style heuristics) — cheap to reimplement, no need to inherit a codebase
  for them.

## Consequences

- We own all the code and can reshape freely (draggable bar, live controls, two-lane daemon contract).
- Read Aloud remains a reference for behavior (skip-by-sentence semantics, multipage
  following) — import ideas, not code.
- For installers adapting this for other clients: if a client *does* want the full
  cloud-voice zoo and per-site heuristics Read Aloud already has, reevaluate this ADR —
  that's the fork-shaped use case.
