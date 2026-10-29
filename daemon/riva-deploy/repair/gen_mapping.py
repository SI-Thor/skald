"""Generate ground-truth per-language mapping.txt files for the C++ preprocessor.

Uses the model's own tokenizer construction path (setup_tokenizers) so ids are
the true aggregated ids this model's 3359-row embedding expects:
  global_id = tokenizer_offset[name] + local_id
Writes mapping.txt for each language into the deployed preprocessor dirs.
"""
import json
import logging
import os

logging.basicConfig(level=logging.WARNING)

# kwarg skew shim
import inspect

import nemo.collections.common.tokenizers.text_to_speech.tts_tokenizers as _tt
import nemo.collections.tts.g2p.models.i18n_ipa as _g2p_mod


def _filter_kwargs_shim(cls):
    orig = cls.__init__
    try:
        params = inspect.signature(orig).parameters
    except (ValueError, TypeError):
        return cls
    if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return cls
    accepted = set(params)

    def __init__(self, *a, **kw):
        kw = {k: v for k, v in kw.items() if k in accepted}
        orig(self, *a, **kw)

    cls.__init__ = __init__
    return cls


for _mod in (_tt, _g2p_mod):
    for _name in list(vars(_mod)):
        _obj = getattr(_mod, _name)
        if isinstance(_obj, type) and getattr(_obj, "__module__", "") == _mod.__name__:
            _filter_kwargs_shim(_obj)

from omegaconf import OmegaConf  # noqa: E402

cfg = OmegaConf.load("/repo/magpie_tts-Magpie-Opensource/1/model_config.yaml")
if "cfg" in cfg:
    cfg = cfg.cfg

# rewrite container-abs asset paths to this mount
import re  # noqa: E402

raw = OmegaConf.to_yaml(cfg)
raw = raw.replace("/data/models/", "/repo/")
cfg = OmegaConf.create(raw)

from nemo.collections.tts.data.text_to_speech_dataset_lhotse import setup_tokenizers  # noqa: E402

agg = setup_tokenizers(cfg.text_tokenizers, mode="test")
print("vocab_size:", agg.vocab_size)
print("offsets:", json.dumps(agg.tokenizer_offsets, indent=0))
print("pad ids:", json.dumps(agg.tokenizer_pad_ids))

LANG_TO_TOK = {
    "en-US": "english_phoneme",
    "es-US": "spanish_phoneme",
    "fr-FR": "french_chartokenizer",
    "de-DE": "german_phoneme",
    "zh-CN": "mandarin_phoneme",
    "vi-VN": "vietnamese_chartokenizer",
    "it-IT": "italian_chartokenizer",
    "hi-IN": "hindi_phoneme",
    "ja-JP": "japanese_phoneme",
    "ko-KR": "korean_chartokenizer",
    "ar-XA": "arabic_MSA_chartokenizer",
    "pt-BR": "portuguese_Brazilian_phoneme",
}

PRE_DIR = "/repo/tts_preprocessor-Magpie-Opensource/1"

# Declared offsets (training truth) from the deployed pbtxt — paired positionally
# with the config's tokenizer order. Format: lang:offset:flag
DECLARED = "None:1327:0,None:1655:0,None:1491:0,en-US:0:0,fr-FR:1819:3,de-DE:583:0,hi-IN:1128:0,it-IT:2203:3,ja-JP:842:0,None:2971:3,zh-CN:733:0,None:1017:0,es-US:480:0,None:96:3,vi-VN:2587:3"
CFG_ORDER = [
    "arabic_AE_chartokenizer", "arabic_MSA_chartokenizer", "arabic_SA_chartokenizer",
    "english_phoneme", "french_chartokenizer", "german_phoneme", "hindi_phoneme",
    "italian_chartokenizer", "japanese_phoneme", "korean_chartokenizer",
    "mandarin_phoneme", "portuguese_Brazilian_phoneme", "spanish_phoneme",
    "text_ce_tokenizer", "vietnamese_chartokenizer",
]
declared_offsets = {}
lang_of_entry = []
for entry in DECLARED.split(","):
    lang, off, _flag = entry.split(":")
    lang_of_entry.append(lang if lang != "None" else None)
    declared_offsets[len(declared_offsets)] = int(off)
tok_declared = dict(zip(CFG_ORDER, [declared_offsets[i] for i in range(len(CFG_ORDER))]))
print("declared offsets by tokenizer:", json.dumps(tok_declared, indent=0))

report = {}
for lang, tok_name in LANG_TO_TOK.items():
    tok = agg.tokenizers.get(tok_name)
    if tok is None:
        report[lang] = f"missing tokenizer {tok_name}"
        continue
    offset = tok_declared[tok_name]
    entries = []
    if hasattr(tok, "tokens"):  # BaseTokenizer (phoneme/IPA)
        local = {t: i for i, t in enumerate(tok.tokens)}
    else:  # HF tokenizer
        local = {t: i for t, i in tok.get_vocab().items()}
    for t, lid in local.items():
        if t in ("<pad>", "<oov>", "<unk>", "<s>", "</s>", "<bos>", "<eos>"):
            entries.append((offset + lid, t))
            continue
        # single printable char only (plain space OK); the C++ parser rejects
        # empty/invisible lines (byt5 vocab contains control/nbsp bytes)
        if len(t) == 1 and (t == " " or (t.isprintable() and ord(t) >= 32)):
            entries.append((offset + lid, t))
    entries.sort()
    path = os.path.join(PRE_DIR, lang, "mapping.txt")
    with open(path, "w") as f:
        for gid, t in entries:
            f.write(f"{gid} {t}\n")
    report[lang] = f"{len(entries)} entries (declared offset {offset})"

print(json.dumps(report, indent=1))
print("GEN-MAPPING-DONE")
