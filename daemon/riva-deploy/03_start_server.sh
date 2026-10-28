#!/usr/bin/env bash
# =============================================================================
# 03_start_server.sh - Start the Riva speech server container (skald-riva).
#
#   ./03_start_server.sh            # start (idempotent-guarded)
#   ./03_start_server.sh status     # docker ps line + last 50 log lines
#   ./03_start_server.sh logs       # follow logs (Ctrl-C to detach)
#   ./03_start_server.sh stop       # stop + remove container
#   ./03_start_server.sh restart    # stop + start
#   ./03_start_server.sh help
#
# Internals (verified from the image):
#   - Image entrypoint /opt/nvidia/nvidia_entrypoint.sh execs its args, so the
#     docker command is simply `start-riva`.
#   - start-riva serves the model repo at /data/models via Triton
#     (grpc 8001 / http 8002 / metrics 8000, container-internal) and fronts it
#     with the Riva gRPC server on 50051 and Riva HTTP server on 50000.
#     The realtime server (port 9000) is also started container-internally.
# =============================================================================
set -euo pipefail

RIVA_IMAGE="${RIVA_IMAGE:-nvcr.io/nvidia/riva/riva-speech:2.26.0-l4t-aarch64}"
BASE_DIR="${BASE_DIR:-/home/caseydigennaro/src/skald-riva}"
MODEL_REPO_DIR="${MODEL_REPO_DIR:-$BASE_DIR/model-repo}"
CONTAINER_NAME="${CONTAINER_NAME:-skald-riva}"
SHM_SIZE="${SHM_SIZE:-8g}"
PORT_GRPC="${PORT_GRPC:-50051}"   # Riva gRPC (riva_tts_client, talk.py)
PORT_HTTP="${PORT_HTTP:-50000}"   # Riva HTTP

DOCKER="${DOCKER:-docker}"
if ! "$DOCKER" ps >/dev/null 2>&1; then DOCKER="sudo -n docker"; fi

usage() { sed -n '2,15p' "$0"; }
status() {
  echo "--- docker ps ---"
  "$DOCKER" ps -a --filter "name=$CONTAINER_NAME" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  echo "--- last 50 log lines ---"
  "$DOCKER" logs --tail 50 "$CONTAINER_NAME" 2>&1 || true
}
start() {
  if "$DOCKER" ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    echo "Container '$CONTAINER_NAME' already exists. Use: $0 restart | stop"
    status; exit 1
  fi
  if [[ ! -d "$MODEL_REPO_DIR" ]] || [[ -z "$(ls -A "$MODEL_REPO_DIR" 2>/dev/null)" ]]; then
    echo "WARNING: $MODEL_REPO_DIR is empty - run 02_deploy_repo.sh first or Triton will have no models."
  fi
  echo "==> Starting $CONTAINER_NAME ($RIVA_IMAGE, start-riva)"
  echo "    model repo : $MODEL_REPO_DIR -> /data/models"
  echo "    ports      : grpc $PORT_GRPC, http $PORT_HTTP"
  "$DOCKER" run -d --runtime nvidia --gpus all \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --shm-size "$SHM_SIZE" \
    -p "$PORT_GRPC":50051 \
    -p "$PORT_HTTP":50000 \
    -v "$MODEL_REPO_DIR":/data/models \
    "$RIVA_IMAGE" start-riva
  echo "==> Started. Waiting ~10s before first status..."
  sleep 10
  status
  echo "Tip: '$0 logs' to follow; server is ready when Triton reports ready and"
  echo "     riva-server logs listening on 50051 (may take 1-3 min on first load)."
}
stop() { "$DOCKER" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true; echo "Stopped/removed $CONTAINER_NAME"; }

case "${1:-start}" in
  start)   start ;;
  status)  status ;;
  logs)    exec "$DOCKER" logs -f "$CONTAINER_NAME" ;;
  stop)    stop ;;
  restart) stop; start ;;
  help|-h|--help) usage ;;
  *) usage; exit 1 ;;
esac
