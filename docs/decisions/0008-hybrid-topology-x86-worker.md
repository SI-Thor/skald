# ADR 0008 — Hybrid topology: optional x86 GPU workers behind the Thor daemon

- **Status:** Accepted (2026-10-28)
- **Refines:** ADR-0006 (whose "NIM is x86-only" premise is outdated — see
  `docs/research/2026-10-28b-nim-prereqs-riva-toolkit-survey.md`; its *decision*
  — no NIM dependency, OpenAI-compatible surface — still stands)

## Context

New asset: an ASUS ProArt laptop (Ryzen 9 AI, RTX 4050 6 GB) joins the Thor. The owner
wants it usable for NIM-based work "if we were actually producing releasable content."
Meanwhile the NIM prerequisites page now lists ARM64 CPUs, so NIM-on-Thor is an open
experiment rather than a closed door, and Riva/Nemotron Speech exists for Jetson only
as early-access L4T builds.

## Decision

1. **The Thor daemon remains the single API surface and control plane.** It gains
   support for *upstream engines*: LAN OpenAI-compatible endpoints (the laptop, or any
   future NIM/Riva host) registered as engines in the voice registry, proxied through
   `/v1/audio/speech`. Clients never learn where synthesis physically ran.
2. **Workers are optional and stateless to the live lane.** The laptop can be asleep or
   absent with zero impact on live reading; it is used for speech-NIM/Riva evaluation,
   podcast-lane batch rendering, and releasable-content production.
3. **NIM/Riva evaluation proceeds on two parallel paths, adoption still gated by the
   benchmark scorecard (ADR-0005):**
   - Path A (near-term): speech NIMs/Riva on the laptop — x86 packaging, models sized
     for 6 GB. LLM NIMs are out there (8B wants ≥ 24 GB).
   - Path B (one experiment): an ARM64 NIM on the Thor itself, gated on driver/CUDA
     stack compatibility with JetPack 7 — the Thor's 128 GB unified memory makes it
     the better NIM host if containers run.
4. Licensing discipline: Riva/NIM in *evaluation* is covered by the free developer
   program; any **client-facing install** that ships Riva/NIM needs NVIDIA AI
   Enterprise licensing — open engines remain the license-clean baseline for SI-Thor
   deployments.

## Consequences

- The extension and all clients stay unchanged regardless of where engines run —
  the federation is entirely daemon-side.
- LAN trust model becomes real: worker registration needs a shared-secret or
  wireguard-style boundary before any client-site deployment (tile for installers).
- If NIM/Riva wins a benchmark slot, it wins as *an engine address*, not as
  architecture — ADR-0002's abstraction pays off exactly as designed.
