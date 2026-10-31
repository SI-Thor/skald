// skald — daemon engine: OpenAI-compatible local TTS (default :8000).
//
// All whole-file HTTP goes through the background context ('skald:daemon-fetch'
// proxy, see background.js) because the content-script origin cannot fetch the
// daemon directly (CORS) — disclosed v0 deviation, see README.
//
// init() probes GET /v1/voices; on any failure the engine marks itself
// unavailable (the control bar shows it greyed out as "unreachable").
//
// speak() picks one of three playback strategies (ADR-0011):
//   1. cache hit      — the sentence was prefetched (or replayed): play the
//                       stored WAV immediately, no synthesis wait at all.
//   2. stream (Chrome, rate 1× only) — POST the daemon's /v1/audio/speech/
//                       /stream through the offscreen player: audio starts
//                       with the first PCM chunk (~0.2–0.9 s under Thor load)
//                       instead of after the whole sentence (1.5–7 s).
//   3. whole WAV      — POST /v1/audio/speech, play the returned bytes.
//                       Always the path in Firefox; in Chrome whenever a
//                       blob is already at hand or rate ≠ 1 (pitch-preserving
//                       speed needs an <audio> element, not WebAudio).
// Whole-WAV results land in the cache; prefetch() fills it 2 sentences ahead
// so the steady state is strategy 1.
//
// Playback itself runs in the content script (data-URL <audio> with
// client-side playbackRate, pitch preserved) on Firefox, and in Chrome in the
// extension's offscreen document (Chrome's service worker has no DOM and the
// page's autoplay policy can block content-script audio on a fresh tab).

'use strict';

import { Engine, clamp } from './engine.js';
import { loadSettings } from "../store.js";

export const DAEMON_BASE_URL = 'http://localhost:8000';
export const DEFAULT_MODEL = 'kokoro'; // placeholder until the daemon registry exists
const CACHE_LIMIT = 16; // sentences kept; seek-back and param-restart replays

/**
 * Offscreen playback needs chrome.offscreen + chrome.runtime.getContexts —
 * APIs that exist ONLY in extension pages / the service worker, never in a
 * content script (the engine runs in one). So the capability is probed from
 * the background context ('skald:offscreen-capability'), once per init().
 */
function offscreenSupportedHere(engine) {
  return engine._offscreenCapable === true;
}

export class DaemonEngine extends Engine {
  constructor(baseUrl = DAEMON_BASE_URL) {
    super({ id: 'daemon', label: 'skald daemon' });
    this.baseUrl = baseUrl;
    this._voices = [];
    this._available = false;
    this._probed = false;
    this._audio = null; // inline <audio> (Firefox / fallback)
    this._gen = 0;
    this._mode = null; // 'inline' | 'offscreen'
    this._playId = null;
    this._playing = false;
    this._paused = false;
    this._playKind = null; // 'blob' | 'stream' — what the active play is
    this._active = null; // { text, voice, o, handlers, gen, streamRetried }
    this._offscreenCapable = false; // answered by the background (see above)
    this._cache = new Map(); // key → { mime, bodyBase64 }
    this._pending = new Set(); // keys with a prefetch in flight
    this._onAudioEvent = (msg) => {
      if (!msg || msg.type !== 'skald:audio-event') return;
      if (msg.playId !== this._playId) return;
      if (msg.event === 'ended') {
        this._playing = false;
        this._paused = false;
        this._playId = null;
        this._playKind = null;
        this._handlers && this._handlers.onend && this._handlers.onend();
      } else if (msg.event === 'error') {
        const wasStream = this._playKind === 'stream';
        const active = this._active;
        this._playing = false;
        this._paused = false;
        this._playId = null;
        this._playKind = null;
        // A failed stream (endpoint absent on an older daemon, AudioContext
        // autoplay-gated, …) must not kill the sentence: retry once as a
        // whole WAV — slower start, same words.
        if (wasStream && active && !active.streamRetried && active.gen === this._gen) {
          active.streamRetried = true;
          this._speakWhole(
            active.text,
            active.voice,
            active.o,
            active.handlers,
            active.gen,
            this._cacheKey(active.text, active.o)
          )
            .catch((err) => {
              active.handlers.onerror &&
                active.handlers.onerror(
                  err instanceof Error ? err : new Error(String(err))
                );
            });
          return;
        }
        this._handlers && this._handlers.onerror &&
          this._handlers.onerror(new Error(String(msg.error || 'offscreen playback failed')));
      }
    };
    const api = typeof browser !== 'undefined' ? browser : chrome;
    if (api && api.runtime && api.runtime.onMessage) {
      api.runtime.onMessage.addListener(this._onAudioEvent);
    }
  }

  get available() {
    return this._available;
  }

  async init() {
    // The daemon may live anywhere on the LAN (LAN harness requirement):
    // the configured server URL in settings is the single source of truth.
    try {
      const settings = await loadSettings();
      if (settings.serverUrl) this.baseUrl = String(settings.serverUrl).replace(/\/+$/, '');
    } catch (err) {
      console.warn('[skald] serverUrl load failed, using default:', err);
    }
    if (!/^https?:\/\//i.test(this.baseUrl)) this.baseUrl = DAEMON_BASE_URL;
    this._probed = true;
    this._available = false;
    this._voices = [];
    try {
      const cap = await this._rawSend({ type: 'skald:offscreen-capability' });
      this._offscreenCapable = !!(cap && cap.ok);
    } catch {
      this._offscreenCapable = false;
    }
    try {
      const res = await this._request('/v1/voices', 'GET');
      if (!res.ok) throw new Error(`voices probe failed: HTTP ${res.status || res.error || ''}`);
      const payload = res.bodyText ? JSON.parse(res.bodyText) : null;
      this._voices = normalizeVoices(payload);
      this._available = true;
    } catch (err) {
      console.warn('[skald] daemon unavailable:', (err && err.message) || err);
      this._available = false;
    }
    return this._available;
  }

  async listVoices() {
    if (!this._probed) await this.init();
    return this._voices.slice();
  }

  async _request(path, method = 'GET', body = null) {
    const msg = { type: 'skald:daemon-fetch', baseUrl: this.baseUrl, path, method, headers: {} };
    if (body != null) {
      msg.headers['content-type'] = 'application/json';
      msg.bodyText = JSON.stringify(body);
    }
    return this._rawSend(msg);
  }

  async _rawSend(msg) {
    const api = typeof browser !== 'undefined' ? browser : chrome;
    let res;
    try {
      res = await api.runtime.sendMessage(msg);
    } catch (err) {
      return { ok: false, status: 0, error: String((err && err.message) || err) };
    }
    return res || { ok: false, status: 0, error: 'no response from background' };
  }

  // --- synthesis cache / prefetch ------------------------------------------------

  _cacheKey(text, o) {
    return `${o.voiceId || 'default'}|${clamp(o.pitch, 0.5, 2, 1)}|${text}`;
  }

  _cacheStore(key, mime, bodyBase64) {
    if (this._cache.has(key)) this._cache.delete(key); // refresh LRU position
    this._cache.set(key, { mime, bodyBase64 });
    while (this._cache.size > CACHE_LIMIT) this._cache.delete(this._cache.keys().next().value);
  }

  /**
   * Ask for a sentence's audio ahead of time (main.js calls this ~2 sentences
   * ahead during playback). Fire-and-forget: failures are logged, never
   * thrown — a missed prefetch just means speak() synthesizes on demand.
   */
  prefetch(text, opts) {
    if (!this._available || !text) return;
    const o = opts || {};
    const key = this._cacheKey(text, o);
    if (this._cache.has(key) || this._pending.has(key)) return;
    this._pending.add(key);
    const body = {
      model: o.model || DEFAULT_MODEL,
      input: text,
      voice: o.voiceId || (this._voices[0] && this._voices[0].id) || 'default',
      response_format: 'wav',
      pitch: clamp(o.pitch, 0.5, 2, 1),
    };
    this._request('/v1/audio/speech', 'POST', body)
      .then((res) => {
        if (res.ok && res.bodyBase64) {
          this._cacheStore(key, (res.contentType || 'audio/wav').split(';')[0].trim() || 'audio/wav', res.bodyBase64);
        }
      })
      .catch((err) => console.warn('[skald] prefetch failed:', err))
      .finally(() => this._pending.delete(key));
  }

  // --- playback -------------------------------------------------------------------

  speak(text, opts, handlers) {
    const run = async () => {
      if (!this._probed) await this.init();
      if (!this._available) {
        handlers.onerror &&
          handlers.onerror(
            new Error(`skald daemon unreachable (${this.baseUrl}) — check server URL in options, or switch engine`)
          );
        return;
      }
      const gen = ++this._gen;
      this._handlers = handlers;
      const o = opts || {};
      const voice = o.voiceId || (this._voices[0] && this._voices[0].id) || 'default';
      const rate = clamp(o.rate, 0.25, 4, 1);
      const key = this._cacheKey(text, o);
      this._active = { text, voice, o, handlers, gen, streamRetried: false };

      const cached = this._cache.get(key);
      if (cached) {
        // Refresh LRU position: what is about to play stays longest.
        this._cache.delete(key);
        this._cache.set(key, cached);
        await this._startBlob(cached.mime, cached.bodyBase64, o, handlers, gen);
        return;
      }

      // Cold sentence on a contended Thor: stream so the first chunk starts
      // the player (Chrome offscreen only — the stream path is WebAudio,
      // which scales pitch with rate, so keep rate ≠ 1 on the blob path).
      if (offscreenSupportedHere(this) && rate === 1) {
        const started = await this._startStream(text, voice, o, handlers, gen);
        if (started) return;
        if (gen !== this._gen) return; // superseded while setting up
      }

      await this._speakWhole(text, voice, o, handlers, gen, key);
    };
    run().catch((err) => {
      handlers.onerror && handlers.onerror(err instanceof Error ? err : new Error(String(err)));
    });
  }

  /** Synthesize the whole WAV (or serve it from the cache) and play it. */
  async _speakWhole(text, voice, o, handlers, gen, key) {
    const cached = key && this._cache.get(key);
    if (cached) {
      await this._startBlob(cached.mime, cached.bodyBase64, o, handlers, gen);
      return;
    }
    const body = {
      model: o.model || DEFAULT_MODEL,
      input: text,
      voice,
      response_format: 'wav',
      pitch: clamp(o.pitch, 0.5, 2, 1),
    };
    const res = await this._request('/v1/audio/speech', 'POST', body);
    if (gen !== this._gen) return; // superseded while synthesizing
    if (!res.ok || !res.bodyBase64) {
      handlers.onerror &&
        handlers.onerror(
          new Error(`daemon speech failed: HTTP ${res.status}${res.error ? ` (${res.error})` : ''}`)
        );
      return;
    }
    const mime = (res.contentType || 'audio/wav').split(';')[0].trim() || 'audio/wav';
    if (key) this._cacheStore(key, mime, res.bodyBase64);
    await this._startBlob(mime, res.bodyBase64, o, handlers, gen);
  }

  _startBlob(mime, bodyBase64, o, handlers, gen) {
    if (gen !== this._gen) return Promise.resolve();
    if (offscreenSupportedHere(this)) {
      return this._playOffscreen({
        mode: 'blob',
        mime,
        bodyBase64,
        volume: clamp(o.volume, 0, 1, 1),
        rate: clamp(o.rate, 0.25, 4, 1),
      }, handlers, gen);
    }
    return Promise.resolve(this._playInline(mime, bodyBase64, o, handlers, gen));
  }

  _startStream(text, voice, o, handlers, gen) {
    return this._playOffscreen({
      mode: 'stream',
      url: `${this.baseUrl}/v1/audio/speech/stream`,
      body: { model: o.model || DEFAULT_MODEL, input: text, voice },
      volume: clamp(o.volume, 0, 1, 1),
      rate: 1,
    }, handlers, gen);
  }

  async _playOffscreen(play, handlers, gen) {
    const api = typeof browser !== 'undefined' ? browser : chrome;
    const playId = `p${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let ack;
    try {
      ack = await api.runtime.sendMessage({ type: 'skald:audio-play', playId, ...play });
    } catch (err) {
      ack = { ok: false, error: String((err && err.message) || err) };
    }
    if (gen !== this._gen) return false; // superseded while the worker set up
    if (!ack || !ack.ok) {
      console.warn('[skald] offscreen play rejected:', ack && ack.error, '— falling back to inline');
      if (play.mode === 'blob') this._playInline(play.mime, play.bodyBase64, play, handlers, gen);
      return play.mode === 'blob'; // a blob fell back inline; a stream cannot
    }
    this._mode = 'offscreen';
    this._playId = playId;
    this._playKind = play.mode;
    this._playing = true;
    this._paused = false;
    return true;
  }

  _playInline(mime, bodyBase64, o, handlers, gen) {
    const audio = new Audio(`data:${mime};base64,${bodyBase64}`);
    this._audio = audio;
    this._mode = 'inline';
    this._playKind = 'blob';
    this._playing = true;
    this._paused = false;
    audio.playbackRate = clamp(o.rate, 0.25, 4, 1); // client-side speed, ADR-0004
    audio.preservesPitch = true; // pitch preserved while rate scales
    if (typeof audio.mozPreservesPitch === 'boolean') audio.mozPreservesPitch = true;
    audio.volume = clamp(o.volume, 0, 1, 1);
    audio.onended = () => {
      if (gen !== this._gen) return;
      this._playing = false;
      this._paused = false;
      this._audio = null;
      handlers.onend && handlers.onend();
    };
    audio.onerror = () => {
      if (gen !== this._gen) return;
      this._playing = false;
      this._paused = false;
      this._audio = null;
      handlers.onerror && handlers.onerror(new Error('daemon audio playback failed'));
    };
    audio.play().catch((err) => {
      if (gen !== this._gen) return;
      this._playing = false;
      this._audio = null;
      handlers.onerror && handlers.onerror(err);
    });
  }

  _control(action, value) {
    const api = typeof browser !== 'undefined' ? browser : chrome;
    api.runtime
      .sendMessage({ type: 'skald:audio-control', action, value })
      .catch(() => {});
  }

  stop() {
    this._gen++;
    this._handlers = null;
    this._active = null;
    this._playing = false;
    this._paused = false;
    this._playId = null;
    this._playKind = null;
    if (this._mode === 'offscreen') this._control('stop');
    this._teardownAudio();
  }

  _teardownAudio() {
    const audio = this._audio;
    if (!audio) return;
    this._audio = null;
    try {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      if (typeof audio.load === 'function') audio.load();
    } catch {
      /* ignore */
    }
  }

  pause() {
    if (!this._playing || this._paused) return false;
    if (this._mode === 'offscreen') {
      this._paused = true;
      this._control('pause');
      return true;
    }
    const audio = this._audio;
    if (audio && !audio.paused && !audio.ended) {
      try {
        audio.pause();
        this._paused = true;
        return true;
      } catch {
        /* fall through */
      }
    }
    return false;
  }

  resume() {
    if (!this._paused) return false;
    if (this._mode === 'offscreen') {
      this._paused = false;
      this._control('resume');
      return true;
    }
    const audio = this._audio;
    if (audio && audio.paused && !audio.ended) {
      try {
        const p = audio.play();
        if (p && p.catch) p.catch(() => {});
        this._paused = false;
        return true;
      } catch {
        /* fall through */
      }
    }
    return false;
  }

  setVolume(volume) {
    const v = clamp(volume, 0, 1, 1);
    if (this._mode === 'offscreen' && this._playing) this._control('volume', v);
    if (this._audio) this._audio.volume = v;
  }

  /** Called when the app closes (main.js): drop the event listener. */
  dispose() {
    this.stop();
    const api = typeof browser !== 'undefined' ? browser : chrome;
    try {
      api.runtime.onMessage.removeListener(this._onAudioEvent);
    } catch {
      /* already gone */
    }
  }
}

/** Tolerant mapping of a /v1/voices payload into the engine voice shape. */
/**
 * Map a /v1/voices payload to the engine's voice shape.
 * The skald daemon sends Riva-parsed entries:
 *   { voice_id: "Magpie-Multilingual.EN-US.Mia.Calm", locale: "EN-US",
 *     speaker: "Mia", style: "Calm", source: "riva" }
 * OpenAI-ish servers send { id, name }. We accept both, build a human name
 * from speaker/style when only the daemon shape is present, and dedupe.
 * (Before 2026-10-30 this only looked at id/voice/name — the daemon's
 * voice_id key was missed, the dropdown came up EMPTY, and speak() fell
 * back to a literal voice "default" that Riva rejects with 400.)
 */
export function normalizeVoices(payload) {
  let list = null;
  if (Array.isArray(payload)) list = payload;
  else if (payload && Array.isArray(payload.voices)) list = payload.voices;
  else if (payload && Array.isArray(payload.data)) list = payload.data;
  if (!list) return [];
  const out = [];
  const seen = new Set();
  for (const v of list) {
    const id = String(
      v.id != null ? v.id :
      v.voice_id != null ? v.voice_id :
      v.voice != null ? v.voice :
      v.name != null ? v.name : ''
    );
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let name = v.name != null ? String(v.name) : '';
    if (!name && v.speaker != null) {
      const style = v.style != null && v.style !== 'Default' ? ` · ${v.style}` : '';
      name = `${v.speaker}${style}`;
    }
    out.push({
      id,
      name: name || id,
      lang: v.language || v.lang || v.locale || null,
      tier: v.tier || v.locale || null,
    });
  }
  return out;
}
