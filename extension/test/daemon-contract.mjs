// skald — live daemon-contract check for the extension's voice/rate values.
//
// Why this exists (2026-10-30): the extension's voice dropdown came up EMPTY
// against the real daemon (payload-shape mismatch), speak() fell back to a
// literal voice "default", and Riva answered 400 eight times — the owner's
// reading stopped. A shape check against the LIVE /v1/voices plus a
// synthesize round-trip with the EXACT body the engine builds catches that
// class of regression in seconds, no browser needed.
//
// Run:  node extension/test/daemon-contract.mjs [base-url]
//       (default http://localhost:8000; any skald daemon on the LAN works)
// Exit: 0 pass, 1 fail. validate.sh runs this when a daemon is reachable.

'use strict';

import { normalizeVoices } from '../src/engines/daemon-engine.js';

const BASE = (process.argv[2] || process.env.SKALD_DAEMON || 'http://localhost:8000').replace(/\/+$/, '');
let failures = 0;

function ok(cond, label) {
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failures++;
    console.error(`  FAIL: ${label}`);
  }
}

async function main() {
  console.log(`daemon-contract against ${BASE}`);

  // -- health -------------------------------------------------------------------
  let health;
  try {
    health = await (await fetch(`${BASE}/v1/health`, { signal: AbortSignal.timeout(5000) })).json();
  } catch (err) {
    console.error(`daemon unreachable (${err.message}) — nothing to contract-test`);
    process.exit(1);
  }
  ok(health && health.upstream && health.upstream.reachable === true, 'health: daemon up AND its Riva upstream reachable');

  // -- voices: the payload must parse to a non-empty dropdown -------------------
  const voicesPayload = await (await fetch(`${BASE}/v1/voices`)).json();
  const voices = normalizeVoices(voicesPayload);
  ok(voices.length > 20, `voices: normalizeVoices parses the live payload (${voices.length} voices; >20 expected)`);
  ok(new Set(voices.map((v) => v.id)).size === voices.length, 'voices: ids unique');
  ok(voices.every((v) => typeof v.id === 'string' && v.id.length > 0 && !/default/i.test(v.id)),
    'voices: no entry the engine could send as a literal "default"');

  // -- synthesize with the EXACT body the engine builds --------------------------
  // (daemon-engine speak(): {model, input, voice, response_format:'wav', pitch})
  // Sample the riskiest ids: first, last, and a styled variant if one exists.
  const styled = voices.find((v) => v.id.includes('.Calm') || v.id.includes('.Happy'));
  const sample = [voices[0], voices[voices.length - 1], styled].filter(Boolean);
  for (const v of sample) {
    const body = {
      model: 'kokoro',
      input: 'Contract check.',
      voice: v.id,
      response_format: 'wav',
      pitch: 1,
    };
    const r = await fetch(`${BASE}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const audio = r.ok ? await r.arrayBuffer() : null;
    ok(
      r.status === 200 && audio && audio.byteLength > 1000 && (r.headers.get('content-type') || '').includes('audio/wav'),
      `speech: engine body accepted for ${v.id} (${r.status}, ${audio ? audio.byteLength : 0}B)`
    );
  }

  // -- the recovery path: omitting the voice must be safe (daemon default) -------
  // The engine omits `voice` rather than sending "default" when it has none.
  const r2 = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'kokoro', input: 'No voice field.', response_format: 'wav', pitch: 1 }),
    signal: AbortSignal.timeout(60000),
  });
  ok(r2.status === 200, `speech: voice omitted -> daemon default accepted (${r2.status})`);

  // -- the regression that went silent: literal "default" must be visible ---------
  // (Not accepted by Riva — the point is that IF the extension ever sends a
  // non-voice again, the daemon now says why. We assert the 400 carries the
  // upstream reason so the failure is diagnosable from the client too.)
  const r3 = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'kokoro', input: 'x', voice: 'default', response_format: 'wav', pitch: 1 }),
    signal: AbortSignal.timeout(30000),
  });
  const r3text = await r3.text();
  ok(
    r3.status === 400 && r3text.includes('upstream'),
    `speech: literal voice "default" rejected WITH reason in body (${r3.status})`
  );

  if (failures) {
    console.error(`daemon-contract: ${failures} FAILURES`);
    process.exit(1);
  }
  console.log('daemon-contract: OK');
}

main().catch((err) => {
  console.error('daemon-contract crashed:', err);
  process.exit(1);
});
