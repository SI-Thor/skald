#!/usr/bin/env python3
"""riva-build compat driver: drop the unused pytorch ckpt from magpie_tts packing.

The NGC deployable T5TTS-Magpie component set ships all weights as ONNX
(encoder/decoder/decoder-KV/speaker-encoder); the pipeline itself declares
ONNX as its only valid runtime (get_valid_runtimes -> [Runtimes.ONNX]).
But get_binaries() unconditionally demands ('T5TTS_Model', 'model.ckpt'),
which this all-ONNX artifact generation does not carry -> RMIR write fails.

The shim wraps every get_binaries() in servicemaker.pipelines.tts and removes
the 'ckpt' entry from bin_map['magpie_tts'] — on an ONNX-only pipeline the
pytorch checkpoint is never consulted (Triton loads the ONNX graphs; TensorRT
engines are built from them).

Usage: same argv as the riva-build console script.
"""
import logging
import sys

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("riva_build_compat")

import servicemaker.pipelines.tts as _tts  # noqa: E402

for _name in list(vars(_tts)):
    _cls = getattr(_tts, _name)
    if isinstance(_cls, type) and callable(getattr(_cls, "get_binaries", None)):
        _orig = _cls.get_binaries

        def _patched(self, *a, _orig=_orig, **k):
            bm = _orig(self, *a, **k)
            if isinstance(bm, dict) and isinstance(bm.get("magpie_tts"), dict) \
                    and "ckpt" in bm["magpie_tts"]:
                log.info("shim: dropping unused pytorch ckpt from magpie_tts binaries (ONNX-only runtime)")
                bm["magpie_tts"].pop("ckpt")
            return bm

        _cls.get_binaries = _patched

# Shim 2: the RMIR writer requires pipeline_config[id]['use_torchscript'], which
# the newer-generation component configs omit. Default it to False (we never
# deploy TorchScript; ONNX/TensorRT only).
from servicemaker.rmir import rmir as _rmir_mod  # noqa: E402

_orig_write = _rmir_mod.RMIR.write


def _patched_write(self, *a, **k):
    for _attr in ("pipeline_config", "_pipeline_config"):
        pc = getattr(self, _attr, None)
        if isinstance(pc, dict):
            for _mid, _cfg in pc.items():
                if isinstance(_cfg, dict) and "use_torchscript" not in _cfg:
                    log.info("shim: defaulting use_torchscript=False for %s", _mid)
                    _cfg["use_torchscript"] = False
    return _orig_write(self, *a, **k)


_rmir_mod.RMIR.write = _patched_write

from servicemaker.cli import build  # noqa: E402

sys.exit(build())
