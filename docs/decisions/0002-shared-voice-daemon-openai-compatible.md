# ADR 0002 — All speech comes from a shared local voice daemon with an OpenAI-compatible API

- **Status:** Accepted (2026-10-28)
- **Context:** Owner asked for "a good adaptive voice system we might use with other
  applications" on the Jetson Thor, referencing NVIDIA Broadcast-style system utilities.

## Context

The first-class user reads in Firefox, but the Thor is a 128 GB unified-memory machine
that is on all the time — an obvious host for a *shared* voice service. Meanwhile the
industry is converging on OpenAI-style `/v1/audio/speech` HTTP interfaces (NIM
microservices, OpenAI, most self-hosted servers use this convention).

Verified constraints (see `docs/research/2026-10-28-nvidia-stack-and-tts-landscape.md`):
NVIDIA Broadcast is Windows-only and microphone-side (irrelevant); NIM containers are
x86_64 with ARM64/Jetson still maturing; NVIDIA's own pdf-to-podcast blueprint outsources
TTS to ElevenLabs cloud.

## Decision

Skald's speech is served by a daemon running on the Thor, exposing:

- `POST /v1/audio/speech` — OpenAI-compatible, streaming-capable
- `GET /v1/voices` — engine + voice registry with metadata (tier, latency class, languages)

Bound to localhost by default, optionally LAN. The Firefox extension is one client among
possible many (scripts, other desktop apps, phones on the LAN).

## Alternatives rejected

- **Browser-only TTS** (`speechSynthesis` + everything in the extension): simplest, but
  unshareable, and Linux system voices are poor — defeats the point of the Thor.
- **Adopting NIM containers now:** not available for ARM64 Jetson; self-hosting requires
  x86 + NVIDIA AI Enterprise license.
- **Cloud-only voices:** best raw quality, but sends everything read (often private or
  client documents) to third parties. Cloud remains an *optional* engine, not the substrate.

## Consequences

- One install of an engine serves every client; voices/clones are managed in one place.
- The OpenAI-compatible surface means a future NIM (or any compliant server) drops in
  behind the same API with zero client changes.
- The extension keeps fallback engines (system voices, optional cloud key) so it stays
  usable if the daemon is down — the daemon is the default, not a hard dependency.
- For other SI-Thor installs: the daemon is intentionally hardware-agnostic CPU/GPU-wise
  (engines range from Piper-on-CPU to GPU models), so smaller boards can host the same
  API with reduced voice tiers.
