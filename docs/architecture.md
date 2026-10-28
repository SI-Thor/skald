# Architecture — the two-lane voice system

Status: agreed direction (2026-10-28). Details of each lane evolve via ADRs.

## Why two lanes

Every reference design we studied in October 2026 — NVIDIA's pdf-to-podcast blueprint,
and a well-regarded agent-generated "article-to-podcast engine" sketch — optimizes for
**batch** generation: ingest → LLM rewrites into dialogue → render everything → stitch →
deliver a file. That pipeline has minutes of latency by construction.

But skald's owner is the **first-class user of live reading**: click a button, hear the
first sentence in under a second, adjust speed mid-sentence, skip forward a sentence,
swap voices without stopping. No batch pipeline can serve that, and no live reader should
carry batch machinery (an LLM rewriting the text) in its hot path — the user wants the
page read *as written*, immediately.

So one daemon serves two lanes with different contracts:

| | Lane A · Live reading | Lane B · Podcast factory |
|---|---|---|
| Latency contract | first audio < ~1 s | minutes are fine |
| Text handling | as-written (optional cheap cleanup) | LLM-rewritten dialogue |
| Voices | one voice, swappable live | two host personas (may be cloned) |
| Output | streamed audio | MP3 file + job status |
| API | `POST /v1/audio/speech` (OpenAI-compatible, streaming) | `POST /v1/jobs` + status/download |

## Component view

```
                ┌───────── Voice & Content Daemon (Thor) ─────────┐
 extension ────▶│ LANE A · LIVE READING                           │
 apps on LAN ──▶│   /v1/audio/speech — streams sentence by        │
 scripts/curl ─▶│   sentence, prefetches 2–3 ahead, no LLM wait   │
                │   engines: Kokoro (fast) ↔ expressive (winner   │
                │   of on-device benchmark), swappable mid-call   │
                │ LANE B · PODCAST FACTORY                        │
                │   /v1/jobs — Docling extract → chunked LLM      │
                │   dialogue script (map-reduce over sections) →  │
                │   render per-line → ffmpeg stitch → MP3         │
                │ shared substrate:                               │
                │   · voice registry (base voices + clones)       │
                │   · text pipeline (extraction, chunking,        │
                │     normalization, citation stripping)          │
                │   · OpenAI-compatible API surface               │
                │   · docker compose on jetson-containers         │
                └─────────────────────────────────────────────────┘
```

## Shared substrate decisions

- **OpenAI-compatible API surface** (`/v1/audio/speech`): the emerging industry
  convention (NIM, OpenAI, many servers). Any client that can call OpenAI TTS can call
  skald, and skald can swap its engine without clients noticing.
- **Voice registry**: named voice identities — stock model voices plus cloned profiles
  (10–30 s reference audio). Both lanes address voices by the same names, so the voice
  you A/B in the extension is the voice your podcasts get.
- **Text pipeline**: one library for extraction (page main-content / PDF via Docling),
  sentence segmentation, and optional normalization (expand abbreviations, strip
  citation markers like [1][2]). Lane A uses the cheap parts synchronously; Lane B uses
  the LLM parts in batch.
- **Deployment**: docker compose services on jetson-containers (not one monolithic
  container), so lanes restart independently and GPUs are allocated per service.

## Extension ↔ daemon contract (Lane A detail)

1. Extension extracts main-content text in the content script (Readability-style),
   segments into sentences, and requests audio sentence-by-sentence with prefetch.
2. Speed is applied client-side (`audio.playbackRate`, pitch preserved) so the slider is
   instant regardless of engine; the daemon also accepts a speed hint for engines that
   synthesize better time-scaled audio.
3. Engine/voice switching mid-playback = just change the params on the next sentence
   request. The daemon exposes `GET /v1/voices` listing engines and voices with metadata
   (tier, latency class, languages).
4. System voices (browser `speechSynthesis`) and cloud APIs remain fallback engines
   inside the same dropdown — the daemon is the default, not a hard dependency.
