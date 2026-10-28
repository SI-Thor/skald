# ADR 0004 — Extension control surface: draggable in-tab bar with live controls

- **Status:** Accepted direction (2026-10-28); two details still open (below)

## Context

The core complaint that started this project: in Read Aloud, "you have to turn it off
to even view the setting for voice type and speed." The owner reads actively and wants
to tune *while listening*, like adjusting a media player.

## Decision

The control surface is a floating mini-player bar injected into the page:

```
compact (default):
┌────────────────────────────────────────────────────────────────┐
│ ⠿  ⏮   ▶/⏸   ⏹   ⏭  │ 🔈 ───●──  │ 0.8x ────●──── 1.6x │ ⋯  ✕ │
└────────────────────────────────────────────────────────────────┘

⋯ expands a second line, then a third — the main row never hides:
│ Engine ▾ [System / skald daemon / Cloud]   Voice ▾ [name]      │
│ Pitch ──●──   Save as defaults   Detach to window ⧉   Options… │
```

Behavior:

- **Draggable** via the grip or any empty bar area; position remembered across sessions.
- **Lives in its tab** — not an always-on-top overlay; switch tabs and it stays with the
  article it is reading.
- **Detach to window** — one click turns it into a separate control window for
  cross-tab sessions. Both modes supported.
- **Everything is live**: speed, volume, voice, engine take effect immediately,
  mid-sentence, without stopping.
- Speed is applied client-side (`playbackRate`, pitch preserved) so the slider is
  instant on any engine; engine hint passed along for engines that scale better at
  synthesis time.
- No reader mode — reads the page as-is, with the current sentence highlighted.
- Reading starts from the article top, or from the current text selection if one exists.

## Open details (owner has not confirmed)

1. Skip granularity: sentence (Read Aloud default), paragraph, or both (e.g.
   shift-click = paragraph). Working assumption: sentence, paragraph variant soon after.
2. Profile switcher (📄 Paper / 📰 News / 📖 Story presets bundling engine + voice +
   speed): in v1 or deferred. It is cheap and matches the owner's multi-material
   listening, so the lean is *include*, but it is not confirmed.

## Consequences

- The bar is the product: if this surface is right, everything else is plumbing.
- Detached-window mode and in-tab mode share one implementation (same controls, two
  hosts), so behavior stays identical.
- For other installs: the bar's control set and rows are data-driven (defined in
  manifest-ish config), so technicians can reskin/re-map for client needs without
   touching playback logic.
