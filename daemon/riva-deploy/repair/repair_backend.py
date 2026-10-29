"""repair_backend.py — apply the post-deploy backend fixes to a fresh repo.

Fixes (see README.md #13/#14 + pbtxt chunk params):
  1. Device/dtype alignment of the speaker context tensor at the decoder
     concat sites (Speaker*.pt arrive on CPU; the decoder runs on CUDA).
  2. Rebuild an all-valid mask over the embedded audio prefix each decoder
     step (embed_audio_tokens returns stacked lens that lag the growing
     prefix; a once-built mask from raw lens mismatches by frame_stacking).
  3. config.pbtxt chunking params to the Magpie-family streaming values:
     chunk_ms 300->90, fade_ms 10->5, history_len 5->6.

Run INSIDE the riva container with the model repo mounted at /repo
(idempotent; safe to re-run).
"""
import re

BACKEND = "/repo/magpie_tts-Magpie-Opensource/1/magpie_unified_model.py"
PBTXT = "/repo/magpie_tts-Magpie-Opensource/config.pbtxt"

src = open(BACKEND).read()
changed = []

# --- 1. device/dtype alignment -------------------------------------------------
old = "            context_features = context_features.unsqueeze(0)\n"
new = ("            context_features = context_features.unsqueeze(0)"
       ".to(encoder_out.device).to(encoder_out.dtype)\n")
if old in src:
    src = src.replace(old, new, 1)
    changed.append("device-align:context_features")

for old_frag, new_frag, tag in [
    (
        "torch.cat([context_features, audio_codes_embedded], dim=1)",
        "torch.cat([context_features.to(audio_codes_embedded.device, audio_codes_embedded.dtype), audio_codes_embedded], dim=1)",
        "device-align:audio_cat",
    ),
    (
        "torch.cat([context_mask, audio_codes_mask], dim=1)",
        "torch.cat([context_mask.to(audio_codes_mask.device), audio_codes_mask], dim=1)",
        "device-align:mask_cat",
    ),
]:
    if old_frag in src:
        src = src.replace(old_frag, new_frag, 1)
        changed.append(tag)

# --- 2. all-valid mask over embedded length ------------------------------------
embed_anchor = """                    audio_codes_embedded, audio_codes_lens = self.model.embed_audio_tokens(
                        audio_codes_input, audio_tokens_lens=audio_codes_lens
                    )"""
mask_fix = embed_anchor + """
                    # SKALD-FIX: in this streaming path there is no padding — the
                    # mask must simply cover all embedded positions. The lens
                    # returned by embed_audio_tokens lag the growing prefix, which
                    # produced off-by-N mask mismatches in the decoder.
                    audio_codes_mask = torch.ones(
                        audio_codes_embedded.shape[0],
                        audio_codes_embedded.shape[1],
                        dtype=context_mask.dtype,
                        device=audio_codes_embedded.device,
                    )"""
if "SKALD-FIX: in this streaming path" not in src:
    assert embed_anchor in src, "embed anchor not found"
    src = src.replace(embed_anchor, mask_fix, 1)
    changed.append("mask-rebuild")

open(BACKEND, "w").write(src)

# --- 3. pbtxt chunk params ------------------------------------------------------
pb = open(PBTXT).read()
for key, new in [("chunk_ms", "90"), ("fade_ms", "5"), ("history_len", "6")]:
    pat = re.compile(r'(key: "%s"\s*\n\s*value \{\s*\n\s*string_value: )"([^"]+)"' % key)
    if pat.search(pb):
        pb = pat.sub(lambda m: m.group(1) + '"%s"' % new, pb, count=1)
        changed.append(f"pbtxt:{key}={new}")
open(PBTXT, "w").write(pb)

print("repair_backend:", ", ".join(changed) if changed else "nothing to do")
