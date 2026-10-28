# daemon/ — the skald voice & content daemon

Status: not started (Phase 1 for Lane A, Phase 3 for Lane B).
Spec: ADR-0002 (OpenAI-compatible API), ADR-0003 (two lanes), ADR-0005 (engines),
ADR-0006 (deployment).

Will contain the FastAPI service(s) run on the Thor via docker compose
(jetson-containers base):

- Lane A: `POST /v1/audio/speech` (streaming, sentence-at-a-time), `GET /v1/voices`
- Lane B: `POST /v1/jobs` podcast factory (extract → chunked LLM script → render →
  stitch → MP3) with status/download endpoints
- Shared: voice registry (base + cloned voices, per-engine license metadata), text
  pipeline (segmentation, normalization, citation stripping), Docling PDF extraction

Phase 1 ships Lane A only, with Kokoro as the fast-tier engine.
