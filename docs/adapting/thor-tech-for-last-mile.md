# Thor technologies that enhance last-mile's ProArt work

Companion to [last-mile.md](last-mile.md). Answer to: *"what technology could
work on the Thor and enhance what the ProArt is trying to do?"* Everything
here is either already running on this Thor or verified pullable (ARM64
manifests checked 2026-10-29). Order: highest leverage first.

> **Status 2026-10-29 (late):** #1 NATS **DEPLOYED+verified** (replay demo
> 5/5), #3 Qdrant+embedding NIM **DEPLOYED+verified** (RAG demo hit), #5
> streaming **SHIPPED** (`/v1/audio/speech/stream`) and #4 utterance bank
> **SHIPPED** (`daemon/server/utterance_bank.py`, 60 ms hits), #2 LLM NIM
> **PULLED+launching**, #7 PTP **PACKAGED** (hardware path needs an Ethernet
> cable — WiFi lacks PTP; `daemon/ptp/`). Runbooks: `daemon/lan-services/`.

## 1. The decision bus — NATS JetStream (or Redis Streams) on Thor

last-mile's "only decisions travel" needs a MIDI-stream transport. A small
container on the Thor gives you: pub/sub with **replay** (late joiners and
"never wait" fallbacks re-read the stream from any offset), persistence
(JetStream) so the Orin archive ingests the same stream it verifies, and
subject wildcards (per-agent score views are just subscriptions — your spec's
"per-agent score views" fall out of the transport). The ProArt publishes
decisions; everything else subscribes. ARM64 images: `nats:2-alpine` (~10 MB).
The Thor is the right host: it's always-on and already the agent home.
**Deployed**: `skald-nats` on :4222/:8222, JetStream on, `DECISIONS` stream
live (replay verified), volume `skald_nats`; runbook in `daemon/lan-services/`.

## 2. LLM NIM for System-1 thinking — **ARM64 confirmed**

`nvcr.io/nim/nvidia/llama-3.1-nemotron-nano-8b-v1:latest` publishes an
**arm64 manifest** (verified). That's TRT-LLM-speed local inference for
agent reflexes — the "late AI falls back to reflexes" tier, served on Thor.
Baseline alternative already installed: Ollama on :11434 (no models yet).
**PULLED**: 24.9 GB image; `skald-llm` launching on :19002 (model downloads
on first start). Sequencer on the ProArt stays authoritative; the Thor LLM
*proposes* decisions into the bus.

## 3. Canon RAG with a GPU embedding NIM — **ARM64 confirmed**

`nvcr.io/nim/nvidia/nv-embedqa-e5-v5:latest` publishes **arm64** (verified).
That fills last-mile's "vector DB canon" box: embeddings on the Blackwell
GPU + a Qdrant/Milvus ARM64 container next to it, all on the Thor.
**DEPLOYED+verified**: `skald-embed` :19001 (1024-dim, ready in ~2 min) +
`skald-qdrant` :6333 (collection `canon`) — semantic-search demo returned
the correct lore line for a paraphrased query. Agent
harnesses query canon over the LAN; the ProArt never spends its 6 GB on
retrieval. (Pair with the reranker NIMs — same catalog pattern, check each.)

## 4. Utterance pre-render bank + word timing (skald extension)

The literal "pre-rendering ahead of the player" for speech: a worker on the
Thor renders upcoming utterances (content-hash memoized: `hash(text, voice,
style)` — squads repeat phrasings; the bank makes repeats free), storing
WAV + **word-timing metadata**. The ProArt then never synthesizes — it plays
banked audio and aligns tone tracks against the timing file. Needs the skald
daemon additions flagged in [last-mile.md](last-mile.md) (timing surface,
style-as-parameter) — same work item, both projects benefit.
**SHIPPED**: `daemon/server/utterance_bank.py` — hash-memoized renders
(60 ms repeat hits), atomic writes, JSONL batch mode.

## 5. Streaming audio delivery — never wait for the WAV

Verified today: Riva's `/v1/audio/synthesize_online` emits raw PCM chunks.
**SHIPPED**: `POST /v1/audio/speech/stream` on the daemon — raw PCM chunks
(22.05 kHz mono). The ProArt can play speech *as it synthesizes* — the audio twin of "late pre-rendering
falls back to lower chunk quality": latency degrades, rhythm never does.

## 6. Riva ASR for human voice as a score input

The Riva image ships ASR backends (its HTTP surface already exposes
`/v1/audio/transcriptions`; models aren't loaded in the TTS-only config).
Loading an ASR model on the Thor turns "human input" on the ProArt into a
spoken-score modality: speak, Thor transcribes, sequencer converts to
decisions. Deployment via the same quickstart flow as TTS (add the ASR
service in config; first load is slow).

## 7. PTP time sync (LinuxPTP) — the score clock

Three machines playing one deterministic score need a shared clock better
than NTP. **Measured reality on this Thor**: WiFi (the current link) has no
timestamping support at all — ptp4l cannot run over it; but the four **MGBE
Ethernet ports have full hardware PTP** (PHC 1, hardware-raw-clock —
verified via ethtool). So: cable the ProArt to mgbe0 → sub-µs sync with the
ready-made `daemon/ptp/ptp4l-mgbe0.conf`; on WiFi, fall back to
systemd-timesyncd (~ms, fine for turn scheduling). Sample-accurate audio
alignment is application-layer (RTP/render clocks), not PTP's job.

## 8. Mirror-sim desync tripwire (free, uses what exists)

Every machine runs the same deterministic fixed-point sim — so have the Thor
mirror the authoritative ProArt sim and periodically diff **state hashes**.
A mismatch is your canary for any non-determinism sneaking into the
sequencer (floats, HashMap iteration order, time-based branches). Costs one
core; catches the class of bug that would otherwise surface as ghosts in the
render. The Orin does replay verification; the Thor adds *live* verification.

## Verified-not-viable / gated (so you don't burn evenings)

- `riva-asr` / `riva-nmt` NIMs: no public arm64 manifests found (use the
  Riva image's own ASR as in #6).
- Audio2Face / Maxine-style lipsync NIMs: x86-only today — ProArt-side or
  skip.
- NVIDIA Broadcast: Windows-only, mic-side (research note 2026-10-28).

## Suggested order

1 (bus) and 7 (PTP) first — everything else rides the transport and clock.
Then 3 (canon RAG, one container + one NIM), 2 (reflex LLM), and 4–5 (the
skald additions shared with Phase 1). 6 and 8 slot in when the human-input
and mirror-sim code exists on the ProArt side.
