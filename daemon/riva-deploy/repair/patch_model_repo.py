"""Patch the deployed HF-path model repo so the Triton python backend can load it.

1. Copy the checkpoint's bundled dict/heteronym/speaker assets (hash-prefixed
   names in the .nemo tar) into <model_dir>/assets/ with clean names.
2. Rewrite every `nemo:HASHED_name` URI in the deployed model_config.yaml to
   the absolute in-container path of the staged file. The save-restore
   connector cannot resolve `nemo:` URIs without a .nemo backing file
   (posixpath.join(None) TypeError at model load).
3. Split baked_context_embedding.pt into Speaker0.pt..Speaker4.pt in the
   preprocessor dir (the C++ preprocessor wants one file per subvoice).
"""
import os
import re
import shutil

import torch

REPO = "/repo"
MODEL_DIR = os.path.join(REPO, "magpie_tts-Magpie-Opensource", "1")
PRE_DIR = os.path.join(REPO, "tts_preprocessor-Magpie-Opensource", "1")
ASSETS = os.path.join(MODEL_DIR, "assets")
STAGED = "/work/357m-assets"  # hash-prefixed files extracted from the .nemo tar
CONTAINER_MODEL_DIR = "/data/models/magpie_tts-Magpie-Opensource/1"

os.makedirs(ASSETS, exist_ok=True)

mapping = {}
for fn in os.listdir(STAGED):
    m = re.match(r"^[0-9a-f]{32}_(.+)$", fn)
    clean = m.group(1) if m else fn
    shutil.copy2(os.path.join(STAGED, fn), os.path.join(ASSETS, clean))
    mapping[fn] = os.path.join(CONTAINER_MODEL_DIR, "assets", clean)
    print(f"staged {clean}")

cfg_path = os.path.join(MODEL_DIR, "model_config.yaml")
with open(cfg_path) as f:
    cfg = f.read()

count = 0
for hashed, target in mapping.items():
    uri = f"nemo:{hashed}"
    if uri in cfg:
        cfg = cfg.replace(uri, target)
        count += 1

with open(cfg_path, "w") as f:
    f.write(cfg)
print(f"rewrote {count} nemo: URIs to absolute paths")

d = torch.load(os.path.join(MODEL_DIR, "baked_context_embedding.pt"), map_location="cpu", weights_only=False)
for k, v in d.items():
    torch.save(v, os.path.join(PRE_DIR, f"Speaker{int(k)}.pt"))
    print(f"Speaker{int(k)}.pt written", tuple(v.shape))

print("PATCH-DONE")
