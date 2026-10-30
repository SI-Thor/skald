#!/usr/bin/env bash
# start-all.sh — bring the full skald + last-mile stack up after a reboot.
# The production pair (skald-riva container + skald-daemon systemd) auto-starts
# anyway; this script verifies it and starts the LAN/last-mile services.
set -euo pipefail
echo "==> production pair"
systemctl is-active skald-daemon >/dev/null || sudo systemctl start skald-daemon
sudo docker start skald-riva 2>/dev/null || true
echo "==> waiting for Riva (engines cached; ~1-2 min)..."
for i in $(seq 1 24); do
  curl -s -m 2 -o /dev/null localhost:50000/v1/health && break; sleep 5
done
curl -s localhost:8000/v1/health && echo
echo "==> LAN / last-mile services"
sudo docker start skald-nats skald-qdrant skald-embed 2>/dev/null || true
sleep 2
echo "==> steering LLM"
systemctl is-active ollama >/dev/null || sudo systemctl start ollama
echo "==> status"
sudo docker ps --format '{{.Names}}: {{.Status}}'
curl -s localhost:8000/v1/voices | python3 -c "import json,sys; print('voices:', len(json.load(sys.stdin)['voices']))"
echo "START-ALL-DONE (first qwen3-coder call after reboot pays an ~18 GB warm-load, ~3 min)"
