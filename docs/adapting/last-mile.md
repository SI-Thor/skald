# Adapting skald for last-mile — builder's guide

For whoever builds [SuperInstance/last-mile](https://github.com/SuperInstance/last-mile)
(distributed procgen sim: ProArt sequencer/renderer, Thor agent host, Orin
archive, "the game is the score"). This is what skald already gives you, what
you'll need to add, and the honest gaps.

## What skald already running gives you, today

1. **Speech as a LAN service.** `skald-daemon` (Thor, :8000) is an
   OpenAI-compatible endpoint — your ProArt sequencer can call it from
   Python right now, no Thor-side code changes:

   ```python
   from openai import OpenAI
   client = OpenAI(base_url="http://192.168.0.78:8000/v1", api_key="x")
   client.audio.speech.create(model="skald", voice="Magpie-Multilingual.EN-US.Mia.Happy",
                              input="We move at dawn.").stream_to_file("utterance.wav")
   ```

   399 voices × 12 languages × emotion styles (`.Happy/.Sad/.Calm/.Angry`) —
   the emotion dimension maps naturally onto utterance-scores' tone tracks.
   Measured on this stack: cold TTFA 0.150 s, RTF 0.55 (MAXN; evidence in
   `benchmark/evidence/`).

2. **The Thor role in your cluster table is already filled.** Your spec
   lists "Riva speech" as a Thor duty — it's deployed, boot-persistent, and
   proven. Don't re-provision; either use the daemon across the LAN (ADR-0008
   worker topology, exactly as designed) or clone `SETUP.md` for a second box.

3. **Portable pieces** (pure Python, hardware-agnostic — run anywhere):
   `daemon/server/` (FastAPI), `benchmark/` (rerun the scorecard on the 4050
   to rank engines on *your* silicon — that's the whole point of ADR-0005),
   `extension/` (a human-facing reader for your archive/replay UIs later),
   and the NGC-CLI unlock recipe (`SETUP.md` §1) for pulling anything gated.

4. **Methodology twins.** last-mile's append-only `decisions.md` is skald's
   ADR+tiles discipline (ADR-0007) under another name — the repos will read
   like siblings on purpose. Steal also: the ASR round-trip gate (utterance
   audio isn't "done" until a recognizer agrees with the score text) and
   power-context benchmarking (RTF without nvpmodel is a rumor — you'll care
   the moment the 4050 is also compositing while synthesizing).

## What you'll need to add (the real adaptation work)

1. **Word timestamps ("words timed against tone tracks").** Skald v0 returns
   opaque WAV. Riva's gRPC API exposes timing/timeline marks in synthesis
   responses — the daemon doesn't surface them yet. First skald contribution
   for last-mile: a daemon response mode that returns `{word: [t_start,
   t_end], style, audio}` so the sequencer can align the tone track. (The
   C++ preprocessor already knows sentence boundaries — see the preprocessor
   outputs in the deployed repo.)
2. **Style as a first-class score parameter.** Emotion styles are voice-name
   suffixes today (`Mia.Happy`). For scores, you want `voice` and `tone` as
   separate request fields with a validation error on unsupported pairs —
   small daemon change, keeps the MIDI principle (decisions travel, the
   renderer picks the instrument).
3. **Concurrent multi-stream budgeting.** Skald serves one stream per
   request, serially tested; a squad of speaking agents needs measured
   concurrency (ADR-0010 §4 — `instance_group_count` vs batching vs serial
   is an open experiment). Budget it like you budget everything: agents spend
   audio-seconds as a resource.
4. **Never-wait fallbacks for speech.** Your "late pre-rendering falls back
   to lower chunk quality" has a speech twin already proven in
   `experiments/lane-c-sim/`: the prefetch buffer + interrupt-discard +
   client-side playbackRate mean late synthesis degrades by *latency*, never
   by *rhythm*. The sim's said-aloud ledger is also your round-log
   semantics: only heard/rendered utterances count as happened.
5. **Auth before two households share a LAN segment** (skald runs
   unauthenticated by design on a home net; flagged in ADR-0008 as a
   pre-distribution tile).

## Topology recommendation

Keep the dependency arrow the way your spec draws it: **ProArt decides,
Thor speaks**. The ProArt holds the score; it requests utterances from the
Thor daemon (or pre-renders them ahead of need — your pre-render-ahead idea
is literal here: speech chunk quality can fall back the same way). Do NOT
deploy Riva on the ProArt: skald's Riva path is the `l4t-aarch64` embedded
build (Thor-only image; the TRT-LLM prebuilt is tegra-thor). If you want
local x86 synthesis later, that's the NIM route (`daemon/riva-nim/README.md`
— x86 manifests exist; ADR-0008 Path A), benchmarked on the 4050 first.

## Honest gaps in skald that touch you

- No streaming WAV yet (whole-file responses; Riva's streaming endpoint
  exists — daemon passthrough is queued in ROADMAP Phase 1).
- No word-timing surface (your #1 add, above).
- Concurrency unbenchmarked (your #3).
- The daemon is v0: expect auth, streaming, and style-parameter additions to
  land as skald Phase-1/4 items — coordinate via both repos' decision logs.

## Reading order for your builder

`AGENTS.md` (skald's system map + live recipes) → this doc → `SETUP.md` §3–5
(daemon + browsers) → `docs/features/cache-economics.md` (if your agents
ever steer spoken dialogue, the cache pattern is your "only decisions
travel" applied to speech) → `experiments/lane-c-sim/` (the
prefetch/interrupt/ledger patterns, tested).
