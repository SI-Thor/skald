"""Smoke test: run against a live daemon (default :8000). Verifies health,
voices, synthesis — and intelligibility via whisper if available."""
import json
import struct
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"


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

# optional intelligibility gate
try:
    sys.path.insert(0, "/tmp/whisperenv/lib/python3.12/site-packages")
    import wave

    import numpy as np
    from faster_whisper import WhisperModel

    w = wave.open("smoke_out.wav")
    audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    w.close()
    m = WhisperModel("tiny.en", device="cpu", compute_type="int8")
    segs, _ = m.transcribe(audio)
    heard = " ".join(s.text.strip() for s in segs)
    print(f"whisper heard: {heard!r}")
    assert "skald" in heard.lower() or "scald" in heard.lower(), "not intelligible!"
    print("INTELLIGIBILITY GATE: PASS")
except ImportError:
    print("whisper unavailable; skipping intelligibility gate")

print("SMOKE-ALL-OK")
