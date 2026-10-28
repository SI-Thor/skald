# Skald-Riva deploy toolkit - research notes

Riva TTS (MagpieTTS Multilingual 357M) on Jetson Thor (aarch64, Blackwell).
Image: `nvcr.io/nvidia/riva/riva-speech:2.26.0-l4t-aarch64`
(RIVA_SPEECH_VERSION=2.26.0, server 26.05, CUDA 13.0, Triton bundled).

Run order: `01_build_rmir.sh` -> `02_deploy_repo.sh` -> `03_start_server.sh`
-> `04_probe.sh`. All scripts: `set -euo pipefail`, parameterized via env
vars, auto-fallback `sudo -n docker` if plain `docker` cannot reach the daemon.

## Provenance legend

- **[VERIFIED-image]**: read directly from the image in this project's earlier
  session (pre-block). Reliable.
- **[RECONSTRUCTED-docs]**: from NVIDIA's public docs for the same-generation
  toolchain. Strong, but not read out of this exact image.
- **[INFERRED]**: reasoned from the above; flagged as a risk.

Docker `run`/`exec`/`cp` were sandbox-blocked while building this toolkit, so
the image could not be re-interrogated; `extracted-base.yaml` records exactly
which parts of the servicemaker TTS config were and were not recovered.

## The two build paths

### Path A (primary, used by 01_build_rmir.sh default): single-step hydra riva-build with inline .nemo conversion

```
riva-build --config-path=pkg://servicemaker.configs.tts --config-name=base \
  output_path=/work/magpie_tts_multilingual.rmir \
  'source_path=[{path: /models/magpie_tts_multilingual_357m.nemo, nemo2riva: {audio_codec: /models/low-frame-rate-speech-codec-22khz.nemo}}]' \
  multilingual=true \
  voice_name=Magpie-Opensource \
  language_code='en-US,es-US,fr-FR,de-DE,zh-CN,vi-VN,it-IT,hi-IN,ja-JP,ko-KR,ar-XA,pt-BR' \
  sample_rate=22050 \
  n_timesteps=32 \
  platform_aarch=true \
  force=true
```

Why: NVIDIA's "Deploying Custom Models as NIM" docs
(https://docs.nvidia.com/nim/speech/latest/tts/custom-deployment.html,
last updated Aug 13, 2026 - same generation as our 26.05-based image) state
"Inline .nemo conversion in riva-build (recommended): This is the path used by
the Magpie TTS model families", and its "Example - Magpie TTS Multilingual"
builds exactly our checkpoint (multilingual Magpie with audio codec) with
`voice_name=Magpie-Opensource`, `sample_rate=22050`, and the 12-language
`language_code` list above (as a comma-separated quoted string). The doc also
shows `source_path=[{path: ..., nemo2riva: {key: tlt_encode}}]` - i.e. the
source entry's `nemo2riva:` options dict mirrors nemo2riva CLI flags - which
is how the codec is attached inline: `nemo2riva: {audio_codec: <codec.nemo>}`
[RECONSTRUCTED-docs pattern; exact option key INFERRED from the verified
nemo2riva `--audio-codec` flag].

### Path B (fallback, `BUILD_MODE=twostep ./01_build_rmir.sh`): explicit nemo2riva, then riva-build

```
nemo2riva --audio-codec /models/low-frame-rate-speech-codec-22khz.nemo \
  --out /work/model.riva /models/magpie_tts_multilingual_357m.nemo
riva-build --config-path=pkg://servicemaker.configs.tts --config-name=base \
  output_path=/work/magpie_tts_multilingual.rmir \
  'source_path=[/work/model.riva]' \
  multilingual=true voice_name=Magpie-Opensource sample_rate=22050 \
  n_timesteps=32 platform_aarch=true force=true
```

`nemo2riva --help` [VERIFIED-image] includes `--audio-codec` (plus `--key`,
`--out`, `--validate`, `--runtime-check`, ...), so codec wiring here is
explicit and unambiguous. Use this if Path A's inline `audio_codec` option is
rejected.

### Config-CLI form

base.yaml's own usage header [VERIFIED-image] is
`python -m servicemaker.cli.build_hydra --config-path=configs/tts --config-name=base output_path=out.rmir source_path=[model.riva]`
(relative --config-path). The scripts use `riva-build
--config-path=pkg://servicemaker.configs.tts --config-name=base ...`
[RECONSTRUCTED-docs, NIM custom-deployment page]. If `riva-build` here does
not take `--config-path`, use the module form from anywhere:
`python3 -m servicemaker.cli.build_hydra --config-path=pkg://servicemaker.configs.tts --config-name=base <same overrides>`
(a commented fallback is in 01_build_rmir.sh).

## Key configuration decisions

- **Codec wiring**: low-frame-rate speech codec (HF
  `nvidia/low-frame-rate-speech-codec-22khz`, 22 kHz low-frame-rate causal
  codec) is attached via Path A inline `nemo2riva: {audio_codec: ...}` or
  Path B `nemo2riva --audio-codec`. base.yaml names an optional
  `audio_codec_encoder` module, but its sub-config keys were NOT recovered
  (see extracted-base.yaml); the two paths above avoid needing them.
- **voice_name**: default `Magpie-Opensource` - the value NVIDIA's docs use
  when building the open-sourced HF 357M checkpoint [RECONSTRUCTED-docs].
  Runtime voice names are a separate matter (see Risks): Riva OOTB docs list
  `Magpie-Multilingual.<LOCALE>.<Gender>.<Style>` voices (e.g.
  `Magpie-Multilingual.EN-US.Female.Female-1`, `...EN-US.Male.Male-1`,
  FR-FR/ES-US variants + emotion styles) for the Riva deployable of this
  model family; the NIM exposes `Magpie-Multilingual.EN-US.<Speaker>` names
  (Aria, Jason, John, Leo, Sofia per HF card; docs quickstart shows
  `...EN-US.Mia`). 04_probe.sh resolves reality via `--list-voices`.
- **multilingual=true + language_code list**: model is 12-language; OOTB
  quickstart builds it with `tts_model="magpie" tts_language_code="multi"`.
- **platform_aarch=true**: we are on aarch64 Jetson; base.yaml default is
  false, and its header explicitly lists `platform_aarch=...` as an override.
  Presumably selects aarch-compatible engine settings [INFERRED; low risk -
  if the build fails with it, retry PLATFORM_AARCH=false].
- **Defaults left at base.yaml values** (no override needed):
  `n_timesteps=32`, `transcript_decoder_layers="3,4,5,6,7,8"`,
  `context_decoder_layers="0,1,2,9,10,11"`, `history_future=5`,
  `is_zero_shot=false` (**zero-shot was REMOVED from this HF release per the
  model card - do not enable**). `sample_rate=22050` per HF card + docs example.
- **riva-deploy** [VERIFIED-image usage]:
  `riva-deploy [-h] [--config_only] [-f] [-g GPUS_TO_USE] [--use_ampereplus]
  [-v] [--override_config ...] rmir_model [rmir_model ...] target`.
  02_deploy_repo.sh runs `riva-deploy -f <rmir> /data/models` with the host
  model-repo mounted at `/data/models` (matches start-riva's
  `--model-repository /data/models`; docs warn other mount points require
  manual config.pbtxt path fixing).
- **Server** [VERIFIED-image]: entrypoint `/opt/nvidia/nvidia_entrypoint.sh`
  execs args -> docker command is `start-riva`; serves `/data/models` via
  Triton (8001/8002/8000 internal) fronted by Riva gRPC 50051 and HTTP 50000
  (realtime 9000 internal). 03_start_server.sh publishes 50051+50000,
  `--restart unless-stopped`, `--shm-size 8g` (Triton benefit).

## Unknowns and risks

1. **Inline `audio_codec` option key** [INFERRED]: docs prove the
   `nemo2riva: {flag: value}` inline-options pattern (`key: tlt_encode`) but
   the `audio_codec` spelling against this exact servicemaker build is
   unverified. Fallback: `BUILD_MODE=twostep`.
2. **Voice name at runtime**: which voices the built RMIR exposes (and what
   `--list-voices` prints) is unknown until first run. `Magpie-Opensource`
   is a build-time label from the docs example; runtime voices likely follow
   the `Magpie-Multilingual.*` patterns above. 04_probe.sh auto-picks the
   first Magpie voice and every script exposes VOICE/VOICE_NAME overrides.
3. **Language/text-normalization assets**: the NIM Magpie build example also
   passes a dozen wfst tokenizer/verbalizer/mapping/phone-dictionary assets
   (from a language-asset archive we do not have locally; its download marker
   `models/magpie_deployable_1.0.download` shows the NGC deployable-files
   API returned NOT_FOUND for
   `nvidia/riva/speechsynthesis_multilingual_magpietts_ipa/deployable_1.0`).
   base.yaml instead has `language_archive_path: null` and
   `preprocessor.mapping_path: mapping.txt` defaults - servicemaker likely
   bundles defaults or extracts them from the .nemo. If the build complains
   about missing mapping/normalization assets, obtain the archive from the
   NGC deployable (needs `ngc` CLI + auth) and pass
   `language_archive_path=/models/<archive>`.
4. **`riva-build --config-path` form** [RECONSTRUCTED-docs]: see fallback note
   above; the `python -m` form is the one verified from the image.
5. **Encryption key**: docs inline example passes `key: tlt_encode` to
   nemo2riva; we pass no key (default). If the server later fails to load the
   deployed model with a decrypt error, add `--key tlt_encode` (twostep) or
   `nemo2riva: {key: tlt_encode, audio_codec: ...}` (inline).
6. **Root-owned outputs**: containers run as root, so files written to the
   mounted `work/` and `model-repo/` dirs will be root-owned on the host;
   `sudo chown -R $USER ...` afterwards if needed.
7. **First-request latency**: Jetson Thor engine build/autotune can make
   01 (tens of minutes) and the first synthesis slow; 04_probe.sh timings
   note this. Use `/opt/riva/clients/riva_tts_perf_client` for real
   benchmarks. Magpie supports only the `phoneme` SSML tag (no prosody SSML).
8. **NGC shortcut** (alternative to building at all): the prebuilt RMIR
   deployable `nvidia/riva/speechsynthesis_multilingual_magpietts_ipa`
   would skip 01 entirely (riva-deploy it directly); the earlier download
   attempt 404'd, likely requiring NGC auth - revisit if the custom build
   path stalls.

## Files

- `01_build_rmir.sh` - build RMIR (Path A default, Path B via BUILD_MODE)
- `02_deploy_repo.sh` - riva-deploy RMIR into ../model-repo (as /data/models)
- `03_start_server.sh` - run skald-riva server container (start/status/logs/stop/restart)
- `04_probe.sh` - list voices + 3 timed syntheses into ../audio/
- `extracted-base.yaml` - partial servicemaker tts/base.yaml with provenance
- `NOTES.md` - this file

## Sources

- NVIDIA NIM docs, "Deploying Custom Models as NIM" (Magpie example,
  inline nemo2riva, --config-path=pkg:// form):
  https://docs.nvidia.com/nim/speech/latest/tts/custom-deployment.html
- NVIDIA Riva docs, TTS Overview (MagpieTTS Multilingual voice table):
  https://docs.nvidia.com/deeplearning/riva/user-guide/docs/tts/tts-overview.html
- NVIDIA NIM docs, Voices and Emotional Styles:
  https://docs.nvidia.com/nim/speech/latest/tts/voices.html
- HF model card (speakers, 12 languages, 22050 Hz, zero-shot removed):
  https://huggingface.co/nvidia/magpie_tts_multilingual_357m
- Image extractions from this project's earlier session (base.yaml prefix,
  nemo2riva/riva-deploy --help, start-riva, talk.py flags): [VERIFIED-image]
