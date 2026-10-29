"""Inject the version-skew kwarg shim into the deployed backend module.

The server-side model load hits the same checkpoint/NeMo skew the conversion
did (e.g. ArabicCharsTokenizer(charset_version=...) unknown to 2.8.0rc0).
magpie_unified_model.py is part of OUR model repo, so the shim ships with the
model and runs at backend import time — no image modification needed.
"""
import re

PATH = "/repo/magpie_tts-Magpie-Opensource/1/magpie_unified_model.py"
MARKER = "# SKALD-COMPAT-SHIM"

SHIM = '''
# SKALD-COMPAT-SHIM: drop constructor kwargs unknown to this image's nemo
# toolkit when instantiating tokenizer/g2p classes from newer checkpoints.
# (Checkpoint: magpie_tts_multilingual_357m, NeMo-Speech Jul-2026; image:
# nemo-toolkit 2.8.0rc0.) Unknown feature flags defaulting to off/neutral in
# the new toolkit are safe to drop against the old one.
import inspect as _inspect
import logging as _logging

_shim_log = _logging.getLogger("skald_compat")


def _filter_kwargs_shim(_cls):
    _orig = _cls.__init__
    try:
        _params = _inspect.signature(_orig).parameters
    except (ValueError, TypeError):
        return _cls
    if any(_p.kind == _inspect.Parameter.VAR_KEYWORD for _p in _params.values()):
        return _cls
    _accepted = set(_params)

    def _init(self, *a, **kw):
        for _k in [_k for _k in kw if _k not in _accepted]:
            _shim_log.info("shim: %s.__init__ dropping kwarg %s=%r", _cls.__name__, _k, kw[_k])
        kw = {_k: _v for _k, _v in kw.items() if _k in _accepted}
        _orig(self, *a, **kw)

    _cls.__init__ = _init
    return _cls


for _mod_name in (
    "nemo.collections.common.tokenizers.text_to_speech.tts_tokenizers",
    "nemo.collections.tts.g2p.models.i18n_ipa",
):
    try:
        import importlib as _importlib

        _mod = _importlib.import_module(_mod_name)
    except Exception as _e:  # noqa: BLE001
        _shim_log.warning("shim: could not import %s (%s)", _mod_name, _e)
        continue
    for _name in list(vars(_mod)):
        _obj = getattr(_mod, _name)
        if isinstance(_obj, type) and getattr(_obj, "__module__", "") == _mod_name:
            _filter_kwargs_shim(_obj)
# END SKALD-COMPAT-SHIM
'''

with open(PATH) as f:
    src = f.read()

if MARKER in src:
    print("shim already present")
else:
    # insert after the module docstring / initial import block: first index of
    # a line that is not import/def/class/comment/blank after the header
    lines = src.split("\n")
    insert_at = 0
    for i, line in enumerate(lines[:80]):
        if line.startswith(("import ", "from ", "#", '"""', "'", '"')) or line.strip() in ("", ")"):
            insert_at = i + 1
            continue
        if re.match(r"^(def |class |@)", line):
            insert_at = i
            break
    lines.insert(insert_at, SHIM)
    with open(PATH, "w") as f:
        f.write("\n".join(lines))
    print(f"shim injected after line {insert_at}")
print("INJECT-DONE")
