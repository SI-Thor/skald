# LAN latency under load — where the seconds go, and what skald did about it (2026-10-30)

**Question (owner's report):** from the ProArt, a one-sentence line took
**1.4–4.9 s** while the Thor was at load ~100 / GPU 97% (another project's
decision models + builds). The scorecard's 0.165 s TTFA is the *unloaded*
case (`benchmark/evidence/SCORECARD.md`). Production means the contended
case.

**TL;DR**

| Path (one 65-char sentence) | Time until audio starts | Conditions |
|---|---|---|
| Whole WAV (`/v1/audio/speech`), localhost | **10.6–11.3 s** | load 3.3–3.8, GPU 85–98% |
| Whole WAV via LAN IP (`192.168.0.78`) | **11.2–22.0 s** | same |
| Direct Riva `:50000/v1/audio/synthesize` | **10.8–11.3 s** | same |
| **Stream first chunk** (`/v1/audio/speech/stream`) | **0.45–0.86 s** | same |
| Prefetched sentence (extension cache hit) | **~0 s** (no request) | any |
| Unloaded reference (scorecard) | 0.150–0.165 s | MAXN, idle |

Under tonight's contention the *whole-file* wait grew to ~11 s — 2× the
owner's worst report — while the **streamed first audio chunk stayed under
0.9 s**. That asymmetry is the whole story: Riva's `synthesize_online`
returns audio incrementally, so time-to-first-audio tracks the *first
increment*, not the sentence.

## Where the time goes (measured, not guessed)

1. **GPU compute contention dominates everything.** Direct-Riva and
   through-the-daemon whole-WAV times are the same within noise
   (10.8–11.3 vs 10.6–11.3 s): the daemon adds ≈0. The cost is Riva's
   synthesis competing with the other tenants' GPU jobs (`nvidia-smi`
   85–98% while CPU load was only ~3.5 — GPU-bound, not CPU-bound).
2. **LAN transport adds ≈0.** Loopback vs `192.168.0.78` first-chunk times
   are the same (0.45–0.86 vs 0.50–0.61 s); whole-WAV differences in the
   11–22 s range track GPU-job intensity during the run, not the network.
3. **The request shape was the bug.** The extension used to wait for the
   whole WAV (`response_format: wav`, one blob) — under contention that
   means "wait for 100% of the sentence's GPU work" before the first word.

## What skald changed (ADR-0011, all within skald's own reach)

- **Stream the first sentence** (Chrome): `POST /v1/audio/speech/stream`
  (the daemon's chunked-PCM proxy of Riva's `synthesize_online`) through
  the offscreen AudioContext — audio starts with the first chunk
  (0.45–0.86 s tonight) instead of after the whole sentence (~11 s).
  Measured with headers excluded (uvicorn sends headers immediately; the
  metric is first *audio* byte).
- **Prefetch 2 sentences ahead + 16-entry LRU cache**: the steady state is
  a cache hit — the next sentence starts at ~0 s while its synthesis
  happened during the previous one's playback.
- **Keep the engine warm**: Riva keeps the TRT-LLM engine resident between
  requests; nothing for skald to do beyond not letting the container idle
  out (it doesn't).
- Firefox and rate≠1.0× stay on whole-WAV (pitch-preserving speed needs an
  `<audio>` element) — they get prefetch but not the streamed start.

**Intelligibility of the stream path** (a 200 is not "working audio"):
whisper (tiny.en, CPU) transcribed the streamed capture verbatim —
*"The quick brown fox jumps over the lazy dog near the river bank at dawn."*
Gate: PASS.

## The honest limit: streaming fixes the START, not the SUSTAIN

The test sentence is ~3.9 s of audio (172 KB PCM @ 22.05 kHz). Under
tonight's load a synthesis takes ~10.8 s — RTF ≈ 2.8 *against* us. With
2-sentence lookahead the extension buffers ~7.8 s of audio but each refill
costs ~10.8 s: under sustained 97% foreign GPU load, gaps between later
sentences are arithmetic, not fixable inside skald. Under the owner's
1.4–4.9 s load mix (synthesis ≲ audio duration), stream + prefetch makes
reading effectively gap-free. More lookahead would not help — Riva
serializes, so lookahead queues behind itself.

## Recommendations for the other tenants (deliberately NOT changes by skald)

The Thor is shared; skald will not touch other services. What would fix
the *cause*:

- **Cap GPU-job concurrency to one** at a time (the 11–22 s whole-WAV
  samples line up with overlapping builds). A single job leaves enough GPU
  for ~0.5 s TTFA even while running.
- **Move heavy builds off reading hours** or to the x86 worker (ADR-0008's
  topology exists for exactly this).
- If builds must run all day: nice/ionice do NOT help (GPU queue), but
  shrinking per-job batch size / engine-build concurrency does.
- MIG is not available on Jetson Thor, so partitioning the GPU is not an
  option; CUDA MPS with active thread percentage could be explored if the
  tenants want formal sharing.

## Future skald work this note defers

- A **priority lane in the daemon** (live `/v1/audio/speech*` requests
  ahead of any batch work) is worth building when Lane B (batch
  article→podcast) lands — today skald itself has no batch traffic, so
  there is nothing to prioritize against yet.

## Reproduction

Commands and per-run load/GPU are in this note's table; the measurement
loop recorded `cut -d' ' -f1 /proc/loadavg` and
`nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader` beside every
sample (2026-10-30, 20:22–20:31 Thor time, uptime 19:24). Stream timing
used httpx `iter_bytes()` with headers excluded; whole-WAV used curl
`time_starttransfer` (== total for a single blob).
