# ops — lifecycle scripts

Policy (2026-10-29): **the production pair auto-starts on boot; everything
else stays down until asked for.**

| Script | Does |
|---|---|
| `reboot-verify.sh` | run after a Thor reboot — checks the auto-started pair, confirms LAN services are (expected) down |
| `start-all.sh` | verify pair + start LAN/last-mile services (nats, qdrant, embed) + status |
| `stop-all.sh` | everything off, idempotent |

Auto-start on boot: `skald-riva` (docker `unless-stopped`), `skald-daemon`
(systemd), `ollama` (systemd, idle — models load on demand, unloaded after
30 min idle). Down on boot: `skald-nats`, `skald-qdrant`, `skald-embed`
(restart policy `no` — `start-all.sh` when needed). Removed entirely:
the LLM NIM (TRT-LLM 0.17.1 has no sm_110 kernel — re-pull when a
Thor-compatible build ships; see `daemon/lan-services/README.md`).

First speech after a Riva restart is slower (engine load); first
qwen3-coder steer after a reboot pays an ~18 GB warm-load (~3 min).
