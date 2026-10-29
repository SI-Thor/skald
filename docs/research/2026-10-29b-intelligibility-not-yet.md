# Research notes (b) 2026-10-29 — CORRECTION: plumbing green, intelligibility NOT yet

**This note corrects the earlier "MAGPIE SPEAKS" claim (2026-10-29a).** The
owner's "think and try again" prompted machine-ear verification (Whisper
tiny.en round-trip), which showed the synthesized audio is **structured
sound, not intelligible speech** — fluent-audio babble that ASR hallucinates
over. All latency/stability numbers remain valid; the semantic content is
wrong. Good catch, and exactly why acceptance needs ears (or ASR).

## What was verified/eliminated since

- **Machine ears added**: `work/offline_synth.py` (pure-python end-to-end
  synthesis bypassing the C++ preprocessor entirely) + Whisper round-trip.
  Tooling is reusable for every engine candidate — an ADR-0005 scorecard
  addition: intelligibility check before any human listening session.
- **Eliminated as root cause**:
  1. C++ preprocessor mapping ids (offline python path babbles identically).
  2. Old-vs-new tokenizer vocab generation (nemo-toolkit 3.0.0's tokenizer
     package overlaid — the checkpoint's own generation — same babble).
  3. Inference parameters (cfg_scale 2.5, temp 0.6, topk 80 — sane).
  4. Weight loading (strict load passes; embedding pad only enables the
     load, checkpoint rows overwrite all values).
- **Symptom pattern**: ~4-5× more audio generated than the text warrants,
  attention not binding text→audio, speech-like prosody, wrong words. Both
  the server path (full NVIDIA orchestration: chunking, CFG, priors, fades)
  and the bare offline path produce it.
- **Remaining suspects** (diminishing-return archaeology): multi-encoder
  conditioning subtleties, codec codebook-id conventions (legacy_codebooks
  remap in update_config), attention-prior alignment, or an intended
  inference orchestration we haven't reproduced.

## The shortest remaining route

The official 2.26 quickstart **supports this exact 12-language model**
(`tts_model="magpie"`, `tts_language_code="multi"` in its config.sh). Its
init pulls NVIDIA's own prebuilt RMIR + language assets — the sanctioned,
tested artifact set. That resource (`nvidia/riva/riva_quickstart_arm64`
v2.26.0, 147 KB, browser-downloadable with the owner's NGC login) encodes
the canonical pull list. Secondary route: the per-language
`speechsynthesis_<lang>_auxiliary_files` + `normalization_<lang>` NGC
resources (the tutorial's names) would complete our repaired deployment's
G2P assets properly.

Registry name-probes for a prebuilt magpie RMIR image came up empty; the
quickstart bundle is the authoritative naming source.

## Status

- Serving stack: UP and green on all plumbing metrics.
- Audio: NOT intelligible; do not ship. Scorecard row flagged.
- Next: quickstart bundle (one browser download) → canonical model set →
  deploy → ASR round-trip → human ears.
