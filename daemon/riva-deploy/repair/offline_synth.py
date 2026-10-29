"""Offline end-to-end Magpie synthesis test (bypasses the C++ preprocessor).

Loads the deployed model via the backend's own load_model (with our shims),
tokenizes with the PYTHON AggregatedTTSTokenizer (construction-order ids),
runs generate_long_form_speech, decodes codes via the model's codec, writes
WAV. If this is intelligible, the model+weights+codec are correct and the
server's C++ id-space is the bug. Defensive introspection throughout.
"""
import importlib.util
import inspect
import logging
import os
import sys
import wave

logging.basicConfig(level=logging.WARNING)

MDIR = "/repo/magpie_tts-Magpie-Opensource/1"
sys.path.insert(0, MDIR)

# stub triton_python_backend_utils (only exists inside Triton's backend runtime)
import types  # noqa: E402

_tpbu = types.ModuleType("triton_python_backend_utils")
_tpbu.__file__ = "/tpbu_stub.py"
_tpbu.__path__ = []  # noqa: B008


class _Placeholder:
    def __init__(self, *a, **k):
        pass


class _Response:
    def __init__(self, *a, **k):
        pass

    def send(self, *a, **k):
        pass


class TritonError(Exception):
    pass


_tpbu.InferenceResponse = _Response
_tpbu.InferenceRequest = _Placeholder
_tpbu.InputTensor = _Placeholder
_tpbu.OutputTensor = _Placeholder
_tpbu.TritonError = TritonError
_tpbu.Logger = _Placeholder
_tpbu.TRITONSERVER_RESPONSE_COMPLETE_FINAL = 0
sys.modules["triton_python_backend_utils"] = _tpbu

spec = importlib.util.spec_from_file_location("mum", os.path.join(MDIR, "magpie_unified_model.py"))
mum = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mum)  # shims activate on import

import torch  # noqa: E402

ckpt = os.path.join(MDIR, "model.ckpt")
hp = os.path.join(MDIR, "model_config.yaml")
print("loading model (weights + codec)...")
from pathlib import Path  # noqa: E402

# offline mount context: rewrite /data/models asset paths to /repo
_hp_src = Path(hp).read_text()
Path("/work/hp_offline.yaml").write_text(_hp_src.replace("/data/models/", "/repo/"))
hp = "/work/hp_offline.yaml"

model, cfg = mum.load_model(Path(ckpt), Path(hp))
model = model.float().cuda().eval()  # fp32 for the offline truth test (server path manages dtypes itself)
print("model loaded; vocab_size:", getattr(model, "vocab_size", "?"))

from omegaconf import OmegaConf  # noqa: E402
from nemo.collections.tts.data.text_to_speech_dataset_lhotse import setup_tokenizers  # noqa: E402

raw = OmegaConf.load(hp)
if "cfg" in raw:
    raw = raw.cfg
import yaml as _yaml  # noqa: E402

raw_yaml = _yaml.safe_load(open(hp))
tt_cfg = (raw_yaml.get("cfg", raw_yaml)).get("text_tokenizers")
# rewrite asset paths to /repo
def _fix(o):
    if isinstance(o, dict):
        return {k: _fix(v) for k, v in o.items()}
    if isinstance(o, str):
        return o.replace("/data/models/", "/repo/")
    return o

tt_cfg = _fix(tt_cfg)
agg = setup_tokenizers(OmegaConf.create(tt_cfg), mode="test")
TEXT = "Clean build, still speaking."
ids = agg.encode(TEXT, "english_phoneme")
print("tokens:", ids[:24], "... total", len(ids))

# introspect chunk state API
print("create_longform_chunk_state sig:", inspect.signature(model.create_longform_chunk_state))
batch = {"text": torch.tensor([ids], device="cuda").long(), "text_lens": torch.tensor([len(ids)], device="cuda").long()}
state = model.create_longform_chunk_state(1)

out = model.generate_long_form_speech(batch, state, [True], True)
codes = out.predicted_codes
print("codes:", tuple(codes.shape))

# decode via codec
audio = None
for attr in ("decode", "convert_codes_to_audio", "codec_decode"):
    fn = getattr(model, attr, None)
    if fn:
        try:
            r = fn(codes)
            audio = r[0] if isinstance(r, (tuple, list)) else r
            print("decoded via", attr)
            break
        except Exception as e:
            print(attr, "failed:", str(e)[:120])
if audio is None and getattr(model, "_codec_model", None) is not None:
    import torch as _torch

    c = codes.squeeze(0)  # (C, fs, T) -> flatten frame stacking to (C, T)
    c = _torch.stack([c[:, fs, :] for fs in range(c.shape[1])], dim=-1).reshape(c.shape[0], -1)
    audio, _ = model._codec_model.decode(
        tokens=c.unsqueeze(0).cuda(), tokens_len=_torch.tensor([c.shape[1]], device="cuda")
    )
    print("decoded via _codec_model.decode (kwarg call)")

assert audio is not None, "no decode path found"
wav = audio.detach().float().cpu().numpy().squeeze()
import numpy as np  # noqa: E402

pcm = (np.clip(wav, -1, 1) * 32767).astype(np.int16)
with wave.open("/work/offline_test.wav", "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(22050)
    w.writeframes(pcm.tobytes())
print("WROTE /work/offline_test.wav", pcm.shape)
