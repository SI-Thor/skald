# systemd deployment

Two layers:

- `skald-daemon.service` — **system** service: the daemon itself, boot-persistent.
- `user/skald-smoke.{service,timer}` — **user** units: the hourly ASR smoke check
  (ADR-0012). The agent repo carries the files; the **director installs and
  enables them after review** — never enable on the live system from a worktree.

## The daemon (system service, already deployed)

    sudo cp skald-daemon.service /etc/systemd/system/
    sudo systemctl daemon-reload && sudo systemctl enable --now skald-daemon
    systemctl is-active skald-daemon && curl -s localhost:8000/v1/health

Note: binds 0.0.0.0 (LAN-reachable, unauthenticated) — fine for home lab;
add auth/reverse-proxy before client sites (ADR-0008 trust boundary tile).
`Restart=always`. The daemon binds 0.0.0.0:8000 on purpose (LAN harness).

## The hourly smoke check (user units, ADR-0012)

What it does: every hour, run
`~/src/skald/.venv-asr/bin/python ~/src/skald/daemon/server/test_smoke.py --require-asr`
— health, voices, a synthesis, and a **whisper round-trip** ("working audio"
means the ASR hears it, not that the HTTP status was 200). Pass/fail and the
heard text land in the journal; nothing auto-restarts on failure (the journal
line is the alert; restart decisions belong to a human — ADR-0012).

Install (as the daemon user, once — the director does this):

    mkdir -p ~/.config/systemd/user
    cp user/skald-smoke.service user/skald-smoke.timer ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now skald-smoke.timer

Run once immediately and read it:

    systemctl --user start skald-smoke.service
    journalctl --user -t skald-smoke -n 50        # pass: SMOKE-ALL-OK + "whisper heard: ..."
    systemctl --user list-timers skald-smoke.timer

Notes:

- **Linger** so the check runs right after boot without a login session:
  `sudo loginctl enable-linger $USER` (one-time).
- `--require-asr` makes a missing/broken whisper a FAIL — a production check
  that silently skips is not a check (the 2026-10-29a→b saga is why).
- `smoke_out.wav` is written to `~/.local/state/skald-smoke/`, never the repo.
- The 5-minute timeout reflects measured contention: a one-sentence synthesis
  took 10–22 s at GPU 97% (`docs/research/2026-10-30-lan-latency-under-load.md`).
