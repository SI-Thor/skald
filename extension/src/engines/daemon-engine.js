// skald — daemon engine: OpenAI-compatible local TTS at localhost:8000.
//
// All HTTP goes through the background page ('skald:daemon-fetch' proxy,
// see background.js) because the content-script origin cannot fetch the
// daemon directly (CORS) — disclosed v0 deviation, see README.
//
// init() probes GET /v1/voices; on any failure the engine marks itself
// unavailable (the control bar shows it greyed out as "unreachable").
// speak() POSTs /v1/audio/speech and plays the returned bytes through a
// data-URL <audio> element with client-side playbackRate (pitch preserved)
// — speed is never requested from the daemon in v0, so it can never be
// double-applied; the ADR's "synthesis-time speed hint" is deferred until
// the daemon exists and we know whether it scales better.

'use strict';

import { Engine, clamp } from './engine.js';

export const DAEMON_BASE_URL = 'http://localhost:8000';
export const DEFAULT_MODEL = 'kokoro'; // placeholder until the daemon registry exists

export class DaemonEngine extends Engine {
  constructor(baseUrl = DAEMON_BASE_URL) {
    super({ id: 'daemon', label: 'skald daemon' });
    this.baseUrl = baseUrl;
    this._voices = [];
    this._available = false;
    this._probed = false;
    this._audio = null;
    this._gen = 0;
  }

  get available() {
    return this._available;
  }

  async init() {
    this._probed = true;
    this._available = false;
    this._voices = [];
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
    const api = typeof browser !== 'undefined' ? browser : chrome;
    const msg = { type: 'skald:daemon-fetch', path, method, headers: {} };
    if (body != null) {
      msg.headers['content-type'] = 'application/json';
      msg.bodyText = JSON.stringify(body);
    }
    let res;
    try {
      res = await api.runtime.sendMessage(msg);
    } catch (err) {
      return { ok: false, status: 0, error: String((err && err.message) || err) };
    }
    return res || { ok: false, status: 0, error: 'no response from background' };
  }

  speak(text, opts, handlers) {
    const run = async () => {
      if (!this._probed) await this.init();
      if (!this._available) {
        handlers.onerror &&
          handlers.onerror(
            new Error('skald daemon unreachable (localhost:8000) — switch engine or start the daemon')
          );
        return;
      }
      const gen = ++this._gen;
      const o = opts || {};
      const body = {
        model: o.model || DEFAULT_MODEL,
        input: text,
        voice: o.voiceId || (this._voices[0] && this._voices[0].id) || 'default',
        response_format: 'wav',
        pitch: clamp(o.pitch, 0.5, 2, 1), // extension field; daemon may ignore
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
      const audio = new Audio(`data:${mime};base64,${res.bodyBase64}`);
      this._audio = audio;
      audio.playbackRate = clamp(o.rate, 0.25, 4, 1); // client-side speed, ADR-0004
      audio.preservesPitch = true; // pitch preserved while rate scales
      if (typeof audio.mozPreservesPitch === 'boolean') audio.mozPreservesPitch = true;
      audio.volume = clamp(o.volume, 0, 1, 1);
      audio.onended = () => {
        if (gen !== this._gen) return;
        this._audio = null;
        handlers.onend && handlers.onend();
      };
      audio.onerror = () => {
        if (gen !== this._gen) return;
        this._audio = null;
        handlers.onerror && handlers.onerror(new Error('daemon audio playback failed'));
      };
      audio.play().catch((err) => {
        if (gen !== this._gen) return;
        handlers.onerror && handlers.onerror(err);
      });
    };
    run().catch((err) => {
      handlers.onerror && handlers.onerror(err instanceof Error ? err : new Error(String(err)));
    });
  }

  stop() {
    this._gen++;
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
    const audio = this._audio;
    if (audio && !audio.paused && !audio.ended) {
      try {
        audio.pause();
        return true;
      } catch {
        /* fall through */
      }
    }
    return false;
  }

  resume() {
    const audio = this._audio;
    if (audio && audio.paused && !audio.ended) {
      try {
        const p = audio.play();
        if (p && p.catch) p.catch(() => {});
        return true;
      } catch {
        /* fall through */
      }
    }
    return false;
  }

  setVolume(volume) {
    if (this._audio) this._audio.volume = clamp(volume, 0, 1, 1);
  }
}

/** Tolerant mapping of a /v1/voices payload into the engine voice shape. */
export function normalizeVoices(payload) {
  let list = null;
  if (Array.isArray(payload)) list = payload;
  else if (payload && Array.isArray(payload.voices)) list = payload.voices;
  else if (payload && Array.isArray(payload.data)) list = payload.data;
  if (!list) return [];
  return list
    .map((v) => ({
      id: String(v.id != null ? v.id : v.voice != null ? v.voice : v.name != null ? v.name : ''),
      name: String(v.name != null ? v.name : v.id != null ? v.id : v.voice != null ? v.voice : ''),
      lang: v.language || v.lang || null,
      tier: v.tier || null,
    }))
    .filter((v) => v.id);
}
