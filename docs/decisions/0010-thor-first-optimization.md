# ADR 0010 — Thor-first optimization principles

- **Status:** Accepted (2026-10-28)
- **Context:** Owner directive — *"think NVIDIA Thor specific when possible because
  we are optimizing for our own setup."* The Thor (Blackwell GPU, 128 GB unified
  LPDDR5X, 14-core ARM, 2× DLA, JetPack 7 / CUDA 13) is both our first-class
  machine and the reference install for SI-Thor client deployments.

## Principles

1. **TensorRT-first.** Engines are compiled on-target (riva-deploy's engine
   build; ONNX→TensorRT for open engines like Kokoro). ONNX-runtime and CPU
   paths exist only as labeled fallbacks. Rationale: TensorRT on Blackwell is
   the fast path, and plan files built on the Thor are built *for* the Thor.
2. **No benchmark number without power context.** Every measurement records:
   `nvpmodel` power mode (e.g. today's 120 W mode), clock state
   (`jetson_clocks` applied or not), `tegrastats` GPU/EMC utilization, and
   thermals. On Jetson, an RTF without that context is meaningless — clocks
   and power caps move scores by multiples. The `benchmark/` harness logs all
   of it automatically (ADR-0005 scorecard requirement).
3. **Exploit unified memory.** No PCIe-copy avoidance needed — CPU and GPU
   share the 128 GB pool. Tune Triton's CUDA memory pool above the start-riva
   default (1 GB is conservative); large TTS prefetch buffers cost RAM, not
   VRAM planning. Revisit per engine with measured footprints.
4. **Right-size concurrency for the two-host show.** Lane C needs two voices
   interleaving sentence-by-sentence. Experiment explicitly:
   `instance_group_count=2` vs dynamic batching vs serial turns — measure
   which serves conversational turn-taking with lowest TTFA.
5. **Precision is a benchmark dimension.** fp16 default (per model card);
   sweep INT8/FP8 candidates for the codec/vocoder stages where quality
   impact is low and throughput gain is high.
6. **DLA stays a tile.** The Deep Learning Accelerators suit small fixed
   topologies, not autoregressive TTS. Revisit only if a tiny model lands on
   the box (e.g. wake-word or VAD alongside the reader).

## Consequences

- Skald engine artifacts are Thor-built: a JetPack upgrade means a rebuild +
  benchmark rerun (the harness doubles as the regression test, per ADR-0005).
- Other SI-Thor client installs run the same harness on their boards; the
  ADR-0002 daemon API keeps every client portable while engines stay
  board-specific.
- We knowingly trade portability of binaries for speed on the reference box.
