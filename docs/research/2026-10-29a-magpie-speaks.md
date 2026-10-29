# Research notes (a) 2026-10-29 — the night Magpie spoke on the Thor

**Outcome first:** Riva 2.26 now serves **MagpieTTS Multilingual 357M** on the
Jetson Thor — 5 speakers × 12 languages, TensorRT engines, measured at
**cold TTFA 0.243 s / warm median 0.188 s / RTF ≈ 0.35** in 120 W power mode,
first pass, zero tuning. The skald's first voice exists. Audio in
`~/src/skald-riva/audio/` (tale.wav, probe_en-US/fr-FR/de-DE).

## Method note (the part worth keeping)

The owner asked for a GAN-style refinement hour: iterate against the live
system, let each failure name the next experiment. Fifteen layers deep, the
pattern that won every time:

1. **Instrument before guessing** — when deduction forked, we printed the
   actual runtime shapes (the `SKALD-SHAPES` file-logged probe) and the
   answer was immediate: `embedded=(1,1,768) mask=(1,2)`.
2. **The checkpoint is ground truth** — whenever model and code disagreed
   (embedding rows, mapping ids), we made the code follow the checkpoint.
3. **Our repo files are fair game** — the Triton backend module
   (`magpie_unified_model.py`) ships inside the model repository, so shims
   (kwarg filter, embedding pad, mask rebuild, device align) ride with the
   deployment; the container image stays pristine.
4. **Declared offsets beat derived ones** — the pbtxt's
   `multi_char_tokenizer_offset` string is training truth; reconstruction
   order from the config disagrees with it. Don't re-derive, use declared.

The full 15-layer root-cause table lives in
`daemon/riva-deploy/repair/README.md` with the reproducible repair chain
(`repair_all.sh`).

## Measurements (ADR-0005 scorecard row: riva/magpie-357m)

| Metric | Value | Context |
|---|---|---|
| Cold TTFA | 0.243 s | first request after load |
| Warm TTFA (median/min/max) | 0.188 / 0.080 / 0.223 s | 8 short sentences |
| RTF sustained | ≈ 0.35 | 120 W mode, jetson_clocks NOT applied |
| Long-doc stability | see benchmark results JSON | 20× 495-word passages |
| Server caps discovered | 2000 chars/request, 400 tokens/sentence | client chunks (~350 chars, sentence-first) — Lane A streams this way anyway |

Sub-1-second live reading budget from the architecture doc: **met with 5×
margin** before any optimization (power mode, concurrency, precision).

## Standing state

- `skald-riva` container: auto-restart, gRPC :50051, HTTP :50000 (HTTP API
  shape unprobed — tile).
- The HF 357M path is the deployed engine; the NGC T5TTS component path is
  parked (its packer wants a single-source checkpoint the deployable set
  doesn't ship; assets harvested from it enabled the HF path's mapping).
- Extension v0.1.0's daemon engine will target :50000 (or a bridge) next.

## Immediate next

1. Owner listens: quality ratings (paper/news/story) → `benchmark/quality-form.md`.
2. Daemon bridge (Phase 1's remaining piece) — subagent track.
3. Probe the Riva HTTP API shape for the bridge design.
4. Re-run scorecard at MAXN power mode + jetson_clocks for the honest max.
