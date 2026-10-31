// skald — offscreen audio player (Chrome only, ADR-0011).
//
// The service worker has no DOM and content-script audio is subject to the
// page's autoplay policy, so Chrome plays daemon speech HERE: an extension
// page with no UI, created by the background worker with the AUDIO_PLAYBACK
// reason. It understands two play modes:
//
//   blob   — whole WAV bytes (base64) → data-URL <audio>; pitch is preserved
//            while rate scales (preservesPitch), the same semantics as the
//            content-script path Firefox uses.
//   stream — the daemon's /v1/audio/speech/stream endpoint (chunked PCM):
//            fetch with a ReadableStream reader, convert Int16LE → Float32
//            and schedule buffers on an AudioContext as they arrive, so
//            playback starts with the FIRST chunk (~0.2–0.9 s under Thor
//            load vs 1.5–7 s for a whole WAV — docs/research/2026-10-30).
//            Caveat: rate scales pitch on this path (WebAudio has no
//            preservesPitch); the engine only takes it when rate is 1.
//
// Only one playback is active at a time (single-voice household); a new
// 'skald:offscreen-play' stops the previous one. Lifecycle events go back as
// 'skald:audio-event' broadcasts, which the background worker routes to the
// tab that started the play.
//
// chrome.runtime is the only extension API available in this context.

'use strict';

const STREAM_LEAD_S = 0.06; // schedule the first chunk this far ahead
const STREAM_MIN_GAP_S = 0.03; // never butt-splice before "now + gap"

// { playId, kind, audio?, ctx?, gain?, stop() } — killed by the next play.
let current = null;

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function emit(playId, event, error) {
  chrome.runtime
    .sendMessage({
      type: 'skald:audio-event',
      playId,
      event, // 'ended' | 'error'
      error: error == null ? undefined : String(error),
    })
    .catch(() => {}); // worker may be gone; playback is over anyway
}

function stopCurrent() {
  if (!current) return;
  const c = current;
  current = null;
  try {
    c.stopped = true;
    c.stop();
  } catch {
    /* already gone */
  }
}

// --- blob mode -----------------------------------------------------------------

function startBlob(handle, { mime, bodyBase64, volume, rate }) {
  const audio = new Audio(`data:${mime || 'audio/wav'};base64,${bodyBase64}`);
  handle.audio = audio;
  audio.volume = clampNum(volume, 0, 1, 1);
  audio.playbackRate = clampNum(rate, 0.25, 4, 1);
  audio.preservesPitch = true;
  audio.onended = () => {
    if (current !== handle) return;
    current = null;
    emit(handle.playId, 'ended');
  };
  audio.onerror = () => {
    if (current !== handle) return;
    current = null;
    emit(handle.playId, 'error', 'audio element failed');
  };
  handle.stop = () => {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  };
  audio.play().catch((err) => {
    if (current !== handle) return;
    current = null;
    handle.stop();
    emit(handle.playId, 'error', (err && err.message) || String(err));
  });
}

// --- stream mode ---------------------------------------------------------------

function sampleRateFromHeaders(headers) {
  const explicit = headers.get('x-skald-sample-rate');
  if (explicit && /^\d+$/.test(explicit)) return parseInt(explicit, 10);
  const m = /rate=(\d+)/.exec(headers.get('content-type') || '');
  return m ? parseInt(m[1], 10) : 22050;
}

async function startStream(handle, { url, body, volume, rate }) {
  // Aborted by stop() so a skipped sentence also stops costing the daemon
  // (and Riva) synthesis work — the box is contended, that work is real.
  const abort = new AbortController();
  let ctx = null;
  const sources = [];
  handle.abort = abort;
  handle.stop = () => {
    abort.abort();
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    if (ctx) ctx.close().catch(() => {});
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body || {}),
    signal: abort.signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream fetch failed: HTTP ${res.status}`);

  // Created after the headers arrive so the declared sample rate is known.
  ctx = new AudioContext({ sampleRate: sampleRateFromHeaders(res.headers) });
  // Autoplay insurance: an AudioContext can come up 'suspended'; scheduling
  // against a suspended clock would fire every buffer at once on resume.
  // Wait (bounded) for 'running' — on failure throw so the engine retries
  // the sentence as a whole WAV (<audio> path is not autoplay-gated here).
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      /* judged below by state, not by this throw */
    }
  }
  const ctxDeadline = performance.now() + 2000;
  while (ctx.state !== 'running' && performance.now() < ctxDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (ctx.state !== 'running') throw new Error('AudioContext not running (autoplay-gated)');
  const gain = ctx.createGain();
  gain.gain.value = clampNum(volume, 0, 1, 1);
  gain.connect(ctx.destination);
  handle.ctx = ctx;
  handle.gain = gain;
  let nextTime = 0; // ctx time where the next buffer will start
  let tail = new Uint8Array(0); // odd-byte carry between network chunks

  const playbackRate = clampNum(rate, 0.25, 4, 1);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || !value.length) continue;
    const bytes = new Uint8Array(tail.length + value.length);
    bytes.set(tail);
    bytes.set(value, tail.length);
    const usable = bytes.length - (bytes.length % 2); // whole Int16 samples
    if (usable < 2) {
      tail = bytes;
      continue;
    }
    tail = bytes.subarray(usable);

    const ints = new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2);
    const floats = new Float32Array(ints.length);
    for (let i = 0; i < ints.length; i++) floats[i] = ints[i] / 32768;
    const buffer = ctx.createBuffer(1, floats.length, ctx.sampleRate);
    buffer.copyToChannel(floats, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = playbackRate;
    src.connect(gain);
    const at = nextTime === 0
      ? ctx.currentTime + STREAM_LEAD_S
      : Math.max(nextTime, ctx.currentTime + STREAM_MIN_GAP_S);
    src.start(at);
    nextTime = at + buffer.duration / playbackRate;
    sources.push(src);
  }

  if (!sources.length) throw new Error('stream produced no audio');
  // Everything is scheduled; wait until the AudioContext clock (which pauses
  // with suspend()) plays past the end of the last buffer. A wall-clock
  // timeout would fire early across a pause.
  for (;;) {
    if (handle.stopped) return;
    if (ctx.currentTime >= nextTime - 0.02) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// --- messages --------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return undefined;

  if (msg.type === 'skald:offscreen-play') {
    stopCurrent(); // single active playback per extension
    const handle = { playId: msg.playId, kind: msg.mode, stopped: false, stop() {} };
    current = handle;
    if (msg.mode === 'blob' && msg.bodyBase64) {
      try {
        startBlob(handle, msg);
      } catch (err) {
        current = null;
        emit(msg.playId, 'error', (err && err.message) || String(err));
      }
    } else if (msg.mode === 'stream' && msg.url) {
      startStream(handle, msg)
        .then(() => {
          if (current !== handle || handle.stopped) return;
          current = null;
          try {
            handle.stop();
          } catch {
            /* ignore */
          }
          emit(msg.playId, 'ended');
        })
        .catch((err) => {
          if (current !== handle || handle.stopped) return;
          current = null;
          try {
            handle.stop();
          } catch {
            /* ignore */
          }
          emit(msg.playId, 'error', (err && err.message) || String(err));
        });
    } else {
      current = null;
      emit(msg.playId, 'error', `bad play message: mode=${msg.mode}`);
    }
    return undefined;
  }

  if (msg.type === 'skald:offscreen-control') {
    const c = current;
    if (!c) return undefined;
    if (msg.action === 'pause') {
      if (c.audio) c.audio.pause();
      else if (c.ctx) c.ctx.suspend().catch(() => {});
    } else if (msg.action === 'resume') {
      if (c.audio) {
        const p = c.audio.play();
        if (p && p.catch) p.catch(() => {});
      } else if (c.ctx) c.ctx.resume().catch(() => {});
    } else if (msg.action === 'volume') {
      const v = clampNum(msg.value, 0, 1, 1);
      if (c.audio) c.audio.volume = v;
      else if (c.gain) c.gain.gain.value = v;
    }
    // 'stop' is handled above (stopCurrent) for both kinds.
    return undefined;
  }

  return undefined;
});
