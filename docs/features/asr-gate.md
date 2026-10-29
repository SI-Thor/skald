# The ASR round-trip gate: machine ears before human ears

> Rule learned the hard way, now permanent: no TTS engine or deployment is
> "working" until a speech recognizer can transcribe what it says.

## The story (why this exists)

This project's most instructive failure: after fifteen repair layers, the
from-scratch Magpie deployment produced audio that *looked* perfect — correct
durations, clean streaming, speech-band spectra, plausible waveform
statistics. It was committed as "MAGPIE SPEAKS." The owner's reply — *"think
and try again"* — prompted the obvious missing test: feed the audio to
Whisper. Heard back: fluent, confident **babble**. Structured sound, wrong
tokens. The correction (`docs/research/2026-10-29b`) is in the repo beside
the overclaim, and the gate that caught it is now part of the scorecard.

## The gate

```
text ──▶ TTS engine ──▶ WAV ──▶ ASR (faster-whisper) ──▶ transcript
                                    │
   accept if ≈ text (fuzzy) ◀───────┘
```

- **Where today**: `daemon/server/test_smoke.py` (deployment smoke test —
  the daemon must speak intelligibly, not just return bytes; needs a
  faster-whisper venv: `python3 -m venv /tmp/whisperenv &&
  /tmp/whisperenv/bin/pip install faster-whisper`); offline isolation tool
  `offline_synth.py` (referenced in research note 2026-10-29b).
- **Where next**: a benchmark intelligibility phase + scorecard column
  (design settled, not yet wired into `benchmark/harness.py`).
- **Threshold**: tiny.en-level ASR agreement is the floor (homophone-level
  divergence = pass; hallucinated or empty = fail). Higher-quality ASR can
  tighten the gate.
- **Order of operations**: machine gate first, human ears second — ASR is
  free, tireless, and immune to the operator's optimism after a long build.

## Why it's novel (as practice)

Public TTS benchmarks score RTF and MOS-style ratings; hobby deployments
usually stop at "it plays." For *edge* deployments — where you may have
rebuilt engines, shimmed version skew, or transplanted assets — the failure
mode is precisely "plumbing green, semantics broken." An ASR round-trip is a
cheap, objective end-to-end semantic check that catches wrong-vocab ids,
misaligned tokenizers, broken codecs, and wrong-engine architectures in one
shot. It caught every one of those classes in this project.

## Scorecard impact

The ADR-0005 table now carries an implicit column: **no engine row is
"human-ready" without a passing round-trip**. The rebuilt-ONNX path kept its
latency numbers *and* its parked status — because 0.18 s to first babble is
still babble.
