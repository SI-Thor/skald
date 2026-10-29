# skald

> *A skald was the bard of the Norse world — the professional who recited the news,
> the laws, and the sagas aloud to an audience. This project is a skald for the Thor:
> a machine that reads to you.*

Skald is a personal read-aloud system built for a first-class listener (its owner),
running on an **NVIDIA Jetson AGX Thor** (Blackwell GPU, 128 GB unified memory, ARM64).

It replaces the "Read Aloud" Firefox extension with something better suited to one
user's habits, and grows into a shared voice service the whole machine (and LAN) can use.

## Adapting skald for other projects

**[docs/adapting/last-mile.md](docs/adapting/last-mile.md)** — builder's
guide for using skald's voice stack from the last-mile distributed-sim
project (what's reusable today, what to add, topology advice, honest gaps).

## Companion: Thor-side technologies

[thor-tech-for-last-mile.md](thor-tech-for-last-mile.md) — eight Thor-hosted
technologies that offload or enhance the ProArt's job (decision bus with
replay, ARM64-verified LLM + embedding NIMs, utterance pre-render bank with
word timing, streaming audio, ASR score input, PTP score clock, mirror-sim
tripwire), with pull-verified availability and a suggested order.

## Agents start here

**[AGENTS.md](AGENTS.md)** — onboarding for AI agents (and the fastest human
summary): what's live vs simulated vs parked, how to call the running
system, repo conventions (tiles, verified claims), and skill recipes.

## Agents start here

**[ONBOARDING.md](ONBOARDING.md)** is the paste-into-a-fresh-session prompt
for the next agent. **[AGENTS.md](AGENTS.md)** is the standing onboarding
(how to call the live system, what's running vs simulated, conventions).

## Why this repo is public

SI-Thor is an open-source organization. Our business is **technicians installing
hardware with adaptable software, customized for each client** — which is why every
road is documented, including why we took the paths we did: another use case might be
better optimized for one of the ideas that wasn't best for this install. These tiles
of knowledge are seeds for exploration later. See ADR-0007 for the methodology.

## What it is

```
                    ┌───────── Voice & Content Daemon (Thor) ─────────┐
 Firefox extension ─▶ LANE A · LIVE READING (first-class)             │
 other apps / LAN ──▶   /v1/audio/speech — sentence streaming,        │
 scripts / curl ────▶   prefetch ahead, sub-second start              │
                      │   engines: fast tier ↔ expressive tier,       │
                      │   swappable mid-playback                      │
                      │ LANE B · PODCAST FACTORY (batch jobs)         │
                      │   /v1/jobs — extract → chunked LLM dialogue   │
                      │   script → render host voices → stitch MP3    │
                      │ shared: voice registry & clones · text        │
                      │   pipeline · OpenAI-compatible API · compose  │
                      └───────────────────────────────────────────────┘
```

- **Lane A — live reading**: the everyday experience. Click, hear the first sentence in
  under a second, drag a speed slider mid-sentence, jump by sentence, swap voices without
  stopping. No LLM in the hot path.
- **Lane B — podcast factory**: batch jobs that turn articles/PDFs into two-host podcast
  MP3s. Latency is acceptable because you asked for a file, not a conversation.
- **One daemon, many clients**: anything that can make an HTTP request can ask the Thor
  to speak. The extension is just the primary client.


## Feature documentation (what's novel here)

See **[docs/features/index.md](docs/features/index.md)** — supplemental docs
for each novel feature: the produced live show (producer-in-the-loop with a
said-aloud memory), hot-prefix steering economics, characters as versioned
files with voice-slot indirection, the ASR round-trip acceptance gate, and
power-context benchmarking.

## Operations runbooks

- Voice daemon service: `daemon/systemd/`
- Riva deployment toolkit + repair chain: `daemon/riva-deploy/` (+ `repair/`)
- Magpie TTS NIM on Thor (experiment): `daemon/riva-nim/`
- Extension browser acceptance: `extension/SMOKETEST.md`
- Benchmark harness: `benchmark/README.md`

## Repository map

| Path | Purpose |
|---|---|
| `extension/` | Firefox extension (the control surface + page reading) |
| `daemon/` | The voice & content daemon served from the Thor |
| `benchmark/` | On-device TTS engine benchmarks that drive engine selection |
| `docs/architecture.md` | The two-lane architecture in detail |
| `docs/decisions/` | **ADRs** — every significant decision, its context, and why |
| `docs/research/` | Dated research notes — what we verified and when |
| `docs/ideas/` | The idea vault — including ideas we chose *not* to pursue (yet) |
| `docs/ROADMAP.md` | Phases, current status, open questions |

## How we work in this repo (for future maintainers — human or agent)

The owner's explicit instruction, worth preserving verbatim in spirit:

> push often with good commits. The history of your thoughts on why you are doing what
> you are doing will be preserved in the repo for other agents later maintaining this to
> understand what we did and why at the time. Even when you change your work as you go,
> the history is good. Document ideas for the next step too — even if we don't take an
> idea, we can see it later and it might be useful in another context.

Conventions that follow from it:

1. **Decisions get an ADR** (`docs/decisions/NNNN-*.md`) when they're made, not later.
   ADRs are never deleted — superseded ones get a "Superseded by" header.
2. **Research notes are dated** and cite links. Facts about the fast-moving AI tooling
   world (NIM availability, model generations) are true *as of their date*.
3. **Ideas are never thrown away.** Anything considered and not taken goes to
   `docs/ideas/` with status and context, so a future context can reuse it.
4. **Commit early and often**, with messages that explain the *why*, not just the what.
   Small, honest, incremental history beats tidy squashed history here.
5. Course changes are normal: prefer a new commit that reverses an old one (with reasons)
   over rewriting history.

## Environment facts (as of 2026-10-28)

- Machine: Jetson AGX Thor dev kit, JetPack 7.x, Ubuntu ARM64. Firefox 158 (release, snap)
  runs on this machine; the extension signs via free AMO self-distribution (`web-ext sign`)
  because release Firefox rejects unsigned extensions.
- NVIDIA Broadcast: Windows-only and mic-side — not part of this project (see research notes).
- NVIDIA NIM containers: x86_64 today; ARM64/Jetson support maturing. Our API is
  NIM-compatible (OpenAI-style) so NIMs can drop in later without client changes.

## License

Code: MIT (see `LICENSE`). Model weights pulled in by the daemon (e.g. fish-speech,
Chatterbox, Kokoro voices) carry their own licenses — check `docs/research/` before
redistributing anything model-derived. This is a personal-use system.
