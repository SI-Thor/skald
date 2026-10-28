# ADR 0003 — Two lanes: live reading (first-class) and podcast factory (batch)

- **Status:** Accepted (2026-10-28)
- **Context:** Seeded by NVIDIA's pdf-to-podcast blueprint, fish-speech, and an
  agent-generated "article-to-podcast engine" architecture sketch shared by the owner.

## Context

Every reference design we studied optimizes **batch** podcast generation: ingest →
LLM rewrites into a two-host dialogue → render everything → stitch → deliver a file.
That pipeline necessarily has minutes of latency.

But the owner's stated position: they are the *first-class user of live reading* —
click, hear the first sentence in under a second, adjust speed mid-sentence, skip a
sentence, swap voices without stopping. Reading the page *as written* is the primary
act; a podcast is a derived, offline artifact.

Forcing either use case into the other's shape fails: batch latency breaks live
control; live constraints (no LLM rewriting, streaming-only) would gut the podcast
format.

## Decision

One daemon, two lanes:

- **Lane A — live reading:** sentence-at-a-time streaming with prefetch; no LLM in the
  hot path; cheap text pipeline only (segmentation, optional citation stripping).
  First audio in well under a second on the fast tier.
- **Lane B — podcast factory:** asynchronous jobs (`POST /v1/jobs` + status/download):
  extraction → chunked LLM dialogue scripting (map-reduce over document sections —
  single-shot JSON breaks on research-paper length) → render per line on the expressive
  tier → stitch to MP3.

Shared substrate between lanes: voice registry (same named voices/clones in both),
text pipeline, OpenAI-compatible API, docker compose services.

## What we adopted vs fixed from the seed sketches

Adopted: jetson-containers foundation, FastAPI async orchestration, the JSON
dialogue-script contract, ffmpeg/pydub stitching, memory-budgeting discipline,
NVIDIA's guide-prompt and `--monologue` concepts, Docling for PDF extraction.

Fixed: Coqui/XTTS pick (project dead since 2024, license-restricted, surpassed);
missing long-document chunking (single LLM call truncates on 10k-word papers);
monolithic composite container (compose services restart independently); decorative
memory numbers (measure, don't budget fiction).

## Consequences

- The extension eventually grows two actions: *Read now* (Lane A) and *Make podcast*
  (Lane B, notify when done).
- Lane B can use the heaviest/highest-quality engine available regardless of latency,
  while Lane A picks from streaming-capable engines only.
- For other installs: a client who only wants "PDF → podcast appliance" can deploy
  Lane B alone; a client who wants voice UI for a kiosk deploys Lane A alone. The lanes
  are the module boundaries.
