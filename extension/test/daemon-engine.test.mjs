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
      // The daemon's real shape: Riva-parsed entries keyed by voice_id
      // (missing this key once emptied the dropdown — see normalizeVoices).
      return {
        ok: true,
        status: 200,
        contentType: 'application/json',
        bodyText: JSON.stringify({
          voices: [
            { voice_id: 'V-Mia', locale: 'EN-US', speaker: 'Mia', style: 'Default', source: 'riva' },
            { voice_id: 'V-Jason', locale: 'EN-US', speaker: 'Jason', style: 'Default', source: 'riva' },
          ],
        }),
      };
    }
    return rt.speechRespond ? rt.speechRespond(msg) : { ok: false, status: 0, error: 'no speech stub' };
  };
  await engine.init();
  assert.equal(engine._offscreenCapable, offscreen, 'capability probed from the background');
  assert.deepEqual(
    (await engine.listVoices()).map((v) => v.name),
    ['Mia', 'Jason'],
    'daemon voice_id shape parses to friendly speaker names'
  );
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

// --- normalizeVoices (the payload-shape regression) -------------------------------

test('normalizeVoices parses the daemon\'s voice_id shape into friendly names', async () => {
  const { normalizeVoices } = await import('../src/engines/daemon-engine.js');
  const daemonPayload = {
    voices: [
      { voice_id: 'Magpie-Multilingual.EN-US.Mia', locale: 'EN-US', speaker: 'Mia', style: 'Default', source: 'riva' },
      { voice_id: 'Magpie-Multilingual.EN-US.Mia.Calm', locale: 'EN-US', speaker: 'Mia', style: 'Calm', source: 'riva' },
      { voice_id: 'Magpie-Multilingual.ES-ES.Luna', locale: 'ES-ES', speaker: 'Luna', style: 'Default', source: 'riva' },
    ],
    aliases: { mia: 'Magpie-Multilingual.EN-US.Mia' },
  };
  const voices = normalizeVoices(daemonPayload);
  assert.equal(voices.length, 3, 'the live daemon returns 399 of these; all must parse');
  assert.deepEqual(
    voices.map((v) => v.id),
    [
      'Magpie-Multilingual.EN-US.Mia',
      'Magpie-Multilingual.EN-US.Mia.Calm',
      'Magpie-Multilingual.ES-ES.Luna',
    ]
  );
  assert.deepEqual(
    voices.map((v) => v.name),
    ['Mia', 'Mia · Calm', 'Luna'],
    'speaker + non-default style make the human label'
  );
  assert.equal(voices[0].tier, 'EN-US');
});

test('normalizeVoices still accepts OpenAI-ish {id,name} and dedupes', async () => {
  const { normalizeVoices } = await import('../src/engines/daemon-engine.js');
  const voices = normalizeVoices({ data: [{ id: 'a', name: 'Alpha' }, { id: 'a', name: 'Alpha' }, { id: 'b' }] });
  assert.deepEqual(voices, [
    { id: 'a', name: 'Alpha', lang: null, tier: null },
    { id: 'b', name: 'b', lang: null, tier: null },
  ]);
});

test('normalizeVoices on garbage returns an empty list, never throws', async () => {
  const { normalizeVoices } = await import('../src/engines/daemon-engine.js');
  assert.deepEqual(normalizeVoices(null), []);
  assert.deepEqual(normalizeVoices({ voices: 7 }), []);
  assert.deepEqual(normalizeVoices({ voices: [{ nope: 1 }] }), []);
});

// --- voice-refusal recovery (owner bug 3: 8x400 then silence) ---------------------
// In the Chrome-like environment a cold sentence at rate 1 goes STREAM first
// (and Riva's streaming endpoint false-succeeds on a bad voice with 0 bytes),
// so these tests replay the real sequence: stream fails -> whole-WAV 400 ->
// the engine must recover with the last working voice, never go silent.

test('a refused voice recovers: notice + retry with last working voice', async () => {
  await withEngine(async (engine, rt) => {
    const notices = [];
    engine.onNotice = (n) => notices.push(n);
    rt.speechRespond = (msg) =>
      JSON.parse(msg.bodyText).voice === 'V-Mia'
        ? { ok: true, status: 200, contentType: 'audio/wav', bodyBase64: WAV }
        : { ok: false, status: 400, contentType: 'application/json', bodyText: JSON.stringify({ detail: 'upstream: Voice not found' }) };
    // First sentence streams fine and completes -> establishes last-good.
    engine.speak('First sentence.', opts(), { onend: () => {} });
    await new Promise((r) => setTimeout(r, 10));
    const first = rt.sent.find((m) => m.type === 'skald:audio-play');
    rt.deliver({ type: 'skald:audio-event', playId: first.playId, event: 'ended' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(engine._lastGoodVoice, 'V-Mia');

    // User picks V-Jason: stream false-succeeds (0 bytes) -> error event ->
    // whole-WAV fallback gets the 400 -> engine must recover.
    let errored = false;
    let ended = false;
    engine.speak('Second sentence.', opts({ voiceId: 'V-Jason' }), {
      onend: () => (ended = true),
      onerror: () => (errored = true),
    });
    await new Promise((r) => setTimeout(r, 10));
    const second = rt.sent.filter((m) => m.type === 'skald:audio-play').pop();
    rt.deliver({ type: 'skald:audio-event', playId: second.playId, event: 'error', error: 'stream produced no audio' });
    await new Promise((r) => setTimeout(r, 30));
    const speechFetches = rt.sent.filter((m) => m.type === 'skald:daemon-fetch' && m.path === '/v1/audio/speech');
    const voicesSent = speechFetches.map((m) => JSON.parse(m.bodyText).voice);
    assert.deepEqual(voicesSent, ['V-Jason', 'V-Mia'], 'refused once, retried with the last good voice');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, 'voice-refused');
    assert.equal(notices[0].voice, 'V-Jason');
    assert.equal(notices[0].fallback, 'V-Mia');
    const play = rt.sent.filter((m) => m.type === 'skald:audio-play').pop();
    assert.equal(play.mode, 'blob');
    assert.ok(!errored, 'no user-visible error: the sentence still speaks');
    rt.deliver({ type: 'skald:audio-event', playId: play.playId, event: 'ended' });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(ended);

    // The refused voice is not sent again this session.
    rt.sent.length = 0;
    engine.speak('Third sentence.', opts({ voiceId: 'V-Jason' }), { onend: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    const third = rt.sent.find((m) => m.type === 'skald:daemon-fetch' && m.path === '/v1/audio/speech');
    assert.equal(third, undefined, 'no 400 loop: V-Jason is never re-sent');
    const streamPlay = rt.sent.find((m) => m.type === 'skald:audio-play');
    assert.equal(streamPlay.body.voice, 'V-Mia', 'substitute voice used on the stream path');
  });
});

test('a refusal with no known-good voice retries once with the daemon default (voice omitted)', async () => {
  await withEngine(async (engine, rt) => {
    const notices = [];
    engine.onNotice = (n) => notices.push(n);
    let calls = 0;
    rt.speechRespond = () => {
      calls++;
      return calls === 1
        ? { ok: false, status: 400, contentType: 'application/json', bodyText: JSON.stringify({ detail: 'upstream: bad voice' }) }
        : { ok: true, status: 200, contentType: 'audio/wav', bodyBase64: WAV };
    };
    let errored = false;
    engine.speak('Cold open refusal.', opts({ voiceId: 'V-Bad' }), { onerror: () => (errored = true) });
    await new Promise((r) => setTimeout(r, 10));
    const streamPlay = rt.sent.find((m) => m.type === 'skald:audio-play');
    rt.deliver({ type: 'skald:audio-event', playId: streamPlay.playId, event: 'error', error: 'stream produced no audio' });
    await new Promise((r) => setTimeout(r, 30));
    const voicesSent = rt.sent
      .filter((m) => m.type === 'skald:daemon-fetch' && m.path === '/v1/audio/speech')
      .map((m) => JSON.parse(m.bodyText).voice);
    assert.deepEqual(voicesSent, ['V-Bad', undefined], 'retry omits the voice (daemon default)');
    assert.ok(!errored);
    assert.equal(notices.length, 1);
  });
});

test('the engine never sends the literal voice "default" (Riva rejects it with 400)', async () => {
  await withEngine(async (engine, rt) => {
    rt.speechRespond = () => ({ ok: true, status: 200, contentType: 'audio/wav', bodyBase64: WAV });
    engine._voices = []; // worst case: dropdown parsed empty
    // rate 1 -> stream body; rate 1.4 -> whole-WAV body. Neither may carry
    // voice:"default" — omitting the field makes the daemon use its default.
    engine.speak('No voices known.', { rate: 1, volume: 1, pitch: 1 }, { onend: () => {} });
    engine.speak('No voices known either.', { rate: 1.4, volume: 1, pitch: 1 }, { onend: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    for (const m of rt.sent) {
      if (m.type === 'skald:audio-play' && m.body) {
        assert.ok(m.body.voice === undefined || m.body.voice !== 'default', 'stream body: never "default"');
      }
      if (m.type === 'skald:daemon-fetch' && m.path === '/v1/audio/speech') {
        const v = JSON.parse(m.bodyText).voice;
        assert.ok(v === undefined || v !== 'default', 'speech body: never "default"');
      }
    }
  });
});
