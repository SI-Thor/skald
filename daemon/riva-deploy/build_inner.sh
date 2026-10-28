#!/usr/bin/env bash
# build_inner.sh - runs INSIDE the Riva container (mounted at /scripts).
# Kept as a standalone file (not a nested -c string) so quoting survives:
# Hydra needs language_code='a,b,c' with literal quotes; nested bash quoting
# ate them (see research note 2026-10-28d). Env vars are passed via docker -e.
set -euo pipefail

echo "--> inside container: servicemaker build (mode=${MODE:-inline})"

if [ "${MODE:-inline}" = "twostep" ]; then
  echo "--> step 1/2: nemo2riva (codec via --audio-codec)"
  nemo2riva --audio-codec "$C_CODEC" --out /work/model.riva "$C_MODEL"
  echo "--> step 2/2: riva-build (.riva -> .rmir)"
  SRC='source_path=[/work/model.riva]'
else
  echo "--> riva-build: inline .nemo conversion (audio_codec in source_path)"
  SRC="source_path=[{path: $C_MODEL, nemo2riva: {audio_codec: $C_CODEC}}]"
fi

# shellcheck disable=SC2086  # LAYER_OVERRIDES_STR intentionally word-splits
riva-build --config-path=pkg://servicemaker.configs.tts --config-name=base \
  output_path="$C_RMIR" \
  "$SRC" \
  multilingual="$MULTILINGUAL" \
  voice_name="$VOICE_NAME" \
  language_code="'$LANGUAGE_CODES'" \
  sample_rate="$SAMPLE_RATE" \
  n_timesteps="$N_TIMESTEPS" \
  platform_aarch="$PLATFORM_AARCH" \
  $LAYER_OVERRIDES_STR \
  force=true
