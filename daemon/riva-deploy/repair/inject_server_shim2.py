"""Second server-side shim: pad model embeddings to the checkpoint's sizes.

Same fix as the conversion driver: the checkpoint's text embedding has 3359
rows; the image's older NeMo constructor builds 3357 (the dropped
locale-punct tokens). Checkpoint is ground truth — pad any nn.Embedding whose
incoming state_dict weight has more rows before the original load_state_dict.
Injected into magpie_unified_model.py so it ships with the model repo.
"""

PATH = "/repo/magpie_tts-Magpie-Opensource/1/magpie_unified_model.py"
MARKER = "# SKALD-EMBED-PAD-SHIM"

SHIM = '''
# SKALD-EMBED-PAD-SHIM: model follows checkpoint (ground truth) on embedding
# sizes; the 2 extra rows are inert under this toolkit's tokenizer.
import logging as _ep_log

_ep_log = _logging.getLogger("skald_embed_pad")


def _pad_embeddings_to_checkpoint(_self, _state_dict, strict=True):
    import torch as _torch
    import torch.nn as _nn
    with _torch.no_grad():
        for _name, _module in _self.named_modules():
            if not isinstance(_module, _nn.Embedding):
                continue
            _key = f"{_name}.weight" if _name else "weight"
            if _key not in _state_dict:
                continue
            _ckpt_w = _state_dict[_key]
            _cur_w = _module.weight
            if _ckpt_w.dim() == 2 and _cur_w.dim() == 2 and _ckpt_w.shape[1] == _cur_w.shape[1] \\
                    and _ckpt_w.shape[0] > _cur_w.shape[0]:
                _ep_log.info("shim: padding %s %s -> %s", _key, tuple(_cur_w.shape), tuple(_ckpt_w.shape))
                _new_w = _torch.empty_like(_ckpt_w)
                _new_w[: _cur_w.shape[0]] = _cur_w
                _new_w[_cur_w.shape[0]:] = _ckpt_w[_cur_w.shape[0]:]
                _module.weight = _nn.Parameter(_new_w)
    return _orig_magpie_load(_self, _state_dict, strict=strict)


from nemo.collections.tts.models.magpietts import MagpieTTSModel as _MagpieTTS  # noqa: E402

_orig_magpie_load = MagpieTTSModel.load_state_dict
MagpieTTSModel.load_state_dict = _pad_embeddings_to_checkpoint
# END SKALD-EMBED-PAD-SHIM
'''

with open(PATH) as f:
    src = f.read()

if MARKER in src:
    print("embed-pad shim already present")
else:
    src += "\n" + SHIM + "\n"
    with open(PATH, "w") as f:
        f.write(src)
    print("embed-pad shim appended")
print("INJECT2-DONE")
