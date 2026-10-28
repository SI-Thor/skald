# Research notes (d) — Riva/Magpie on Thor: false start, real stack, self-serve deployment

**Date:** 2026-10-28 (evening). Owner set up "Riva" via a minimal homebrew
quickstart; this session diagnosed it, mapped the real 2.26 embedded stack, and
built a fully self-serve deployment path that removes NGC's login/EULA gates
from the critical path. Deploy toolkit lives in `daemon/riva-deploy/` (copied
from the working dir `~/src/skald-riva/deploy/`); provenance labels inside:
**[VERIFIED-image]** vs **[RECONSTRUCTED-docs]** vs **[INFERRED]**.

## 1. False start post-mortem (tile: verify, never trust echo-success)

The homebrew `~/riva_quickstart` scripts printed success but nothing ran:
- `riva_init.sh` only did `docker pull` + `mkdir`. The model repository stayed **empty**.
- `riva_start.sh` used `docker run -it --rm ... &` from a closing terminal → container
  got SIGHUP and died; `--rm` erased the evidence. `docker ps -a` empty, nothing on :50051.
- Standing rule: **every "start" step gets an independent verification**
  (`docker ps`, port listen, health endpoint, first audio). All deploy scripts
  embed verification; `04_probe.sh` is the acceptance gate.

## 2. What Riva 2.26 embedded actually is (verified by image inspection)

Image `nvcr.io/nvidia/riva/riva-speech:2.26.0-l4t-aarch64` (32.2 GB):
- Entrypoint execs its args → correct container command is **`start-riva`**
  (not `riva_server`, which skips Triton — the homebrew's second bug).
- `start-riva` serves `/data/models` via Triton (gRPC 8001 / HTTP 8002 /
  metrics 8000) fronted by Riva gRPC **50051**, Riva HTTP **50000**, realtime 9000.
- Full deploy toolchain inside the image: `nemo2riva` (--audio-codec …),
  hydra `riva-build` (`servicemaker.cli.build_hydra`, `configs/tts/base.yaml`,
  Magpie-native overrides), `riva-deploy`. Clients inside: `riva_tts_client`,
  `riva_tts_perf_client`, `/opt/riva/examples/talk.py` (--list-voices…).
- `riva-pipeline` deployer images do **not** exist for 2.26 — old-quickstart
  assumptions don't apply.

## 3. NGC gating map (tile: the browser is the only gate)

With the owner's NGC key as Bearer on api.ngc.nvidia.com:
- WORKS: `/v2/users/me`; artifact **metadata** incl. `latestVersionIdStr`,
  `canGuestDownload`, sizes.
- BLOCKED: `/versions` + `/files` (403 "not Guest accessible!") for
  `nvidia/riva/riva_quickstart_arm64` v2.26.0 (147 KB) and
  `nvidia/riva/models/speechsynthesis_multilingual_magpietts_ipa deployable_1.0`
  (685 MB, fp16, Blackwell-listed, but March-2025 vintage). Browser sign-in +
  EULA click unlocks both — remains the sanctioned fallback for the newest
  Magpie-Flow voices (`Magpie-Multilingual.EN-US.Mia`, 7 langs in the 2.26
  quickstart docs).
- `ngc.nvidia.com/downloads/*.zip` links are dead HTML soft-404s; Magpie NIM
  containers pull-denied pre-EULA.

## 4. The self-serve route (chosen) — HuggingFace

- `nvidia/magpie_tts_multilingual_357m` → `magpie_tts_multilingual_357m.nemo`
  (**1.47 GB, downloaded**). 12 languages, NVIDIA **Open Model License**.
  **Zero-shot voice cloning was REMOVED from this release** (model card):
  runtime voices are fixed speakers (`Magpie-Multilingual.<LOCALE>.<Gender>.<Style>`,
  emotion styles) — see §6 for the consequence. Repo also ships **GGUF builds**
  (f16/q8_0) — tile: llama.cpp CPU-only engine path.
- `nvidia/low-frame-rate-speech-codec-22khz` → codec `.nemo` (**619 MB, downloaded**).
- Build command (Path A, NVIDIA's own example for exactly this checkpoint):
  `riva-build --config-path=pkg://servicemaker.configs.tts --config-name=base
  output_path=… source_path=[{path: model.nemo, nemo2riva: {audio_codec: codec.nemo}}]
  multilingual=true voice_name=Magpie-Opensource sample_rate=22050
  language_code=<12 locales> platform_aarch=true force=true`
  Fallback Path B: `nemo2riva --audio-codec …` then riva-build (both in
  `01_build_rmir.sh`, `BUILD_MODE=twostep`).
- Known risks documented in `daemon/riva-deploy/NOTES.md` §Unknowns: inline
  `audio_codec` key spelling [INFERRED], possible wfst language-asset
  requirements, `--config-path` form (module-invocation fallback verified),
  `tlt_encode` key if decrypt errors appear, root-owned build outputs.

## 5. Ops lessons (2026-10-28)

- Subagents hit the same interactive-approval gates as the main session when
  the owner steps away; workaround that WORKED: research agent delivers file
  *content* in its final report; main session materializes verbatim. Keep this
  pattern for unattended operation.
- Content relayed between agents survives in conversation context; disk writes
  resume when the gate lifts. Idempotent scripts (env-parameterized, -f flags)
  made the resume a single command.

## 6. Consequences for skald (engine + character design)

- **Engine tier**: Riva-Magpie becomes the first GPU engine row in the ADR-0005
  benchmark table once `04_probe.sh` yields TTFA/RTF numbers (pending).
- **Character voices (Lane C)**: the earlier assumption "Magpie zero-shot =
  clone a voice from a 10–30 s sample" is **wrong for this checkpoint**. V1
  characters get distinct *fixed* voices + emotion styles; cloning arrives
  with the fish-speech/Chatterbox tier (Phase 2 benchmark). Character files
  therefore bind to a swappable **voice slot** (registry indirection), so a
  persona survives voice upgrades. Corrected in `docs/design/lane-c-explorations.md`.

## 7. Next

1. `02_deploy_repo.sh` → `03_start_server.sh` → `04_probe.sh` (voices + timings).
2. Record TTFA/RTF here; add Riva row to ADR-0005's table; ideas tiles: GGUF-Magpie
   CPU path, HTTP-:50000 bridge investigation (OpenAI-shaped or not).
