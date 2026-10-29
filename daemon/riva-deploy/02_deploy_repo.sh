#!/usr/bin/env bash
# =============================================================================
# 02_deploy_repo.sh - Deploy the built .rmir into the Triton model repository
#                     that the Riva server (start-riva) serves from /data/models.
#
# Verified usage of riva-deploy (from the image):
#   riva-deploy [-h] [--config_only] [-f] [-g GPUS_TO_USE] [--use_ampereplus]
#               [-v] [--override_config ...] rmir_model [rmir_model ...] target
#   ("Optimize and write Riva pipeline to model repository for deployment.")
#
# The host model-repo dir is mounted at /data/models INSIDE the container on
# purpose: start-riva passes --model-repository /data/models to Triton, and
# the Riva docs warn that mounting elsewhere requires manual path fixing in
# config.pbtxt afterwards. -f forces overwrite of an existing deployment.
#
# Usage: ./02_deploy_repo.sh [rmir-file]   (default: work/magpie_tts_multilingual.rmir)
# =============================================================================
set -euo pipefail

RIVA_IMAGE="${RIVA_IMAGE:-nvcr.io/nvidia/riva/riva-speech:2.26.0-l4t-aarch64}"
BASE_DIR="${BASE_DIR:-/home/caseydigennaro/src/skald-riva}"
WORK_DIR="${WORK_DIR:-$BASE_DIR/work}"
MODEL_REPO_DIR="${MODEL_REPO_DIR:-$BASE_DIR/model-repo}"
RMIR="${1:-${RMIR:-$WORK_DIR/magpie_tts_multilingual.rmir}}"

DOCKER="${DOCKER:-docker}"
if ! "$DOCKER" ps >/dev/null 2>&1; then DOCKER="sudo -n docker"; fi

echo "==> [1/3] Preflight"
[[ -f "$RMIR" ]] || { echo "ERROR: RMIR not found: $RMIR (run 01_build_rmir.sh first)"; exit 1; }
mkdir -p "$MODEL_REPO_DIR"
echo "    image     : $RIVA_IMAGE"
echo "    rmir      : $RMIR"
echo "    model repo: $MODEL_REPO_DIR (mounted at /data/models in container)"

# Container-side paths (exported so docker -e passes it through)
export C_RMIR="/work/$(basename "$RMIR")"

echo "==> [2/3] riva-deploy (force) into /data/models"
"$DOCKER" run --rm --runtime nvidia --gpus all \
  -v "$WORK_DIR":/work \
  -v "$MODEL_REPO_DIR":/data/models \
  -e C_RMIR \
  --entrypoint /bin/bash \
  "$RIVA_IMAGE" -c '
    set -euo pipefail
    riva-deploy -f "$C_RMIR" /data/models
  '

echo "==> [3/3] Verify deployed model repository"
echo "    contents of $MODEL_REPO_DIR:"
ls -lh "$MODEL_REPO_DIR"
echo "OK: deployed. Next: ./03_start_server.sh"
