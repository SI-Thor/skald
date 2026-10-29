# daemon/ — the skald voice & content daemon

> **Status (2026-10-29): Lane A RUNNING in production** — `server/` v0.1.0
> live as `skald-daemon.service` on :8000 (verified: `test_smoke.py` incl. the
> ASR intelligibility gate). Lane B (podcast jobs) and Lane C (live show)
> are designed (ADR-0003, lane-c-sim) but not implemented here yet.

`server/` — OpenAI-compatible bridge in front of Riva (see its README; env
overrides; options documented for LAN clients).

Planned next: streaming passthrough of Riva's `/v1/audio/synthesize_online`
(raw PCM chunks), Lane B job endpoints, Lane C show endpoint once ADR-0009
lands.
