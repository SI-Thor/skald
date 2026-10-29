# systemd deployment

`skald-daemon.service` — installs the daemon as a boot-persistent service:

    sudo cp skald-daemon.service /etc/systemd/system/
    sudo systemctl daemon-reload && sudo systemctl enable --now skald-daemon
    systemctl is-active skald-daemon && curl -s localhost:8000/v1/health

Note: binds 0.0.0.0 (LAN-reachable, unauthenticated) — fine for home lab;
add auth/reverse-proxy before client sites (ADR-0008 trust boundary tile).
`Restart=always` (not unless-stopped — docker vocabulary, not systemd).
