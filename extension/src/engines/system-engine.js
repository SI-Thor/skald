// skald — system voices engine, backed by window.speechSynthesis.

'use strict';

import { Engine, clamp } from './engine.js';

const VOICES_TIMEOUT_MS = 1500;

export class SystemEngine extends Engine {
  constructor() {
    super({ id: 'system', label: 'System voices' });
    this._voices = null; // raw SpeechSynthesisVoice[]
    this._gen = 0;
    this._current = null; // keep utterance referenced (GC bug workaround)
  }

  _synth() {
    return typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  }

  async init() {
    this._voices = await this._waitForVoices();
    return true; // speechSynthesis missing surfaces as onerror at speak time
  }

  _waitForVoices() {
    const synth = this._synth();
    if (!synth || typeof synth.getVoices !== 'function') return Promise.resolve([]);
    const now = synth.getVoices() || [];
    if (now.length) return Promise.resolve(now);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve((this._synth() && this._synth().getVoices()) || []);
      };
      const timer = setTimeout(finish, VOICES_TIMEOUT_MS);
      try {
        synth.addEventListener('voiceschanged', finish, { once: true });
      } catch {
        finish();
      }
    });
  }

  async listVoices() {
    if (!this._voices) this._voices = await this._waitForVoices();
    return this._voices.map((v) => ({
      id: v.voiceURI || v.name,
      name: `${v.name} (${v.lang})`,
      lang: v.lang || null,
    }));
  }

  speak(text, opts, handlers) {
    const synth = this._synth();
    if (!synth) {
      handlers.onerror && handlers.onerror(new Error('speechSynthesis unavailable'));
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = clamp(opts && opts.rate, 0.1, 10, 1);
    utter.volume = clamp(opts && opts.volume, 0, 1, 1);
    utter.pitch = clamp(opts && opts.pitch, 0, 10, 1);
    const voiceId = opts && opts.voiceId;
    if (voiceId) {
      const match = (synth.getVoices() || []).find(
        (v) => (v.voiceURI || v.name) === voiceId
      );
      if (match) utter.voice = match;
    }
    const gen = ++this._gen;
    utter.onboundary = (e) => {
      if (gen !== this._gen) return;
      handlers.onboundary && handlers.onboundary(e.charIndex || 0);
    };
    utter.onend = () => {
      if (gen !== this._gen) return;
      this._current = null;
      handlers.onend && handlers.onend();
    };
    utter.onerror = (e) => {
      if (gen !== this._gen) return;
      this._current = null;
      handlers.onerror && handlers.onerror(new Error(`speech error: ${e.error || 'unknown'}`));
    };
    this._current = { utter, gen };
    synth.speak(utter);
  }

  stop() {
    this._gen++;
    this._current = null;
    try {
      const synth = this._synth();
      synth && synth.cancel();
    } catch {
      /* ignore */
    }
  }

  pause() {
    try {
      const synth = this._synth();
      if (synth && synth.speaking && !synth.paused) {
        synth.pause();
        return true;
      }
    } catch {
      /* fall through */
    }
    return false;
  }

  resume() {
    try {
      const synth = this._synth();
      if (synth && synth.paused) {
        synth.resume();
        return true;
      }
    } catch {
      /* fall through */
    }
    return false;
  }
}
