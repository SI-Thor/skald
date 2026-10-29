# Magpie TTS NIM on Thor — experiment runbook (ADR-0008 Path B)

Status: **in flight** — container pulled (50.1 GB, arm64 manifest), launch
contract verified, crash-loop root-caused and fixed; engine build cycling at
last check. This doc is the reproduction + diagnosis guide.

## Launch (ports chosen to avoid our live Riva on 50051/50000)

```bash
export NGC_API_KEY=<key>   # from ~/.docker/config.json nvcr.io auth or ngc config

docker volume create skald_nim_ws       # RMIR cache  (persists downloads)
docker volume create skald_nim_models   # /data/models (persists TRT builds)

docker run -d --name skald-nim --runtime nvidia --gpus all --shm-size=8gb \
  -e NGC_API_KEY -e NIM_HTTP_API_PORT=9000 -e NIM_GRPC_API_PORT=50051 \
  -p 19000:9000 -p 15051:50051 \
  -v skald_nim_ws:/opt/nim/workspace \
  -v skald_nim_models:/data/models \
  --mount type=bind,src=/home/caseydigennaro/src/skald-riva/model-repo-official/magpie_tts-Magpie-Multilingual/1/audio_codec.nemo,dst=/data/models/magpie_tts-Magpie-Multilingual/1/audio_codec.nemo \
  --restart unless-stopped \
  nvcr.io/nim/nvidia/magpie-tts-multilingual:latest

curl localhost:19000/v1/health/ready   # {"status":"ready"} when up
```

## The three lessons (each cost a crash loop)

1. **State must outlive the container.** Unmounted `/opt/nim/workspace` +
   `/data/models` = RMIR re-download + full TRT-LLM rebuild every restart
   (~10 min GPU at 96% each pass). Named volumes fix it.
2. **Volume ownership**: the container runs as `nvs:1000`; root-owned named
   volumes cause `ManifestDownloadError: Permission denied`. Fix:
   `docker run --rm -v skald_nim_ws:/ws busybox chown -R 1000:1000 /ws`.
3. **The 26.10.1 RMIR deploys without `audio_codec.nemo`** — the Triton load
   then fails (`FileNotFoundError` in `magpie_unified_model.py:677`) and the
   supervisor exits 0 → restart loop. The tegra-thor prebuilt's identical
   codec file (21 Hz family) transplanted via a **single-file bind mount**
   is undeletable by the deploy's `rm -rf` (busy), so the load always finds
   it. (`docker cp` also works but is wiped by deploy's dir-clean; the bind
   mount is not.)

## When it's ready

1. `curl localhost:19000/v1/health/ready` → ready
2. List voices + synth via gRPC :15051 (riva client) or HTTP :19000
   (OpenAPI at `/openapi.json`), then **Whisper round-trip** (the gate).
3. Register as daemon engine #2: `RIVA_HTTP_URI`-style env or the engine
   registry — clients see a new engine name, nothing else changes (ADR-0002).

## Cloning note

Voice cloning is the SEPARATE `magpie-tts-zeroshot` NIM, gated ("Apply for
access" at developer.nvidia.com/riva-tts-zeroshot-models): `audio_prompt`
3–10 s reference audio, `prompt_quality` 1–40. The multilingual NIM does not
clone.
