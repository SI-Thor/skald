# SETUP — production bring-up on a Jetson Thor (from zero)

Assumptions: JetPack 7.x on Thor, passwordless sudo, internet, an NGC account
(free) whose key can pull nvcr.io. Everything else is scripted in this repo.

## 0. One-time host prep

```bash
sudo apt install -y docker.io && sudo usermod -aG docker $USER  # re-login
git clone https://github.com/SI-Thor/skald ~/src/skald
mkdir -p ~/src/skald-riva/{models,work,model-repo-official} ~/src/ngc-cli-arm
```

## 1. NGC credentials (used by pulls *and* the NIM at runtime)

Extract the docker-login key once (it is the NGC API key):

```bash
sudo python3 - <<'EOF'
import json, base64
auth = json.load(open('/root/.docker/config.json'))['auths']['nvcr.io']['auth']
print(base64.b64decode(auth).decode().split(':', 1)[1])
EOF
# → save as ~/ngc_key (chmod 600)
```

Install the native ARM64 NGC CLI (URL from NVIDIA's own riva_init.sh):

```bash
curl -L https://api.ngc.nvidia.com/v2/resources/nvidia/ngc-apps/ngc_cli/versions/3.48.0/files/ngccli_arm64.zip \
  -o /tmp/ngccli.zip && unzip -qo /tmp/ngccli.zip -d ~/src/ngc-cli-arm
export NGC_CLI_API_KEY=$(cat ~/ngc_key) NGC_CLI_ORG=nvidia
~/src/ngc-cli-arm/ngc-cli/ngc version   # works; all gated pulls are now scriptable
```

## 2. Speech server (Riva + TRT-LLM Magpie)

```bash
# image (32 GB) + NVIDIA's canonical Thor-prebuilt model repo (3.3 GB)
sudo docker pull nvcr.io/nvidia/riva/riva-speech:2.26.0-l4t-aarch64
cd ~/src/skald-riva/prebuilt
NGC_CLI_API_KEY=$NGC_CLI_API_KEY NGC_CLI_ORG=nvidia \
  ~/src/ngc-cli-arm/ngc-cli/ngc registry model download-version \
  nvidia/riva/models_tts_magpie_multilingual_ipa:2.26.0-tegra-thor
mkdir -p ~/src/skald-riva/model-repo-official
sudo tar xf models_tts_magpie_multilingual_ipa_v2.26.0-tegra-thor/*.tar.gz \
  -C ~/src/skald-riva/model-repo-official
```

Start & verify (scripts in `daemon/riva-deploy/`, env-parameterized —
`BASE_DIR=~/src/skald-riva`):

```bash
MODEL_REPO_DIR=~/src/skald-riva/model-repo-official ./daemon/riva-deploy/03_start_server.sh
sleep 180 && ./daemon/riva-deploy/04_probe.sh    # voices + timed syntheses
```

Up = gRPC :50051, HTTP :50000 (OpenAPI incl. `/v1/audio/synthesize`,
multipart-form, WAV out — see `docs/research/riva-2.26-http-openapi.json`).

## 3. Voice daemon (OpenAI-compatible, LAN-facing)

```bash
cd ~/src/skald/daemon/server && python3 -m venv .venv
.venv/bin/pip install fastapi 'uvicorn[standard]' httpx
sudo cp ../systemd/skald-daemon.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now skald-daemon
.venv/bin/python test_smoke.py http://localhost:8000   # incl. ASR gate if whisper venv present
```

Up = :8000 on all interfaces (`/v1/audio/speech`, `/v1/voices`, `/v1/health`).
The service survives reboots; Riva's container uses `--restart unless-stopped`.

## 4. Browsers on ANY LAN device

Install matrix (all load the same `extension/` directory):

| Browser | Load | Notes |
|---|---|---|
| Firefox 140+ | `about:debugging` → Load Temporary Add-on → `manifest.json` (permanent: AMO signing) | uses event-page background |
| Chrome / Chromium | `chrome://extensions` → Developer mode → Load unpacked | uses service-worker background |
| Edge | `edge://extensions` → Load unpacked | same as Chrome |

Then: toolbar skald icon → right-click → **Options** → set the server URL
(`http://localhost:8000` on the Thor itself; `http://<thor-ip>:8000` from any
other device) → **Test connection** → **Grant permission** (once, for
non-localhost) → Alt+R on any article.

## 5. Verify the whole chain

```bash
curl -s http://<thor-ip>:8000/v1/health | grep '"ok"'
curl -s http://<thor-ip>:8000/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"input":"Production check.","voice":"mia"}' --output check.wav
```

`check.wav` must contain intelligible speech (benchmark/ + SMOKETEST.md carry
the formal gates).

## Not in this path (documented elsewhere)

- From-scratch model rebuild: `daemon/riva-deploy/01` + `repair/` (fallback
  tile — the canonical prebuilt supersedes it)
- NIM second engine: `daemon/riva-nim/README.md` (experiment, paused)
- Podcast lane, Lane C UI: `docs/ROADMAP.md`
