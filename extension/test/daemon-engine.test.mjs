// skald — daemon-engine choreography tests (browserless, node --test).
//
// The engine talks to three worlds: the background proxy ('skald:daemon-fetch'),
// the offscreen player ('skald:audio-play' out, 'skald:audio-event' in) and the
// DOM (Audio). All three are stubbed here so the *message choreography* — the
// part that cannot be checked with `node --check` and has no browser on the
// Thor — is regression-tested: stream-first on Chrome, stream-failure fallback
// to whole WAV, cache hits, prefetch dedupe, and handler generation guards.
//
// Run: node --test extension/test/

'use strict';

import assert from 'node:assert/strict';
import { test } from 'node:test';

// --- browser stubs ---------------------------------------------------------------

class FakeAudio {
  constructor(src) {
    FakeAudio.last = this;
    this.src = src;
    this.playbackRate = 1;
    this.volume = 1;
    this.preservesPitch = false;
    this.onended = null;
    this.onerror = null;
    this.paused = false;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
  removeAttribute() {}
}
globalThis.Audio = FakeAudio;

function makeRuntime({ offscreen = true } = {}) {
  const listeners = new Set();
  const sent = []; // every runtime.sendMessage, in order
  // chrome.offscreen / chrome.runtime.getContexts exist only in Chrome's
  // service worker — the content script must learn about them via the
  // capability probe, never by touching chrome.* directly.
  const runtime = {
    ...(offscreen ? { offscreen: {} } : {}),
    runtime: {
      ...(offscreen ? { getContexts: async () => [] } : {}),
      onMessage: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
      },
      // Messages the CONTENT SCRIPT sends (to background / offscreen).
      sendMessage: (msg) => {
        sent.push(msg);
        if (msg.type === 'skald:offscreen-capability') {
          return Promise.resolve({ ok: offscreen });
        }
        if (msg.type === 'skald:audio-play') return Promise.resolve({ ok: true });
        if (msg.type === 'skald:daemon-fetch') {
          return Promise.resolve(runtime.daemonRespond(msg));
        }
        return Promise.resolve(undefined);
      },
    },
    // Test hook: what the daemon says for a given proxy request.
    daemonRespond: () => ({ ok: false, status: 0, error: 'not configured' }),
  };
  runtime.deliver = (msg) => {
    // Simulate a message broadcast (offscreen → content) reaching listeners.
    for (const fn of [...listeners]) fn(msg, { url: 'chrome-extension://x/offscreen.html' });
  };
  runtime.sent = sent;
  return runtime;
}

async function withEngine(fn, { offscreen = true } = {}) {
  const { DaemonEngine } = await import('../src/engines/daemon-engine.js');
  const rt = makeRuntime({ offscreen });
  const prevChrome = globalThis.chrome;
  const prevBrowser = globalThis.browser;
  // The engine prefers `browser` over `chrome`; install only `chrome`.
  globalThis.chrome = rt;
  delete globalThis.browser;
  const engine = new DaemonEngine();
  rt.daemonRespond = (msg) => {
    if (msg.path === '/v1/voices') {
      return {
        ok: true,
        status: 200,
        contentType: 'application/json',
        bodyText: JSON.stringify({
          voices: [
            { id: 'V-Mia', name: 'Mia' },
            { id: 'V-Jason', name: 'Jason' },
          ],
        }),
      };
    }
    return rt.speechRespond ? rt.speechRespond(msg) : { ok: false, status: 0, error: 'no speech stub' };
  };
  await engine.init();
  try {
    await fn(engine, rt);
  } finally {
    engine.dispose();
    globalThis.chrome = prevChrome;
    globalThis.browser = prevBrowser;
  }
}

const WAV = 'UklGRg=='; // pretend base64 wav bytes
const opts = (o = {}) => ({ rate: 1, volume: 1, pitch: 1, voiceId: 'V-Mia', ...o });

// --- tests ------------------------------------------------------------------------

test('Chrome cold sentence at rate 1 streams first (audio-play mode=stream)', async () => {
  await withEngine(async (engine, rt) => {
    let ended = false;
    engine.speak('Hello there.', opts(), { onend: () => (ended = true) });
    await new Promise((r) => setTimeout(r, 10));
    const play = rt.sent.find((m) => m.type === 'skald:audio-play');
    assert.equal(play.mode, 'stream', 'first play must be a stream');
    assert.equal(play.body.voice, 'V-Mia');
    assert.ok(play.url.endsWith('/v1/audio/speech/stream'));
    rt.deliver({ type: 'skald:audio-event', playId: play.playId, event: 'ended' });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(ended, 'onend must fire after offscreen ended');
  });
});

test('rate != 1 skips the stream path (pitch-preserving speed needs <audio>)', async () => {
  await withEngine(async (engine, rt) => {
    rt.speechRespond = () => ({ ok: true, status: 200, contentType: 'audio/wav', bodyBase64: WAV });
    engine.speak('Faster words.', opts({ rate: 1.5 }), { onend: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    const play = rt.sent.find((m) => m.type === 'skald:audio-play');
    assert.equal(play.mode, 'blob', 'rate 1.5 must play a blob');
    assert.equal(play.rate, 1.5, 'rate carried to the offscreen <audio> path');
  });
});

test('failed stream falls back to a whole-WAV request and still speaks', async () => {
  await withEngine(async (engine, rt) => {
    rt.speechRespond = () => ({ ok: true, status: 200, contentType: 'audio/wav', bodyBase64: WAV });
    let ended = false;
    let error = null;
    engine.speak('Recover me.', opts(), {
      onend: () => (ended = true),
      onerror: (e) => (error = e),
    });
    await new Promise((r) => setTimeout(r, 10));
    const streamPlay = rt.sent.find((m) => m.type === 'skald:audio-play' && m.mode === 'stream');
    assert.ok(streamPlay, 'stream attempted first');
    // The offscreen player reports the stream failed (e.g. endpoint absent
    // on an older daemon, or the AudioContext autoplay-gated).
    rt.deliver({ type: 'skald:audio-event', playId: streamPlay.playId, event: 'error', error: 'stream fetch failed: HTTP 404' });
    await new Promise((r) => setTimeout(r, 20));
    // Fallback: a daemon-fetch for the whole WAV, then a blob play.
    const fetches = rt.sent.filter((m) => m.type === 'skald:daemon-fetch' && m.path === '/v1/audio/speech');
    assert.equal(fetches.length, 1, 'exactly one whole-WAV request after stream failure');
    const body = JSON.parse(fetches[0].bodyText);
    assert.equal(body.input, 'Recover me.');
    const blobPlay = rt.sent.find((m) => m.type === 'skald:audio-play' && m.mode === 'blob');
    assert.ok(blobPlay, 'whole WAV handed to the offscreen player');
    assert.ok(!error, 'the stream failure itself must not surface as an error');
    rt.deliver({ type: 'skald:audio-event', playId: blobPlay.playId, event: 'ended' });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(ended, 'sentence completed via the fallback');
  });
});

test('stream failure with the daemon also down surfaces the error exactly once', async () => {
  await withEngine(async (engine, rt) => {
    const errors = [];
    engine.speak('Cannot recover.', opts(), { onerror: (e) => errors.push(e) });
    await new Promise((r) => setTimeout(r, 10));
    const streamPlay = rt.sent.find((m) => m.type === 'skald:audio-play' && m.mode === 'stream');
    rt.deliver({ type: 'skald:audio-event', playId: streamPlay.playId, event: 'error', error: 'boom' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(errors.length, 1, 'one surfaced error, no retry loop');
    assert.match(errors[0].message, /daemon speech failed: HTTP 0/);
  });
});

test('prefetch fills the cache; a later speak() of that sentence never fetches', async () => {
  await withEngine(async (engine, rt) => {
    rt.speechRespond = (msg) => {
      const body = JSON.parse(msg.bodyText);
      assert.equal(body.voice, 'V-Jason');
      return { ok: true, status: 200, contentType: 'audio/wav', bodyBase64: WAV };
    };
    engine.prefetch('Prefetched line.', opts({ voiceId: 'V-Jason' }));
    engine.prefetch('Prefetched line.', opts({ voiceId: 'V-Jason' })); // dedupe
    await new Promise((r) => setTimeout(r, 20));
    const fetches = rt.sent.filter((m) => m.type === 'skald:daemon-fetch' && m.path === '/v1/audio/speech');
    assert.equal(fetches.length, 1, 'second prefetch is deduped while pending');

    rt.sent.length = 0;
    let ended = false;
    engine.speak('Prefetched line.', opts({ voiceId: 'V-Jason', rate: 2 }), { onend: () => (ended = true) });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(rt.sent.filter((m) => m.type === 'skald:daemon-fetch' && m.path === '/v1/audio/speech').length, 0, 'cache hit: no synthesis');
    const play = rt.sent.find((m) => m.type === 'skald:audio-play');
    assert.equal(play.mode, 'blob', 'cached blob plays through the offscreen player');
    assert.equal(play.rate, 2, 'client-side rate applied to the cached blob');
    rt.deliver({ type: 'skald:audio-event', playId: play.playId, event: 'ended' });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(ended);
  });
});

test('stale audio events for an old playId are ignored', async () => {
  await withEngine(async (engine, rt) => {
    let ended = false;
    engine.speak('First.', opts(), { onend: () => (ended = true) });
    await new Promise((r) => setTimeout(r, 10));
    const play = rt.sent.find((m) => m.type === 'skald:audio-play');
    engine.stop();
    rt.deliver({ type: 'skald:audio-event', playId: play.playId, event: 'ended' });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!ended, 'onend after stop() must not fire');
  });
});

test('Firefox-like environment (no offscreen capability) plays inline through Audio', async () => {
  await withEngine(
    async (engine, rt) => {
      rt.speechRespond = () => ({ ok: true, status: 200, contentType: 'audio/wav', bodyBase64: WAV });
      let ended = false;
      engine.speak('Inline please.', opts(), { onend: () => (ended = true) });
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(!rt.sent.some((m) => m.type === 'skald:audio-play'), 'no offscreen path');
      assert.ok(FakeAudio.last.src.startsWith('data:audio/wav;base64,'), 'inline data-URL audio');
      FakeAudio.last.onended();
      assert.ok(ended);
    },
    { offscreen: false }
  );
});
