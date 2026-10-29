# daemon/server — skald voice daemon v0

OpenAI-compatible bridge in front of the Riva HTTP server (Lane A contract,
docs/architecture.md). Speed stays client-side by design.

## Run

    .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000

Config via env: RIVA_HTTP_URI, SKALD_DAEMON_PORT, SKALD_DEFAULT_VOICE (config.py).

## API

    GET  /v1/health          daemon + upstream status
    GET  /v1/voices          parsed Riva voices + friendly aliases (mia, jason, aria)
    POST /v1/audio/speech    {input, voice?, language?, sample_rate_hz?} -> audio/wav

OpenAI client example (voice aliases mean "mia" works):

    curl -s localhost:8000/v1/audio/speech -H 'Content-Type: application/json' \
      -d '{"input":"Hello from the skald.","voice":"mia"}' --output out.wav

## Smoke test

    .venv/bin/python test_smoke.py http://localhost:8000

Checks health, voice parsing (>20), synthesis, and — if the whisper venv at
/tmp/whisperenv exists — the ASR intelligibility gate.
