#!/usr/bin/env bash
# stop-all.sh — trim to zero (full quiet). Idempotent.
set -uo pipefail
sudo docker stop skald-nats skald-qdrant skald-embed skald-riva 2>/dev/null || true
sudo systemctl stop skald-daemon 2>/dev/null || true
echo "stopped: nats, qdrant, embed, riva, daemon. (ollama stays; models unload after 30m idle)"
sudo docker ps --format '{{.Names}}'
