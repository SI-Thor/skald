#!/usr/bin/env python3
"""nemo2riva compat driver: run conversion with a version-skew shim.

The HF magpie_tts_multilingual_357m checkpoint (built with the NVIDIA-NeMo
Speech repo, Jul 2026) passes constructor kwargs that the riva-speech
2.26.0 image's nemo-toolkit 2.8.0rc0 does not know — e.g.
IPATokenizer(locale_specific_punct=False) for the pt-BR tokenizer. The stock
restore fails with InstantiationException -> "abstract class ModelPT"
(red herring; see skald research note 2026-10-28d).

This shim wraps every class defined in the TTS tokenizer modules so their
__init__ drops kwargs that are not in the original signature, logging each
drop. Tokenizer-feature flags defaulting to False in the new NeMo are safe to
drop against the old NeMo (the old class predates the feature = same
behavior). The main model class is deliberately NOT shimmed.

Usage: same argv as the nemo2riva console script.
"""
import inspect
import logging
import sys

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("nemo2riva_compat")


def filter_kwargs_shim(cls):
    orig = cls.__init__
    try:
        params = inspect.signature(orig).parameters
    except (ValueError, TypeError):
        return cls
    if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return cls  # already accepts **kwargs
    accepted = set(params)

    def __init__(self, *a, **kw):
        for k in [k for k in kw if k not in accepted]:
            log.info("shim: %s.__init__ dropping unknown kwarg %s=%r", cls.__name__, k, kw[k])
        kw = {k: v for k, v in kw.items() if k in accepted}
        orig(self, *a, **kw)

    cls.__init__ = __init__
    return cls


import nemo.collections.common.tokenizers.text_to_speech.tts_tokenizers as _tt  # noqa: E402

for _name in list(vars(_tt)):
    _obj = getattr(_tt, _name)
    if isinstance(_obj, type) and getattr(_obj, "__module__", "") == _tt.__name__:
        filter_kwargs_shim(_obj)

# ---------------------------------------------------------------------------
# Shim 2: make the model follow the checkpoint's embedding sizes.
#
# The checkpoint's text embedding has 3359 rows; the 2.8.0rc0 constructor
# builds 3357 (the dropped locale-punct feature shrank the tokenizer vocab by
# exactly 2 tokens). The checkpoint is ground truth (it was trained), so pad
# any nn.Embedding whose incoming state_dict weight has MORE rows before the
# original load_state_dict runs. The 2 extra rows are only reachable via the
# new tokenizer, so they are inert under the old one.
# ---------------------------------------------------------------------------
import torch  # noqa: E402
import torch.nn as nn  # noqa: E402
from nemo.collections.tts.models.magpietts import MagpieTTSModel  # noqa: E402

_orig_magpie_load = MagpieTTSModel.load_state_dict


def _pad_embeddings_to_checkpoint(self, state_dict, strict=True):
    with torch.no_grad():
        for name, module in self.named_modules():
            if not isinstance(module, nn.Embedding):
                continue
            key = f"{name}.weight" if name else "weight"
            if key not in state_dict:
                continue
            ckpt_w = state_dict[key]
            cur_w = module.weight
            if ckpt_w.dim() == 2 and cur_w.dim() == 2 and ckpt_w.shape[1] == cur_w.shape[1] \
                    and ckpt_w.shape[0] > cur_w.shape[0]:
                log.info("shim: padding %s embedding %s -> %s rows (checkpoint is ground truth)",
                         key, tuple(cur_w.shape), tuple(ckpt_w.shape))
                new_w = torch.empty_like(ckpt_w)
                new_w[: cur_w.shape[0]] = cur_w
                new_w[cur_w.shape[0]:] = ckpt_w[cur_w.shape[0]:]
                module.weight = nn.Parameter(new_w)
    return _orig_magpie_load(self, state_dict, strict=strict)


MagpieTTSModel.load_state_dict = _pad_embeddings_to_checkpoint

from nemo2riva.cli import nemo2riva  # noqa: E402

sys.exit(nemo2riva())
