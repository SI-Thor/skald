# Browser smoke test — 5 minutes (owner or maintainer)

Preconditions (both should already be true on thor):
- `systemctl is-active skald-daemon` → active
- `sudo docker ps` → skald-riva up
- `curl -s localhost:8000/v1/health` → "ok"

## Chrome (the owner's browser — persistent install)

One-time install (survives restarts; full steps in README.md §"Loading it — Chrome"):

1. On the Thor: `cd extension && ./build.sh`, copy `extension/dist/chrome/`
   to the Windows machine (e.g. `C:\Users\casey\skald-extension`).
2. `chrome://extensions` → Developer mode ON → **Load unpacked** → pick that
   folder. The card must show **no Errors** (an error naming
   `background.scripts` means the source tree was loaded, not `dist/chrome`).
3. skald toolbar icon → right-click → Options → Server URL
   `http://192.168.0.78:8000` → **Test connection** (green) → **Grant
   permission** (green).

Every-session checks:

4. Open any article. Press **Alt+R** (or the toolbar button).
5. Expected: control bar appears; the FIRST sentence starts fast (streamed
   — under Thor load this is the difference between ~0.5 s and multi-second
   waits); current sentence highlights and scrolls; later sentences start
   instantly (prefetched 2 ahead while the previous one plays).
6. Voice box: ⋯ → Engine = "skald daemon" (NOT 'unreachable') → Voice
   dropdown lists hundreds of friendly names ("Mia", "Mia · Calm", …).
   Pick one mid-read: the box KEEPS showing the picked voice and the next
   sentence uses it (this was owner bug 1 — fixed 2026-10-30).
7. Speed slider mid-read: the readout follows the thumb AND stays at the
   chosen value as sentences advance (owner bug 2 — the readout used to
   snap back to "1.0x"). Audio pitch stays natural at 1.2–2×.
8. Pause/resume, ⏮/⏭, volume slider — all live.
9. Service-worker survival: leave the tab idle ~40 s (Chrome suspends the
   background worker), then press ⏭ — the next sentence must still speak
   and the highlight must still move.
10. (Optional, refusal recovery) If a voice ever gets refused by the engine,
    a notice strip appears in the bar ("…was refused — using Mia") and
    reading CONTINUES on the fallback voice instead of going silent.
11. ✕ stops and closes; bar position is remembered on reload.

## Firefox

1. Firefox → `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Pick `extension/dist/firefox/manifest.json` (built by `./build.sh`)
3. Steps 4–8, 11 above (Firefox plays whole-WAV inline; no offscreen
   document, no stream path).
4. From another machine: same dist install, then Options → server URL
   `http://<thor-ip>:8000` → Test connection → Grant permission.

## Known v0 boundaries

- System-voices engine works even if the daemon is down (fallback by design).
- Live rate changes restart the current sentence (v0 semantics) — streamed
  playback is only used at 1.0×; other speeds synthesize the whole WAV.
- "Detach to window" is a stub.

Report failures as issues with the browser console (Ctrl+Shift+J) filtered
on [skald].
