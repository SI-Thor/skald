# Browser smoke test — 5 minutes (owner or maintainer)

Preconditions (both should already be true on thor):
- `systemctl is-active skald-daemon riva...` → daemon :8000 healthy
- `curl -s localhost:8000/v1/health` → "ok"

1. Firefox → `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Pick `extension/manifest.json`
3. Open any article (Wikipedia is fine). Press **Alt+R** (or the skald toolbar button).
4. Expected: control bar appears; Mia's voice reads the article from the top
   (first utterance may take a beat); the current sentence highlights and scrolls.
5. Try: speed slider mid-sentence (rate changes without stopping), ⏮/⏭
   (sentence jumps), volume, ⋯ → Engine = "skald daemon" (should NOT show
   'unreachable'), voice dropdown (399 voices incl. emotion styles).
6. ✕ stops and closes; bar position is remembered on reload.

## Known v0 boundaries
- System-voices engine works even if the daemon is down (fallback by design).
- Live rate changes restart the current sentence (v0 semantics).
- "Detach to window" is a stub.

Report failures as issues with the browser console (Ctrl+Shift+J) filtered on [skald].
