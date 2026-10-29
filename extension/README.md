# extension/ — the skald Firefox control surface

Status: **v0 skeleton implemented** (Phase 1). Spec: ADR-0004 (control surface),
ADR-0002 / `docs/architecture.md` (daemon contract).

Manifest V3 Firefox extension (classic event-page background, no service
worker, no build step, vanilla ES modules, zero dependencies). Requires
**Firefox 140+** (CSS Custom Highlight API for sentence highlighting).

## What it does

Press **Alt+R** (or click the toolbar button) on any article page. The
extension extracts the page's main content (or your current text selection),
segments it into sentences, and starts reading aloud with a floating,
draggable mini-player bar — current sentence highlighted and scrolled into
view. No reader mode, no telemetry: the page is read as-is.

## Loading it

- **about:debugging**: open `about:debugging#/runtime/this-firefox` →
  *Load Temporary Add-on…* → pick `extension/manifest.json`. Temporary
  installs reset on browser restart.
- **web-ext**: `npx web-ext run --source-dir extension/` (launches a clean
  Firefox profile with the extension loaded).

Then open any article, press Alt+R.

## What works (implemented)

- **Extraction** (`src/extraction.js`): Readability-lite main-content scoring
  (paragraph text mass × link density, container bonuses for
  `<article>`/`<main>`/content-ish ids/classes), selection-aware (a selection
  of ≥3 chars wins over the article), builds a text-node offset map so every
  sentence maps back to a live DOM `Range`.
- **Segmentation** (`src/segmenter.js`): abbreviation/initial guards
  (Mr., Dr., e.g., U.S., John A.), terminal + closing-quote handling,
  ellipsis, lowercase-continuation rule, `\n` paragraph boundaries as hard
  breaks, and recursive hard-splitting of run-ons (>480 chars) at clause
  separators. Pure module, node-testable.
- **Player** (`src/player.js`): sentence cursor with auto-advance, prev/next/
  stop, pause/resume mid-utterance, generation-guarded engine callbacks,
  150 ms-debounced restart on live parameter changes.
- **Control bar** (`src/control-bar/`): closed shadow DOM (`:host { all:
  initial }` + max z-index), compact dark 3-row layout per ADR-0004 —
  row 1: grip ⠿, ⏮, ▶/⏸, ⏹, ⏭, volume slider, speed slider with live
  0.5x–3.0x readout, ⋯, ✕; row 2: Engine + Voice dropdowns; row 3: Pitch
  slider, Save as defaults, Detach to window (disabled stub). ⋯ cycles
  1 → 2 → 0 expanded rows; main row never hides. Drag via grip or empty bar
  area with viewport clamping.
- **Engines** (`src/engines/`): `speak(text, opts, { onboundary, onend,
  onerror })` interface. System engine = `speechSynthesis` (with
  voiceschanged wait, utterance GC workaround, pause/resume). Daemon engine
  probes `GET /v1/voices` at `http://localhost:8000`, marks itself
  unavailable on failure (greyed "unreachable" in the dropdown, silent
  fallback to system voices), `POST /v1/audio/speech` audio played via
  data-URL `<audio>` with client-side `playbackRate` + `preservesPitch`.
- **Persistence** (`src/store.js`): engine, per-engine voice, rate, volume,
  pitch, bar position in `browser.storage.local`.
- **Background** (`background.js`): Alt+R command + toolbar click →
  `insertCSS` (highlight styles) + `executeScript` (bootstrap); CORS-free
  fetch proxy for all daemon traffic.

## What's stubbed / not yet built

- **Detach to window** — disabled stub button in row 3 (ADR-0004 behavior,
  needs a separate control window host; deferred).
- **Detached window** — stub (planned); the engine assumes an
  OpenAI-compatible `GET /v1/voices` + `POST /v1/audio/speech` (JSON
  `{ model, input, voice, response_format, pitch }`, audio bytes returned).
  It tolerates several voices-payload shapes and falls back cleanly when the
  daemon is down.
- **Word-level highlighting** — engine `onboundary` is wired through the
  interface but only sentence-level highlighting is rendered in v0.
- **Prefetch** (2–3 sentences ahead, per architecture.md) — not implemented.
- **Paragraph skip granularity, profile presets** — open details in
  ADR-0004, untouched.
- **Cloud engine** — dropdown lists System voices / skald daemon only.

## Disclosed deviations from the original plan (v0)

1. **Bar position** is stored in `browser.storage.local`, not `localStorage`
   (survives site-data clearing, consistent with the rest of the settings).
2. **Engine interface** takes a handlers object as the third argument of
   `speak()` (`speak(text, opts, { onboundary, onend, onerror })`) instead of
   an EventEmitter-style API.
3. **Live parameter changes restart the current sentence** (after a 150 ms
   debounce) rather than hot-swapping mid-utterance. Volume-only changes are
   applied live where the engine supports it (daemon audio element).
4. **Daemon traffic goes through the background page** (message-passing fetch
   proxy) to solve CORS from the content script.
5. **⏹ and ✕ both stop playback and close the bar** — no distinct
   "stop-but-keep-bar" state in v0.
6. **Detach to window** is a disabled stub (see above).

Additional note: the daemon's *synthesis-time speed hint* (ADR/architecture)
is intentionally not sent in v0 — speed is purely client-side
(`playbackRate`), so it can never be double-applied once the daemon exists.

Caveat on `use_extension_uri` in `web_accessible_resources`: carried over
from the plan to pin WAR resources to the stable `moz-extension://` origin
(needed for the content script's dynamic import of `src/main.js`). Current
MDN/Searchfox do not document the key; if a future Firefox treats it as a
manifest error rather than an ignorable extra property, remove it from
`manifest.json` — no code depends on it beyond that default behavior.

## Layout

```
manifest.json            MV3, permissions: activeTab/storage/scripting,
                         host_permissions: localhost:8000, Alt+R command,
                         web_accessible_resources for src/*, min Firefox 140
background.js            injection + daemon fetch proxy (event page)
content/loader.js        classic bootstrap → dynamic import of src/main.js
src/main.js              wiring: extract → segment → play → highlight → bar
src/extraction.js        Readability-lite extraction + selection, offset maps
src/segmenter.js         sentence segmentation (pure, node-testable)
src/player.js            sentence cursor, live params, debounced restart
src/store.js             browser.storage.local settings
src/engines/engine.js    engine interface + helpers
src/engines/system-engine.js   speechSynthesis engine
src/engines/daemon-engine.js   localhost:8000 OpenAI-compatible engine
src/control-bar/bar.js   shadow-DOM control bar (ADR-0004 layout)
src/control-bar/bar.css  bar styles (dark, compact)
src/control-bar/sliders.js    slider factory with live readouts
src/highlight.css        ::highlight(skald-sentence) styles
icons/icon.svg           vector source
icons/generate.js        dependency-free PNG encoder (zlib) — node icons/generate.js
icons/icon-{16,32,48,96}.png  generated
```

## Verification (what was checked without a browser)

- `node --check` passes on every JS file (ES modules checked via temporary
  `.mjs` copies).
- `node icons/generate.js` regenerates valid PNGs (verified with `file`).
- Ad-hoc node smoke tests exercised `segmenter.js` (abbreviations, initials,
  ellipsis, closers, paragraph boundaries, list markers, run-on splitting,
  offset integrity) and `player.js` with a fake engine (auto-advance,
  pause/resume, prev/next, debounced param restart, engine swap, stale
  callback guards, error surfacing). Both passed; scripts were deleted after.

Not checkable without a browser: content-script dynamic import of
`src/main.js`, shadow-DOM bar rendering/drag, Custom Highlight rendering,
`speechSynthesis` behavior, and the background proxy. Load via
about:debugging or `web-ext run` to exercise those.

## Signing

Release Firefox requires signed extensions; we self-distribute via free AMO
signing (`web-ext sign`) — see ROADMAP Phase 1.
