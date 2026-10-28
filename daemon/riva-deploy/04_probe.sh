#!/usr/bin/env bash
# =============================================================================
# 04_probe.sh - Probe the running skald-riva server: list voices, then run 3
#               short multilingual syntheses with wall-clock timings.
#
#   ./04_probe.sh                # auto-pick a Magpie voice from --list-voices
#   VOICE=... ./04_probe.sh      # force a voice (see --list-voices output)
#   RIVA_GRPC=host:50051 ...     # only if probing from another host
#
# Notes:
#   - Uses docker exec + /opt/riva/examples/talk.py inside the container
#     (flags verified in image: --list-voices, --text, --voice,
#      --language-code, --output; --server defaults to localhost:50051 which
#      is correct from inside the container).
#   - WAVs are written to /tmp INSIDE the container, then docker cp'd out to
#     the host audio dir (mount-safe: no host paths assumed in-container).
#   - Timings are wall-clock of the full docker-exec client round trip, which
#     includes client startup; the first synthesis also pays engine warmup,
#     so treat it as an upper bound (riva_tts_perf_client exists in the image
#     for proper benchmarking).
# =============================================================================
set -euo pipefail

CONTAINER="${CONTAINER:-skald-riva}"
BASE_DIR="${BASE_DIR:-/home/caseydigennaro/src/skald-riva}"
AUDIO_DIR="${AUDIO_DIR:-$BASE_DIR/audio}"
RIVA_GRPC="${RIVA_GRPC:-localhost:50051}"
VOICE="${VOICE:-}"
WAIT_SECS="${WAIT_SECS:-300}"

DOCKER="${DOCKER:-docker}"
if ! "$DOCKER" ps >/dev/null 2>&1; then DOCKER="sudo -n docker"; fi

echo "==> [1/4] Preflight"
if ! "$DOCKER" ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "ERROR: container '$CONTAINER' is not running. Start it with 03_start_server.sh"; exit 1
fi
mkdir -p "$AUDIO_DIR"
TALK="python3 /opt/riva/examples/talk.py --server $RIVA_GRPC"

echo "==> [2/4] Wait for server readiness (up to ${WAIT_SECS}s; first load is slow)"
deadline=$((SECONDS + WAIT_SECS))
until "$DOCKER" exec "$CONTAINER" $TALK --list-voices >/tmp/skald_probe_voices.txt 2>/dev/null; do
  if (( SECONDS >= deadline )); then
    echo "ERROR: server not ready after ${WAIT_SECS}s. Recent logs:"
    "$DOCKER" logs --tail 30 "$CONTAINER" 2>&1 || true
    exit 1
  fi
  sleep 5
done
echo "---- voices ----"
cat /tmp/skald_probe_voices.txt
echo "----------------"

# Voice selection: forced VOICE env wins; else first line mentioning magpie;
# else first non-empty line. (talk.py list format not verified - heuristic.)
if [[ -z "$VOICE" ]]; then
  VOICE=$(grep -i -m1 'magpie' /tmp/skald_probe_voices.txt | awk '{print $1}' | tr -d '\r' || true)
  [[ -z "$VOICE" ]] && VOICE=$(awk 'NF{print $1; exit}' /tmp/skald_probe_voices.txt | tr -d '\r')
fi
echo "    probe voice: $VOICE"

echo "==> [3/4] Syntheses (3 sentences: en-US, fr-FR, de-DE)"
PROBES=(
  "en-US|The skald clears his throat and begins the tale."
  "fr-FR|Bonjour, bienvenue dans le monde de la synthese vocale."
  "de-DE|Guten Tag, dies ist ein Test der Sprachsynthese."
)
i=0
for entry in "${PROBES[@]}"; do
  lang="${entry%%|*}"; text="${entry#*|}"
  i=$((i+1))
  cwav="/tmp/skald_probe_${i}.wav"
  hwav="$AUDIO_DIR/probe_${lang}_${i}.wav"
  echo "--- [$i/3] $lang : $text"
  t0=$(date +%s.%N)
  "$DOCKER" exec "$CONTAINER" $TALK \
    --voice "$VOICE" --language-code "$lang" --text "$text" --output "$cwav"
  t1=$(date +%s.%N)
  "$DOCKER" cp "$CONTAINER:$cwav" "$hwav"
  dt=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.2f", b-a}')
  sz=$(du -h "$hwav" | cut -f1)
  echo "    wall-clock: ${dt}s -> $hwav ($sz)"
done

echo "==> [4/4] Done. Audio files:"
ls -lh "$AUDIO_DIR"
