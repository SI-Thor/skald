# benchmark/ — on-device TTS engine scorecard

Status: not started (Phase 2). Spec: ADR-0005.

Published RTF numbers come from datacenter GPUs (e.g. fish-speech S2-Pro's 0.195 is an
H200 figure) and do not transfer to the Thor's embedded Blackwell. Engine selection is
therefore decided by measurements on the actual target hardware.

Scorecard per engine (candidates: Kokoro, Piper, fish-speech S2-Pro, Chatterbox,
Orpheus-3B):

| Metric | How |
|---|---|
| Time-to-first-audio | streaming request, cold and warm |
| Streaming RTF | sustained sentence stream, GPU and CPU |
| Memory footprint | VRAM/unified during peak |
| Long-doc stability | 10k+ words, no drift/desync/failure |
| Subjective quality | owner rating per use case: paper / news / story |

The harness doubles as the acceptance test when engines or JetPack/CUDA versions
change, and re-runs on any hardware a client install targets (ADRs 0005, 0007).
