#!/usr/bin/env bash
# build_ngc_inner.sh — runs INSIDE the Riva container (mounted at /scripts).
# Builds the NGC deployable T5TTS-Magpie component set into an RMIR.
#
# Attempt history (kept as documentation):
#   1. codec as 6th peer source with nemo2riva:{format:ONNX} -> codec conversion
#      path can't introspect codec .nemo metadata (KeyError obj_cls).
#   2. codec attached to BLS conversion via nemo2riva:{audio_codec:...} (docs
#      pattern) -> pipeline assembles fully, but base.yaml packing demands
#      model.ckpt (pytorch weights) which the deployable doesn't ship.
#   3. THIS attempt: --config-name=streaming per the NVIDIA NIM custom-
#      deployment example for the Magpie family (all-ONNX packing + the
#      documented streaming params).
set -euo pipefail

echo "--> riva-build via compat driver (drops unused pytorch ckpt from ONNX-only packing)"

python3 /work/riva_build_compat_driver.py \
  --config-path=pkg://servicemaker.configs.tts --config-name=streaming \
  output_path=/work/magpie_t5tts_ngc.rmir \
  'source_path=[{path: /dl/magpie_multilingual_bls.riva, nemo2riva: {audio_codec: /models/low-frame-rate-speech-codec-22khz.nemo}}, /dl/magpie_multilingual_encoder.riva, /dl/magpie_multilingual_decoder.riva, /dl/magpie_multilingual_decoder_kv.riva, /dl/magpie_multilingual_speaker_encoder.riva]' \
  sample_rate=22050 \
  phone_set=ipa \
  voice_name=Magpie-Multilingual \
  language_code="'en-US,es-US,fr-FR'" \
  magpie_tts.chunk_ms=90 \
  magpie_tts.fade_ms=5 \
  magpie_tts.history_future=1 \
  magpie_tts.history_len=6 \
  magpie_tts.future_len=1 \
  magpie_tts.max_context_len=111 \
  magpie_tts.attention_prior_window_length_left=1 \
  magpie_tts.attention_prior_window_length_right=2 \
  platform_aarch=true \
  force=true

ls -la /work/magpie_t5tts_ngc.rmir
echo "NGC-BUILD-OK"
