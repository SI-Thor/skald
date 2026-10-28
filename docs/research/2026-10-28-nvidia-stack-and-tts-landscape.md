# Research notes — NVIDIA speech stack, NIM on Jetson, and the TTS engine landscape

**Date:** 2026-10-28 (all statements true as of this date; the AI tooling world moves —
re-verify anything load-bearing before relying on it later)

## Verified findings

### NVIDIA Broadcast
- Windows-only application; requires desktop RTX GPU. No Linux/Jetson version exists.
- It is **input-side** (microphone noise/echo removal, virtual camera) — not a TTS
  system at all. The appealing concept ("system-wide AI voice utility bundled with the
  hardware") is what skald implements, with different parts.

### NVIDIA NIM on Jetson Thor
- NIM = self-contained Docker containers (model + runtime, OpenAI-compatible API).
  Officially "any NVIDIA GPU with enough memory," in practice **x86_64-built**.
- ARM64/Jetson (JetPack 7) container support is maturing but not there for speech NIMs:
  - https://forums.developer.nvidia.com/t/docker-mirroring-on-jp7/358821
  - https://forums.developer.nvidia.com/t/does-nanollm-support-jetpack-7-0/365168
- Speech NIM catalog (hosted): https://build.nvidia.com/models?label=nim%2CNemotron+Speech%2CTTS
- Self-hosted NIM mode requires an NVIDIA AI Enterprise license.

### NVIDIA pdf-to-podcast blueprint
- Repo: https://github.com/NVIDIA-AI-Blueprints/pdf-to-podcast (Apache-2.0);
  docs: https://docs.nvidia.com/vgpu/toolkits/pdf-to-podcasts/latest/index.html
- Architecture: Docling (PDF extraction) → LLM **ensemble** (Llama 3.1 8B + 70B +
  Llama-3.3-nemotron-super-49B-v1.5 via NIM) generates the dialogue transcript →
  **ElevenLabs cloud TTS** → stitching; Redis/MinIO/Jaeger sidecars on docker compose.
- Notably: NVIDIA's own pipeline does not use NVIDIA TTS — it outsources to ElevenLabs.
- Patterns worth stealing (adopted in ADR-0003/0006): guide prompt ("focus on X"),
  `--monologue` flag, ensemble/chunked scripting for long docs, Docling extraction,
  concurrency-limited TTS dispatch.

### fish-speech (checked 2026-10-28)
- Repo: https://github.com/fishaudio/fish-speech
- Current models: **Drama 3** (flagship, 35B-A3B MoE — too heavy for live lane on
  Thor) and **S2-Pro** (previous flagship, 4B, "consumer GPU" class).
- S2-Pro: RTF 0.195 and ~100 ms to first audio *on an H200* — embedded Blackwell will
  be much slower; must be measured (ADR-0005). Cloning from 10–30 s reference audio;
  ~100 languages; streaming supported.
- Licenses: Fish Audio Community License (code+models); S2-Pro weights under Fish Audio
  Research License. Fine for personal/client installs, no model-derived redistribution.

### Open TTS landscape (2026 comparisons)
- **Kokoro-82M** — best lightweight default: Apache-2.0, 54 voices / 8 languages,
  CPU-capable or ~2–3 GB VRAM. No cloning, no emotion control. (Refs:
  https://localaimaster.com/blog/best-local-tts-models,
  https://www.bentoml.com/blog/exploring-the-world-of-open-source-text-to-speech-models)
- **Chatterbox** (Resemble) — expressive + cloning; MIT code.
- **Orpheus-3B** — LLM-based TTS with emotion tags (`<laugh>` etc.).
- **Coqui XTTS-v2** — project dead (Coqui shut down 2024), frozen, non-commercial
  license; historically popular, now surpassed. Rejected for skald.
- **Piper** — ultralight, CPU-only, robotic-adjacent but instant; kept as fallback/control.

### Jetson-native deployment path
- `dusty-nv/jetson-containers` + Jetson AI Lab is the working local-inference route on
  ARM64; JetPack 7 image coverage still filling in (see NIM forum links above).

## Open questions to re-verify later

- ARM64 NIM speech containers on JetPack 7 (re-check quarterly).
- fish-speech S2-Pro real RTF on Thor — settled by our own benchmark, not news.
- Whether Drama 3 (35B-A3B) becomes practical for batch podcast quality at Thor-class
  memory bandwidth — worth one experiment when Lane B exists.
