#!/usr/bin/env bash
# reboot-verify.sh — run after a Thor reboot.
# The production pair (skald-riva + skald-daemon) auto-starts; everything
# else stays DOWN until ops/start-all.sh brings it up.
set -uo pipefail
pass=0; fail=0
chk() { if eval "$2" >/dev/null 2>&1; then echo "OK   $1"; pass=$((pass+1)); else echo "DOWN $1"; fail=$((fail+1)); fi; }
chk "skald-daemon (systemd)"     "systemctl is-active skald-daemon"
chk "skald-riva (docker, auto)"  "sudo docker ps --filter name=skald-riva --filter status=running"
chk "Riva health (:50000)"       "curl -s -m 2 localhost:50000/v1/health"
chk "daemon health (:8000)"      "curl -s -m 2 localhost:8000/v1/health"
chk "ollama (systemd, idle)"     "systemctl is-active ollama"
chk "LAN services (expect DOWN)" "! sudo docker ps --filter name=skald-nats --filter status=running"
echo "- $pass ok, $fail down (LAN services down is EXPECTED — ops/start-all.sh brings them up)"
[ "$fail" -le 1 ]
