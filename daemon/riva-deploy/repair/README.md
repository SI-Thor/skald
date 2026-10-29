# repair/ — bringing the HF Magpie 357M deployment to life on Jetson Thor

The night of 2026-10-28/29, a single question — "why doesn't the server
start?" — peeled fifteen failure layers. This directory is the complete,
reproducible repair chain for a fresh `02_deploy_repo.sh` output, plus the
story, because the *reasoning* is the reusable part (ADR-0007).

## Status: PARKED (superseded by the canonical TRT-LLM prebuilt)

The serving chain this repairs is fully operational — but its audio was
**not intelligible** (wrong engine architecture for this model's Thor
deployment; the canonical prebuilt won — see `docs/research/2026-10-29b/c`).
Kept as a tile: the repair techniques are load-bearing for any future
from-source deployment, and the 15-layer root-cause table is the
telephone-judo textbook.

- Server: `skald-riva` container, gRPC :50051 / HTTP :50000, auto-restart.
- Voices: `Magpie-Opensource.Speaker0..4`, 12 languages.
- Measured (plumbing only — see parked banner): cold TTFA 0.182 s,
  warm median 0.213 s, sustained RTF 0.61, 20/20 stability @120 W.

## The fifteen layers (root causes, in order encountered)

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Hydra "ambiguous value" on language_code | comma list needs literal quotes through 2 bash layers | mounted inner script (`build_inner.sh`), quotes survive |
| 2 | `IPATokenizer(locale_specific_punct=…)` TypeError | checkpoint (NeMo-Speech Jul-2026) vs image nemo 2.8.0rc0 skew | `nemo2riva_compat_driver.py`: drop unknown kwargs (safe: flags default off) |
| 3 | abstract `ModelPT` restore failure | red herring — the fallback after #2 | — |
| 4 | embedding 3359 vs 3357 rows | dropped locale-punct feature shrank old tokenizer vocab by 2 | pad embeddings to checkpoint (checkpoint = ground truth) |
| 5 | `'vocab' in train_ds` TypeError | HF inference export has `train_ds: null`; only KeyError caught | explicit `phone_set=ipa` skips broken auto-detect |
| 6 | server: missing `<lang>/mapping.txt` | riva-build only *copies* language assets from a supplied dir; HF path has none | inject from NGC bls.riva, then (9) generate ground truth |
| 7 | `register_artifact` join(None) | `nemo:HASHED` URIs unresolvable without a .nemo backing | stage assets + rewrite URIs to absolute paths (`patch_model_repo.py`) |
| 8 | missing `Speaker0-4.pt` | preprocessor wants per-speaker embedding files | split `baked_context_embedding.pt` (keys 0-4) |
| 9 | every character "not found in dictionary" | injected T5TTS mapping has wrong ids for this model | `gen_mapping.py`: rebuild per-language mapping from the model's own tokenizers using the pbtxt's DECLARED offsets (not construction order) |
| 10 | C++ parser crash on ko-KR mapping | byt5 vocab contains invisible/control chars | emit printable single chars + specials only |
| 11 | `ArabicCharsTokenizer(charset_version=…)` | same skew as #2, now at serving | kwarg shim injected into `magpie_unified_model.py` (ships with the repo) |
| 12 | embedding mismatch at load (again) | #4 at serving time | same pad shim injected server-side |
| 13 | `torch.cat` CPU vs CUDA context | Speaker embeddings arrive on CPU | `.to(encoder_out.device).to(encoder_out.dtype)` at the three sites |
| 14 | x=217 vs mask=218 | `embed_audio_tokens` returns STACKED lens; mask built from raw lens once, before the loop; lens lag the growing prefix | rebuild all-valid mask over embedded length each step |
| 15 | "input larger than max" benchmark failures | server caps: 2000 chars/request, 400 tokens/sentence | client-side chunking (~350 chars, sentence-first) — how Lane A streams anyway |

## Files

- `patch_model_repo.py` — stage checkpoint assets, rewrite `nemo:` URIs, split speaker files (#7, #8)
- `gen_mapping.py` — ground-truth per-language mapping.txt (#9, #10)
- `inject_server_shim.py`, `inject_server_shim2.py` — kwarg filter + embedding pad, injected into the deployed backend module with idempotent markers (#11, #12)
- `repair_backend.py` — device alignment (#13) + mask rebuild (#14) + pbtxt chunk params (chunk_ms 300→90, fade_ms 10→5, history_len 5→6) applied to the deployed backend file and `config.pbtxt`
- `repair_all.sh` — orchestrates everything against a fresh `model-repo/` (run inside the riva container with /repo + /work mounts; see header)

## Notes for the future

- Delete `__pycache__` in the model dir after ANY edit to backend files.
- The backend module is OURS (part of the model repo) — shims ship with the
  deployment; the image stays pristine.
- 'g'/'r' ASCII letters missing from en-US mapping is EXPECTED (IPA 'ɡ'
  U+0261 is the real token; dictionary phonemes cover those words).
- The NGC T5TTS 5-component RMIR path (see ../NOTES.md) is parked as a tile:
  its packer wants a single-source checkpoint the deployable doesn't ship.
  The HF path + this repair chain won.
