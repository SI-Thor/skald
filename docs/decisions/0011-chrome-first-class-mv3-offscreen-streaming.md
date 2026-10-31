# ADR 0011 — Chrome is a first-class target: service-worker background, offscreen audio, stream-first playback

- **Status:** Accepted (2026-10-30)
- **Context:** Skald's first user reads in **Chrome on the ProArt** (Windows 11;
  Firefox is not installed there) against the daemon on the Thor over the LAN
  (`http://192.168.0.78:8000`). The extension was written Firefox-first
  (MV3 event page, inline content-script `<audio>`). Chrome MV3 differs in
  three load-bearing ways: the background is a **service worker** that Chrome
  kills after ~30 s idle (no state may live only in globals, no DOM), the
  service worker **cannot play audio** and content-script audio is subject to
  the page's autoplay policy, and Chrome **rejects** manifests carrying
  `background.scripts` (the owner's first load errored on exactly that).
  Separately, the Thor is shared: under another tenant's GPU load a whole-WAV
  synthesis took 1.4–4.9 s per sentence (measured from the ProArt,
  2026-10-30), so "click → first sentence" needed a plan that does not wait
  for a full sentence of audio to exist.

## Decision

1. **One source tree, per-browser dist manifests.** `extension/manifest.json`
   stays the canonical both-browsers statement; `extension/build.sh` writes
   `dist/chrome/` (no `background.scripts`, no `browser_specific_settings`,
   `service_worker` + `offscreen` permission + `minimum_chrome_version` 116)
   and `dist/firefox/` (`background.scripts` event page, gecko id, no
   `offscreen`/`service_worker`/`minimum_chrome_version`). Installs point at
   the dists — never at the source tree, which Chrome refuses to load.
2. **Service-worker-safe background.** All listeners register synchronously at
   the top level. Cross-event state (CSS-injected tabs, playId→tabId audio
   routes) lives in `storage.session` (Chrome 102+/Firefox 115+) with an
   in-memory fast path, so a killed worker resumes correctly.
3. **Audio plays in an offscreen document on Chrome** (reason
   `AUDIO_PLAYBACK`): the service worker brokers `skald:audio-play` requests
   to `offscreen.html`, routes lifecycle events (`skald:audio-event`) back to
   the originating tab via the session route map, and never touches audio
   itself. Firefox keeps the inline content-script `<audio>` path.
   Content scripts cannot see `chrome.offscreen` (extension-context APIs), so
   the engine probes the capability through the background
   (`skald:offscreen-capability`) once per `init()` — one implementation
   serves both browsers.
4. **Stream-first playback for cold sentences at rate 1× (Chrome).** The
   daemon's `/v1/audio/speech/stream` (chunked PCM proxy of Riva's
   `synthesize_online`) starts the offscreen AudioContext with the first
   chunk instead of after the whole sentence. WebAudio scales pitch with
   rate, so rate ≠ 1× (and Firefox, and any stream failure) uses the
   whole-WAV `<audio>` path where `preservesPitch` holds. A failed stream
   retries the sentence once as a whole WAV — a missing endpoint on an older
   daemon degrades to slower start, never to silence.
5. **Synthesis cache + 2-sentence prefetch** (`main.js` calls
   `engine.prefetch()` as each sentence starts): under contention the only
   way the *next* sentence starts instantly is if it was synthesized during
   this one's playback. Lookahead stays at 2 — Riva serializes requests, so
   more lookahead only queues behind itself.

## Consequences

- Chrome installs survive browser restarts via "Load unpacked" on
  `dist/chrome/` (developer mode); no store signing is involved.
- `validate.sh` checks both dist manifests and runs the browserless engine
  choreography tests (`node --test extension/test/`), so the message flow
   — the part no browser on the Thor can exercise — is regression-tested.
- The stream path sends no `pitch`/`rate` (PCM is played as synthesized);
  pitch and speed variations always take the whole-WAV path with
  client-side `playbackRate` (ADR-0004 semantics preserved).
- Latency evidence and the contention findings live in
  `docs/research/2026-10-30-lan-latency-under-load.md`.
