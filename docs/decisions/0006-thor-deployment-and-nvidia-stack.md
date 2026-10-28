# ADR 0006 — Deployment on Jetson Thor; adopt NVIDIA patterns, not NVIDIA stacks (yet)

- **Status:** Accepted (2026-10-28)

## Context

Verified October 2026 (links in `docs/research/2026-10-28-nvidia-stack-and-tts-landscape.md`):

- **NVIDIA Broadcast**: Windows-only, RTX desktop, and microphone-input-side (noise
  removal, room echo). Not a TTS building block, not on Linux.
- **NIM containers**: x86_64-native; ARM64/Jetson (JetPack 7) container support still
  maturing per NVIDIA forums. Self-hosted NIM mode requires an NVIDIA AI Enterprise
  license. Speech NIMs (Riva / Nemotron Speech) available hosted-only for us.
- **NVIDIA pdf-to-podcast blueprint**: its own TTS step is ElevenLabs cloud; the LLM
  side runs on build.nvidia.com or enterprise self-hosting.
- **The Jetson-native path** that does work today: `dusty-nv/jetson-containers` ecosystem
  (Jetson AI Lab), with JetPack 7 image coverage still filling in.

## Decision

- Deploy via **docker compose services on jetson-containers** — one service per lane
  plus the shared registry; no monolithic composite container (lanes restart
  independently; GPU/memory allocation is per-service).
- **Adopt the patterns** from NVIDIA's blueprint: guide prompt for focus control,
  `--monologue` vs dialogue flag, chunked/ensemble LLM scripting for long documents,
  Docling for PDF extraction.
- **Do not depend on NIM** today. Because ADR-0002 chose an OpenAI-compatible surface,
  a compliant NIM container drops in later (Jetson ARM64 images or an x86 GPU box on
  the LAN) without touching any client.
- Memory budgeting on the 128 GB unified pool is *measured at runtime* (per-engine
  footprints from the benchmark), not statically partitioned from estimates.

## Consequences

- Zero licensing/blocking dependencies on NVIDIA software beyond CUDA/JetPack itself.
- The system is portable to any CUDA host; the Thor is the flagship target because it
  is always-on, local, and private.
- Revisit trigger: NIM publishes ARM64 speech containers, or an x86 GPU joins the LAN —
  then re-benchmark NIM against the open engines on the same scorecard.
