// skald — engine interface.
//
// An engine is anything that can turn a sentence into audible speech:
//
//   id           'system' | 'daemon' | …
//   label        human name for the engine dropdown
//   available    boolean — init() sets it; false = shown greyed out
//   init()       probe resources (voices, daemon reachability); returns
//                availability. Called before first use; safe to re-call.
//   listVoices() → [{ id, name, lang?, tier? }]
//   speak(text, opts, handlers)
//       opts     { rate, volume, pitch, voiceId }
//       handlers { onboundary?(charIndex), onend?(), onerror?(err) }
//                 — handlers must be honoured only until the next stop()/
//                   speak() (engines keep a generation counter).
//   stop()       cancel current speech immediately; pending handlers die.
//   pause()      → true if suspended mid-utterance (resume-able)
//   resume()     → true if playback actually resumed from suspension
//   setVolume(v) optional — live volume without restarting (audio engines)
//
// The handlers-as-third-argument shape is a disclosed v0 deviation from the
// original EventEmitter-style sketch (see README).

'use strict';

export class Engine {
  constructor({ id, label }) {
    this.id = id;
    this.label = label;
  }

  get available() {
    return true;
  }

  async init() {
    return true;
  }

  async listVoices() {
    return [];
  }

  // eslint-disable-next-line no-unused-vars
  speak(text, opts, handlers) {
    throw new Error('Engine.speak() not implemented');
  }

  stop() {}

  /** @returns {boolean} true when suspended mid-utterance */
  pause() {
    return false;
  }

  /** @returns {boolean} true when playback resumed from suspension */
  resume() {
    return false;
  }

  // eslint-disable-next-line no-unused-vars
  setVolume(volume) {}
}

export function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
