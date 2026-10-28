# Research notes (b) — NIM prerequisites recheck, Riva status, toolkit survey

**Date:** 2026-10-28, later the same day as the first research note — this one was
prompted by the owner sharing the NIM prerequisites page and the NVIDIA developer
downloads listing, plus a new hardware asset (see below).

## Correction to earlier findings

The NIM LLM/VLM prerequisites page
(https://docs.nvidia.com/nim/large-language-models/latest/get-started/prerequisites.html)
now lists supported CPUs as **"AMD64, ARM64"**. My earlier note ("x86_64-built, ARM64
maturing") came from forum threads and is outdated at the architecture level. The real
gates today:

- **Jetson is not named on the page** — whether the ARM64 builds run on L4T/JetPack 7
  driver stacks (page wants driver 580+, CUDA 12.9+, Container Toolkit 1.14+) is the
  open question for the Thor. Needs one hands-on experiment, not more reading.
- **Per-NIM VRAM minimums rule small GPUs out of big models**: Llama-3.1-8B NIM wants
  ≥ 24 GB GPU memory. The RTX 4050 laptop (6 GB) cannot host LLM NIMs. Speech NIMs are
  much smaller — plausible on 6 GB, verify per-NIM.
- Access: NVIDIA Developer Program (free) works; AI Enterprise only needed for
  production/commercial branch.

## Riva (now "Nemotron Speech")

- Components: ASR (~12 langs), TTS (en/de/it/zh/es pipelines), NMT (~32 langs),
  speech-to-speech. Custom/fine-tunable TTS voices.
- Deployment: containers/NIMs on-prem or cloud; the speech **NIM** packaging targets
  x86 + Volta+ GPUs.
- **Jetson/ARM64 path exists but is gated**: Riva ships L4T-aarch64 builds (e.g.
  v2.24.0, Jan 2026) under early-access registration, with community-reported runtime
  problems on Jetson. No official Riva-NIM-for-Thor announcement as of this date.
  - https://forums.developer.nvidia.com/t/riva-newest-version-2-24-0-only-have-l4t-aarch64-version/357554
  - https://forums.developer.nvidia.com/t/request-access-to-riva-arm64-jetson-quickstart/335886
- Licensing: NVIDIA AI Enterprise (90-day eval free). Client installs that ship Riva
  need a licensing plan; open engines (Kokoro, fish-speech, Chatterbox) stay the
  license-clean baseline.

## New hardware asset: ASUS ProArt laptop (Ryzen 9 AI, RTX 4050 6 GB)

Role assigned (ADR-0008): **optional x86 GPU worker** behind the Thor daemon —

- Eval host for speech NIMs / Riva (x86 packaging, models small enough for 6 GB)
- Batch renderer for podcast lane / releasable content (client deliverables)
- Not an LLM-NIM host (24 GB-class minimums vs 6 GB VRAM)
- OS to confirm when first used (ProArt normally Windows 11 → Docker via WSL2 +
  NVIDIA Container Toolkit, or Linux if re-imaged)

Counterpoint worth remembering: the Thor's 128 GB *unified* memory means the Thor
itself is the better NIM-LLM host *if* the driver-stack experiment succeeds — the
laptop is the fallback for x86-only packaging, not the only NIM path.

## Toolkit survey (from developer.nvidia.com/downloads)

**Use now (Phase 1–2):**
- TensorRT / CUDA-X (already in JetPack): ONNX/TensorRT builds of Kokoro; TensorRT-LLM
  for the podcast lane's script LLM on Thor.
- Nsight Systems (Developer Tools): GPU profiling during the engine benchmark — find
  where time-to-first-audio actually goes.

**Use later (business tiles):**
- TAO Toolkit: fine-tune/custom TTS voices per client — a service SI-Thor can sell
  ("your brand's narrator").
- NGC private registry: distribution backbone for SI-Thor — push adapted per-client
  images, technicians pull and install. Deployment story for the whole business, not
  just skald.

**Other-install families (tiles, not skald):**
- Isaac (robotics), Metropolis (video analytics), Clara (health), DRIVE (auto) — the
  "technicians installing hardware" business may meet these on other jobs.
- Omniverse/Audio2Face — only if a talking-avatar tile ever activates.

**Skip for this project:** Gameworks, HPC SDK, Maxine (Windows).

## Re-check trigger

**GTC Washington D.C., Nov 30 – Dec 3, 2026** — the natural moment for NIM/Riva
Jetson-ARM64 announcements. Re-verify this entire note after GTC.
