"""Smoke test: run against a live daemon (default :8000). Verifies health,
voices, synthesis — and intelligibility via whisper if available."""
import json
import struct
import sys
import urllib.request

BASE = next((a for a in sys.argv[1:] if not a.startswith("--")), None) or "http://localhost:8000"


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return r.status, json.loads(r.read())


def post_speech(text: str, voice: str | None, out: str) -> tuple[int, int]:
    body = json.dumps({"input": text, **({"voice": voice} if voice else {})}).encode()
    req = urllib.request.Request(
        BASE + "/v1/audio/speech", data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
        assert r.headers["Content-Type"] == "audio/wav", r.headers["Content-Type"]
    with open(out, "wb") as f:
        f.write(data)
    return len(data), struct.unpack("<I", data[24:28])[0]  # size, sample rate


status, health = get("/v1/health")
assert status == 200 and health["upstream"]["reachable"], health
print("health OK:", health["upstream"])

status, v = get("/v1/voices")
n = len(v["voices"])
assert status == 200 and n > 20, f"only {n} voices?"
print(f"voices OK: {n} parsed, aliases {sorted(v['aliases'])}")

size, rate = post_speech("The skald clears his throat and begins the tale.", "mia", "smoke_out.wav")
print(f"speech OK: {size} bytes @ {rate} Hz (alias 'mia')")

# intelligibility gate (skald's "working audio" rule: an ASR round-trip, not a 200).
# Whisper lives in a persistent venv (~/src/skald/.venv-asr); the old /tmp/whisperenv
# vanished on reboot and the gate silently skipped. --require-asr makes a missing
# whisper a failure, which is what a production check must do.
import glob
import os

REQUIRE_ASR = "--require-asr" in sys.argv
_here = os.path.dirname(os.path.abspath(__file__))
for _site in [os.environ.get("SKALD_ASR_SITE", "")] + glob.glob(
    os.path.join(_here, "..", "..", ".venv-asr", "lib", "python3*", "site-packages")
) + ["/tmp/whisperenv/lib/python3.12/site-packages"]:
    if _site and os.path.isdir(_site):
        sys.path.insert(0, _site)
try:
    import wave

    import numpy as np
    from faster_whisper import WhisperModel

    w = wave.open("smoke_out.wav")
    rate = w.getframerate()
    audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    w.close()
    if rate != 16000:  # whisper expects 16 kHz; skald speaks 22050 Hz
        n = int(len(audio) * 16000 / rate)
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    m = WhisperModel("tiny.en", device="cpu", compute_type="int8")
    segs, _ = m.transcribe(audio)
    heard = " ".join(s.text.strip() for s in segs)
    print(f"whisper heard: {heard!r}")
    assert "skald" in heard.lower() or "scald" in heard.lower(), "not intelligible!"
    print("INTELLIGIBILITY GATE: PASS")
except ImportError:
    if REQUIRE_ASR:
        print("whisper unavailable and --require-asr given: FAIL")
        sys.exit(1)
    print("whisper unavailable; skipping intelligibility gate")

print("SMOKE-ALL-OK")
