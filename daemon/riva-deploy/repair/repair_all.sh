#!/usr/bin/env bash
# repair_all.sh — full repair chain against a fresh HF-path deployment.
#
# Preconditions (see ../README.md):
#   - 01_build_rmir.sh ran with the compat driver (or model.riva exists)
#   - 02_deploy_repo.sh produced model-repo/
#   - work/357m-assets/ holds the checkpoint's dict/heteronym/speaker files
#     (extracted from the .nemo tar: `tar xf models/magpie_tts_multilingual_357m.nemo -C work/357m-assets`)
#
# Run from the skald-riva base dir (this script binds the mounts itself):
set -euo pipefail

BASE_DIR="${BASE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
IMAGE="${RIVA_IMAGE:-nvcr.io/nvidia/riva/riva-speech:2.26.0-l4t-aarch64}"
REPO="$BASE_DIR/model-repo"
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Stage the de heteronym too (its tar member carries a ./ prefix and the
# name ends in singular ".heteronym" — easy to miss with naive greps).
mkdir -p "$BASE_DIR/work/357m-assets"
tar -C "$BASE_DIR/work/357m-assets" -xf "$BASE_DIR/models/magpie_tts_multilingual_357m.nemo" \
    --wildcards "./*.dict" "./*.txt" "./*heteronym*" "./.*speakers.json" 2>/dev/null || \
tar -C "$BASE_DIR/work/357m-assets" -xf "$BASE_DIR/models/magpie_tts_multilingual_357m.nemo"

sudo docker run --rm --runtime nvidia --gpus all \
  -v "$REPO":/repo -v "$BASE_DIR/work":/work -v "$SCRIPTS":/scripts:ro \
  --entrypoint /bin/bash "$IMAGE" -c '
    set -euo pipefail
    python3 /scripts/patch_model_repo.py       # assets + nemo: URIs + Speaker*.pt
    python3 /scripts/gen_mapping.py            # ground-truth per-language mapping.txt
    python3 /scripts/inject_server_shim.py     # kwarg filter (version skew)
    python3 /scripts/inject_server_shim2.py    # embedding pad-to-checkpoint
    python3 /scripts/repair_backend.py         # device align + mask rebuild + pbtxt params
    rm -rf /repo/magpie_tts-Magpie-Opensource/1/__pycache__
    echo REPAIR-ALL-DONE
  '

echo "Next: ./03_start_server.sh restart  (first load ~4 min), then ./04_probe.sh"
