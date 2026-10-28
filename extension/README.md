# extension/ — the skald Firefox control surface

Status: not started (Phase 1). Spec: ADR-0004 (control surface), ADR-0003 (two lanes).

Will contain the Manifest V3 Firefox extension: content-script control bar (draggable,
live controls, ⋯ expander, detach-to-window), page text extraction + sentence
segmentation, highlight/auto-scroll, engine dropdown (system voices / skald daemon /
optional cloud), and the "Read now" client for the daemon's `/v1/audio/speech`.

Signing: release Firefox requires signed extensions; we self-distribute via free AMO
signing (`web-ext sign`) — see ROADMAP Phase 1.
