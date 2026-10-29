# Research notes (c) 2026-10-29 — THE SKALD SPEAKS (machine-verified)

**Verified intelligible.** Whisper tiny.en round-trip on the official engine's
output: expected *"The skald clears his throat and begins the tale."* →
heard *"The scald clears his throat and begins the tail."* — homophone-level
ASR ambiguity only. The ASR gate (added 2026-10-29b) passes.

## The unlock chain (each step enabled the next)

1. **box64 v0.4.4 from source** (Ubuntu's 0.2.6 lacks the `twalk` symbol the
   x86 NGC CLI's bundled Python needs) → x86 CLI runs under emulation.
2. **NGC CLI env auth** (`NGC_CLI_API_KEY`, `NGC_CLI_ORG=nvidia`) → every
   gated NGC resource is now scriptable; no browser, no interactive config.
3. Official **`riva_quickstart_arm64:2.26.0`** bundle → NVIDIA's own recipe,
   which contained: the **native ARM64 CLI URL**
   (`nvidia/ngc-apps/ngc_cli` — a resource path nothing public had indexed)
   and the **canonical model naming rule** for tegra.
4. **`nvidia/riva/models_tts_magpie_multilingual_ipa:2.26.0-tegra-thor`** —
   a 3.3 GB prebuilt: `tts-MagpieTTS_21hz_codec_trtllm_Multilingual_bs2_
   jetson_2602_deployed.tar.gz`.

## Why our from-scratch path could only babble

The prebuilt is a **TensorRT-LLM batch-2** engine build. Every path we
reconstructed (ONNX components, PyTorch offline, C++ preprocessor + ONNX
ensemble) was the wrong *engine architecture* for this model's Thor
deployment — the babble was never an id/vocab problem. The repair chain
remains valuable: it green-lit the entire serving stack, and every fix
(nemo: URIs, speaker splitting, shims, mask rebuild) was load-bearing for
reaching that conclusion quickly.

## What's now live

- Server on `model-repo-official/` (4.1 GB), auto-restart, ports 50051/50000.
- **Voices**: `Magpie-Multilingual.<LOCALE>.<Name>[.Emotion]` — Mia, Jason
  and others, each with Neutral/Calm/Angry/Happy/Sad styles. **The Lane C
  character voice palette already exists** — emotions included.
- First synthesis: 2.3 s audio / 2.26 s wall (includes warmup); emotional
  variant 1.49 s. Formal scorecard run in flight.

## Standing decisions

- Official prebuilt = the deployment default (bake into scripts next).
- HF-repaired path = parked tile (documented in repair/README).
- ASR round-trip = permanent scorecard gate before human listening.
