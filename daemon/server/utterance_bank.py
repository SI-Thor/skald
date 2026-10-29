#!/usr/bin/env python
"""Utterance pre-render bank: content-hash memoized synthesis.

last-mile's "pre-render ahead of the player" for speech: render upcoming
utterances now, keyed by hash(text, voice, style, rate) so repeated
phrasings are free. Bank layout:

    <bank>/entries/<hash>.wav
    <bank>/entries/<hash>.json   # {"text","voice","sample_rate_hz","rendered_at","engine"}

Usage:
  render one:  python utterance_bank.py --text "We move at dawn." --voice mia
  render many: python utterance_bank.py --file cues.jsonl   # lines: {"text":..,"voice":..}
  lookup:      python utterance_bank.py --text "..." --voice mia --check

The hash the caller needs to look an entry up at play time is printed on
render (--check prints it without rendering). Deterministic: sha256 of the
canonical request.
"""
import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request

DEFAULT_DAEMON = os.environ.get("SKALD_DAEMON", "http://localhost:8000")


def key(text: str, voice: str, sample_rate_hz: int) -> str:
    canon = json.dumps(
        {"text": text, "voice": voice, "sample_rate_hz": sample_rate_hz},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canon.encode()).hexdigest()


def paths(bank: str, k: str):
    d = os.path.join(bank, "entries")
    return os.path.join(d, f"{k}.wav"), os.path.join(d, f"{k}.json"), d


def render(bank: str, text: str, voice: str, rate: int, daemon: str) -> tuple[bool, str]:
    k = key(text, voice, rate)
    wav, meta, d = paths(bank, k)
    os.makedirs(d, exist_ok=True)
    if os.path.exists(wav):
        return True, k  # memoized
    body = json.dumps({"input": text, "voice": voice, "sample_rate_hz": rate}).encode()
    req = urllib.request.Request(
        daemon + "/v1/audio/speech", data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    tmp = wav + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, wav)  # atomic: readers never see partial renders
    with open(meta, "w") as f:
        json.dump(
            {
                "text": text,
                "voice": voice,
                "sample_rate_hz": rate,
                "bytes": len(data),
                "engine": "skald-daemon",
                "rendered_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            },
            f,
            indent=1,
        )
    return False, k  # False = was a miss (freshly rendered)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text")
    ap.add_argument("--voice", default="Magpie-Multilingual.EN-US.Mia")
    ap.add_argument("--rate", type=int, default=22050)
    ap.add_argument("--file", help="JSONL: {\"text\":..., \"voice\":?} per line")
    ap.add_argument("--bank", default=os.environ.get("SKALD_BANK", os.path.expanduser("~/src/skald-riva/utterance-bank")))
    ap.add_argument("--daemon", default=DEFAULT_DAEMON)
    ap.add_argument("--check", action="store_true", help="print the lookup key only")
    a = ap.parse_args()

    cues = []
    if a.file:
        with open(a.file) as f:
            for line in f:
                line = line.strip()
                if line:
                    o = json.loads(line)
                    cues.append((o["text"], o.get("voice") or a.voice, o.get("sample_rate_hz") or a.rate))
    elif a.text:
        cues.append((a.text, a.voice, a.rate))
    else:
        ap.error("need --text or --file")

    hits = misses = 0
    for text, voice, rate in cues:
        k = key(text, voice, rate)
        if a.check:
            print(f"{k}  {text[:50]!r}")
            continue
        was_hit, k = render(a.bank, text, voice, rate, a.daemon)
        hits += was_hit
        misses += not was_hit
        print(f"{'HIT ' if was_hit else 'MISS'} {k[:12]} ({voice}) {text[:50]!r}")
    print(f"bank: {a.bank} — {hits} hit(s), {misses} rendered")
    return 0


if __name__ == "__main__":
    sys.exit(main())
