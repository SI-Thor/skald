#!/usr/bin/env bash
# =============================================================================
# 01_build_rmir.sh - Build the Riva RMIR for MagpieTTS Multilingual 357M
#                    (with the low-frame-rate speech codec wired in) on
#                    Jetson Thor (aarch64 / Blackwell).
#
#   .nemo (TTS) + codec .nemo  -->  work/magpie_tts_multilingual.rmir
#
# Two modes (BUILD_MODE env var):
#   inline  (default, recommended): single riva-build hydra invocation; the
#     .nemo -> .riva conversion happens inline via the source_path entry's
#     `nemo2riva:` options dict, where `audio_codec:` attaches the codec.
#     This mirrors the official NIM custom-deployment docs example for the
#     Magpie families ("Inline .nemo conversion in riva-build ... the path
#     used by the Magpie TTS model families"), which builds exactly this
#     multilingual 357M checkpoint with voice_name=Magpie-Opensource.
#   twostep: explicit `nemo2riva --audio-codec <codec.nemo> --out model.riva
#     model.nemo`, then riva-build on the .riva. Fallback in case the inline
#     audio_codec option key is rejected (that key name is RECONSTRUCTED,
#     not verified against the image - see NOTES.md).
#
# Overrides (defaults per base.yaml + NVIDIA docs example):
#   multilingual=true, platform_aarch=true (Jetson), sample_rate=22050,
#   n_timesteps=32, language_code=<12 locales>, voice_name=Magpie-Opensource.
#   transcript/context decoder layer overrides are already the base.yaml
#   defaults ("3,4,5,6,7,8" / "0,1,2,9,10,11"); set TRANSCRIPT_DECODER_LAYERS /
#   CONTEXT_DECODER_LAYERS env vars to change them.
#
# Usage:
#   ./01_build_rmir.sh
#   BUILD_MODE=twostep ./01_build_rmir.sh
#   VOICE_NAME=X N_TIMESTEPS=16 ./01_build_rmir.sh
#
# NOTE: if `riva-build` rejects --config-path, swap in the verified
# module-invocation form (from base.yaml's own usage header):
#   cd /usr/local/lib/python3.12/dist-packages/servicemaker && \
#   python3 -m servicemaker.cli.build_hydra --config-path=configs/tts \
#     --config-name=base <same overrides>
# =============================================================================
set -euo pipefail

# ----------------------------- parameters -----------------------------------
RIVA_IMAGE="${RIVA_IMAGE:-nvcr.io/nvidia/riva/riva-speech:2.26.0-l4t-aarch64}"
BASE_DIR="${BASE_DIR:-/home/caseydigennaro/src/skald-riva}"
MODELS_DIR="${MODELS_DIR:-$BASE_DIR/models}"
WORK_DIR="${WORK_DIR:-$BASE_DIR/work}"

MODEL_NEMO="${MODEL_NEMO:-$MODELS_DIR/magpie_tts_multilingual_357m.nemo}"
CODEC_NEMO="${CODEC_NEMO:-$MODELS_DIR/low-frame-rate-speech-codec-22khz.nemo}"
OUT_RMIR_NAME="${OUT_RMIR_NAME:-magpie_tts_multilingual.rmir}"

BUILD_MODE="${BUILD_MODE:-inline}"            # inline | twostep
VOICE_NAME="${VOICE_NAME:-Magpie-Opensource}" # NVIDIA docs example for this checkpoint
LANGUAGE_CODES="${LANGUAGE_CODES:-en-US,es-US,fr-FR,de-DE,zh-CN,vi-VN,it-IT,hi-IN,ja-JP,ko-KR,ar-XA,pt-BR}"
SAMPLE_RATE="${SAMPLE_RATE:-22050}"
N_TIMESTEPS="${N_TIMESTEPS:-32}"
MULTILINGUAL="${MULTILINGUAL:-true}"
PLATFORM_AARCH="${PLATFORM_AARCH:-true}"      # Jetson Thor is aarch64

DOCKER="${DOCKER:-docker}"
if ! "$DOCKER" ps >/dev/null 2>&1; then DOCKER="sudo -n docker"; fi

# ----------------------------- preflight ------------------------------------
echo "==> [1/4] Preflight"
[[ -f "$MODEL_NEMO" ]] || { echo "ERROR: model not found: $MODEL_NEMO"; exit 1; }
[[ -f "$CODEC_NEMO" ]] || { echo "ERROR: codec not found: $CODEC_NEMO"; exit 1; }
mkdir -p "$WORK_DIR"
echo "    image     : $RIVA_IMAGE"
echo "    mode      : $BUILD_MODE"
echo "    model     : $MODEL_NEMO"
echo "    codec     : $CODEC_NEMO"
echo "    voice     : $VOICE_NAME"
echo "    languages : $LANGUAGE_CODES"
echo "    aarch=$PLATFORM_AARCH  timesteps=$N_TIMESTEPS  sample_rate=$SAMPLE_RATE  multilingual=$MULTILINGUAL"

# Container-side paths (host dirs mounted at same-name container paths)
C_MODEL="/models/$(basename "$MODEL_NEMO")"
C_CODEC="/models/$(basename "$CODEC_NEMO")"
C_RMIR="/work/$OUT_RMIR_NAME"
export C_MODEL C_CODEC C_RMIR VOICE_NAME LANGUAGE_CODES SAMPLE_RATE N_TIMESTEPS MULTILINGUAL PLATFORM_AARCH
LAYER_OVERRIDES=()
[[ "${TRANSCRIPT_DECODER_LAYERS:-}" ]] && LAYER_OVERRIDES+=("transcript_decoder_layers=$TRANSCRIPT_DECODER_LAYERS")
[[ "${CONTEXT_DECODER_LAYERS:-}" ]]    && LAYER_OVERRIDES+=("context_decoder_layers=$CONTEXT_DECODER_LAYERS")
export LAYER_OVERRIDES_STR="${LAYER_OVERRIDES[*]:-}"

run_build_container() {  # $1 = inline | twostep ; vars passed via -e
  # The container-side logic lives in build_inner.sh (mounted at /scripts) —
  # NOT a nested -c string, whose quoting layers ate Hydra's required
  # literal quotes around language_code (2026-10-28 build failure).
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  "$DOCKER" run --rm --runtime nvidia --gpus all \
    -v "$MODELS_DIR":/models \
    -v "$WORK_DIR":/work \
    -v "$script_dir":/scripts:ro \
    -e MODE="$1" \
    -e C_MODEL -e C_CODEC -e C_RMIR -e VOICE_NAME -e LANGUAGE_CODES \
    -e SAMPLE_RATE -e N_TIMESTEPS -e MULTILINGUAL -e PLATFORM_AARCH -e LAYER_OVERRIDES_STR \
    -e HYDRA_FULL_ERROR=1 \
    --entrypoint /bin/bash \
    "$RIVA_IMAGE" /scripts/build_inner.sh
}

case "$BUILD_MODE" in
  inline)
    echo "==> [2/4] riva-build: inline .nemo conversion (audio_codec wired in source_path)"
    echo "==> [3/4] (no separate nemo2riva step in inline mode)"
    ;;
  twostep)
    echo "==> [2/4] nemo2riva: .nemo -> .riva with --audio-codec"
    echo "==> [3/4] riva-build: .riva -> .rmir"
    ;;
  *) echo "ERROR: BUILD_MODE must be 'inline' or 'twostep' (got: $BUILD_MODE)"; exit 1 ;;
esac

run_build_container "$BUILD_MODE"

echo "==> [4/4] Verify output"
if [[ ! -f "$WORK_DIR/$OUT_RMIR_NAME" ]]; then
  echo "ERROR: expected RMIR not found: $WORK_DIR/$OUT_RMIR_NAME"
  echo "       (if the container log shows a permission error writing to"
  echo "        /work, check ownership of $WORK_DIR; riva runs as root in-container)"
  exit 1
fi
ls -lh "$WORK_DIR/$OUT_RMIR_NAME"
echo "OK: built $WORK_DIR/$OUT_RMIR_NAME - next: ./02_deploy_repo.sh"
