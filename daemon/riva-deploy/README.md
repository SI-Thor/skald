# Riva Magpie deployment toolkit (Jetson Thor)

Self-serve deployment of Riva TTS with the open **MagpieTTS Multilingual 357M**
checkpoint — no NGC browser login required. Full story, provenance labels
([VERIFIED-image] / [RECONSTRUCTED-docs] / [INFERRED]), and risk list:
see `NOTES.md` and `docs/research/2026-10-28d-riva-magpie-thor-deployment.md`.

## One-time model download (~2.1 GB total, HuggingFace, public)

```bash
mkdir -p ~/src/skald-riva/models && cd ~/src/skald-riva/models
curl -LO https://huggingface.co/nvidia/magpie_tts_multilingual_357m/resolve/main/magpie_tts_multilingual_357m.nemo
curl -LO https://huggingface.co/nvidia/low-frame-rate-speech-codec-22khz/resolve/main/low-frame-rate-speech-codec-22khz.nemo
```

## Deploy

```bash
./01_build_rmir.sh          # .nemo + codec -> RMIR (try BUILD_MODE=twostep if inline fails)
./02_deploy_repo.sh         # riva-deploy RMIR -> ../model-repo (served as /data/models)
./03_start_server.sh        # detached container 'skald-riva', --restart unless-stopped
./04_probe.sh               # list voices + timed syntheses -> ../audio/
```

Working dir layout (outside this repo; models are too big for git):
`~/src/skald-riva/{models,work,model-repo,audio}`. All scripts are
env-parameterized (`BASE_DIR`, `MODEL_NEMO`, `VOICE_NAME`, `BUILD_MODE`, …)
and default to that layout — copy the toolkit anywhere and set `BASE_DIR`.

Ports: Riva gRPC **50051**, Riva HTTP **50000**. Container command is
`start-riva` (not `riva_server` — that skips Triton; the false-start bug that
started this toolkit).
