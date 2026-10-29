# LAN services — deployed infrastructure for skald + last-mile

Decision-bus, vector canon, and NIM services on the Thor (deployed &
verified 2026-10-29). All boot-persistent (`--restart unless-stopped`),
all stateful data in named volumes. Companion doc:
`docs/adapting/thor-tech-for-last-mile.md`.

## Deployed & verified

| Service | Container | Port | Purpose | Verified |
|---|---|---|---|---|
| **NATS JetStream** | `skald-nats` (nats:2-alpine) | 4222 client / 8222 monitor | decision bus: `DECISIONS` stream on `score.>` — replay = never-wait + late joiners | publish→replay demo: 5/5 replayed in order |
| **Qdrant** | `skald-qdrant` | 6333 HTTP / 6334 gRPC | vector canon store (collection `canon`, 1024-dim) | upsert + semantic search demo |
| **Embedding NIM** | `skald-embed` (nv-embedqa-e5-v5) | 19001 | 1024-dim GPU embeddings (`/v1/embeddings`, OpenAI-shaped) | READY + RAG demo: query → correct canon hit |
| **LLM NIM** | `skald-llm` (llama-3.1-nemotron-nano-8b-v1) | 19002 | local reflex-tier LLM (`/v1/chat/completions`) | pulled 24.9 GB; downloads model on first start |
| skald-daemon | systemd `skald-daemon` | 8000 | `/v1/audio/speech` + **`/v1/audio/speech/stream`** (raw PCM chunks — play while synthesizing) | smoke + stream verified |

## Runbooks

### Decision bus (NATS)

```python
import nats
nc = await nats.connect("thor-ip:4222"); js = nc.jetstream()
await js.publish("score.turn.1", b'{"seq":1,"agent":"mia","decision":"move"}')
sub = await js.subscribe("score.>", ordered_consumer=True)   # replay consumer
```

Stream `DECISIONS` persists across restarts (volume `skald_nats`).
`nats-py` is installed in `daemon/server/.venv`.

### Canon RAG (embed → Qdrant)

```bash
curl localhost:19001/v1/embeddings -H 'Content-Type: application/json' \
  -d '{"input":["text..."],"model":"nvidia/nv-embedqa-e5-v5","input_type":"query"}'
# PUT  :6333/collections/canon/points (1024-dim vectors + payload)
# POST :6333/collections/canon/points/search
```

### Utterance bank (pre-render ahead)

```bash
python3 daemon/server/utterance_bank.py --text "We move at dawn." --voice mia
# repeat: HIT in ~60 ms — key = sha256(text, voice, rate); atomic writes
python3 daemon/server/utterance_bank.py --check --text "..."   # lookup key only
python3 daemon/server/utterance_bank.py --file cues.jsonl      # batch pre-render
```

Bank root: `~/src/skald-riva/utterance-bank` (`SKALD_BANK` to move).

### Streaming speech

```bash
curl -sN localhost:8000/v1/audio/speech/stream \
  -H 'Content-Type: application/json' \
  -d '{"input":"...","voice":"mia"}'   # raw PCM 22.05 kHz mono chunks (no WAV header)
```

## Volumes

`skald_nats` (stream data) · `skald_qdrant` (vectors) · `skald_embed_ws` /
`skald_llm_ws` (NIM caches; embed ready ~2 min after start, LLM downloads on
first start) · bank root lives outside volumes (host dir, add your own
backup).

## GPU sharing note

Riva (TRT-LLM Magpie) + embed NIM + LLM NIM share the Blackwell. Riva stays
responsive; NIM first-loads and LLM inference will contend during bursts —
if the live-reading TTFA ever suffers, pin NIMs with
`NVIDIA_VISIBLE_DEVICES`/MIG or stagger them (tile, not yet needed at these
model sizes).
