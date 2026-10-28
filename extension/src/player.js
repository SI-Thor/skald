// skald — the sentence cursor / playback orchestrator.
//
// Owns: which sentence is current, which engine speaks it, live parameter
// application, and the auto-advance loop. Pure browser/DOM-free logic except
// for timers — engines are injected, so this module is smoke-testable in
// Node with a fake engine.
//
// v0 semantics (disclosed deviation, see README): changing a non-volume
// parameter (rate, pitch, voice, engine) while playing restarts the current
// sentence after a 150 ms debounce. Volume-only changes are applied live
// without a restart when the engine supports it (daemon audio element) and
// otherwise take effect on the next sentence.

'use strict';

export const RESTART_DEBOUNCE_MS = 150;

export class Player {
  /**
   * @param {object} args
   * @param {object} args.engine  active engine (engines/*.js)
   * @param {{text:string}[]} [args.sentences]
   * @param {(state:object)=>void} [args.onChange]   status/index/total/opts/error
   * @param {(index:number, sentence:object)=>void} [args.onSentence]
   */
  constructor({ engine, sentences = [], onChange = () => {}, onSentence = () => {} }) {
    this._engine = engine || null;
    this._sentences = sentences;
    this._onChange = onChange;
    this._onSentence = onSentence;
    this._status = 'idle'; // idle | playing | paused | ended
    this._index = 0;
    this._gen = 0; // increments on every cancel — stale engine callbacks die
    this._opts = { rate: 1, volume: 1, pitch: 1, voiceId: null };
    this._error = null;
    this._midSentence = false; // engine suspended mid-utterance (resume-able)
    this._restartTimer = null;
  }

  get status() {
    return this._status;
  }

  get index() {
    return this._index;
  }

  get total() {
    return this._sentences.length;
  }

  get opts() {
    return { ...this._opts };
  }

  get state() {
    return {
      status: this._status,
      index: this._index,
      total: this.total,
      opts: this.opts,
      error: this._error,
    };
  }

  _emit() {
    try {
      this._onChange(this.state);
    } catch (err) {
      console.error('[skald] player onChange handler failed:', err);
    }
  }

  _clearRestartTimer() {
    if (this._restartTimer != null) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
  }

  _cancelSpeak() {
    this._clearRestartTimer();
    this._gen++;
    this._midSentence = false;
    try {
      this._engine && this._engine.stop && this._engine.stop();
    } catch (err) {
      console.warn('[skald] engine.stop failed:', err);
    }
  }

  setSentences(sentences) {
    this._cancelSpeak();
    this._sentences = sentences || [];
    this._status = 'idle';
    this._index = 0;
    this._error = null;
    this._emit();
  }

  /** Swap engines; restarts the current sentence if we were playing. */
  setEngine(engine) {
    if (!engine || engine === this._engine) return;
    const wasPlaying = this._status === 'playing';
    this._cancelSpeak();
    this._engine = engine;
    if (wasPlaying) {
      this._speakIndex(this._index);
    } else {
      this._emit();
    }
  }

  /**
   * Live parameter update. Restarts the current sentence (debounced) when a
   * non-volume parameter changes during playback.
   */
  setParams(patch) {
    if (!patch) return;
    const prev = { ...this._opts };
    let changed = false;
    const restartKeys = [];
    for (const key of ['rate', 'volume', 'pitch', 'voiceId']) {
      if (patch[key] === undefined || patch[key] === prev[key]) continue;
      this._opts[key] = patch[key];
      changed = true;
      if (key !== 'volume') restartKeys.push(key);
    }
    if (!changed) return;

    if (restartKeys.length) {
      if (this._status === 'playing') {
        this._scheduleRestart();
      } else if (this._status === 'paused' && this._midSentence) {
        // Cannot hot-swap a suspended utterance — drop it; next play()
        // restarts the sentence with the new parameters.
        this._gen++;
        this._midSentence = false;
        try {
          this._engine && this._engine.stop && this._engine.stop();
        } catch {
          /* already gone */
        }
      }
      this._emit();
    } else {
      // Volume-only: apply live when the engine can, no restart.
      try {
        this._engine &&
          this._engine.setVolume &&
          this._engine.setVolume(this._opts.volume);
      } catch {
        /* takes effect next sentence */
      }
      this._emit();
    }
  }

  _scheduleRestart() {
    this._clearRestartTimer();
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this._status === 'playing') {
        this._speakIndex(this._index);
      }
    }, RESTART_DEBOUNCE_MS);
  }

  play() {
    if (!this.total) return;
    if (this._status === 'playing') return;
    if (this._status === 'ended') this._index = 0;
    if (this._status === 'paused' && this._midSentence) {
      this._status = 'playing';
      this._emit();
      let resumed = false;
      try {
        resumed = this._engine && this._engine.resume
          ? this._engine.resume()
          : false;
      } catch {
        resumed = false;
      }
      if (resumed !== true) this._speakIndex(this._index);
      return;
    }
    this._speakIndex(this._index);
  }

  pause() {
    this._clearRestartTimer();
    if (this._status !== 'playing') return;
    let suspended = false;
    try {
      suspended = this._engine && this._engine.pause
        ? this._engine.pause()
        : false;
    } catch {
      suspended = false;
    }
    this._status = 'paused';
    this._midSentence = suspended === true;
    if (!this._midSentence) {
      this._gen++;
      try {
        this._engine && this._engine.stop && this._engine.stop();
      } catch {
        /* ignore */
      }
    }
    this._emit();
  }

  toggle() {
    if (this._status === 'playing') this.pause();
    else this.play();
  }

  /** Stop resets the cursor to the start. */
  stop() {
    this._cancelSpeak();
    this._status = 'idle';
    this._index = 0;
    this._error = null;
    this._emit();
  }

  next() {
    this._move(this._index + 1);
  }

  prev() {
    this._move(Math.max(0, this._index - 1));
  }

  seek(i) {
    const idx = Math.min(Math.max(0, i), Math.max(0, this.total - 1));
    this._move(idx);
  }

  _move(i) {
    if (!this.total) return;
    if (i >= this.total) {
      if (this._status === 'playing') this._finish();
      else this._emit();
      return;
    }
    if (this._status === 'playing') {
      this._speakIndex(i);
    } else {
      this._cancelSpeak();
      this._index = i;
      this._status = 'paused';
      const s = this._sentences[i];
      if (s) {
        try {
          this._onSentence(i, s);
        } catch {
          /* highlight is best-effort */
        }
      }
      this._emit();
    }
  }

  _finish() {
    this._cancelSpeak();
    this._status = 'ended';
    this._emit();
  }

  _speakIndex(i) {
    this._cancelSpeak();
    if (!this._sentences.length) return;
    if (i >= this._sentences.length) {
      this._finish();
      return;
    }
    this._index = i;
    this._error = null;
    this._status = 'playing';
    const s = this._sentences[i];
    try {
      this._onSentence(i, s);
    } catch {
      /* highlight is best-effort */
    }
    this._emit();

    const gen = ++this._gen;
    const handlers = {
      onboundary: (charIndex) => {
        if (gen !== this._gen) return;
        try {
          this._onBoundary && this._onBoundary(i, s, charIndex);
        } catch {
          /* optional */
        }
      },
      onend: () => {
        if (gen !== this._gen) return;
        if (this._index + 1 < this.total) {
          this._speakIndex(this._index + 1);
        } else {
          this._finish();
        }
      },
      onerror: (err) => {
        if (gen !== this._gen) return;
        this._status = 'paused';
        this._midSentence = false;
        this._error = err instanceof Error ? err.message : String(err || 'engine error');
        this._emit();
      },
    };
    try {
      this._engine.speak(s.text, { ...this._opts }, handlers);
    } catch (err) {
      this._status = 'paused';
      this._error = err instanceof Error ? err.message : String(err);
      this._emit();
    }
  }

  dispose() {
    this._cancelSpeak();
    this._status = 'idle';
  }
}
