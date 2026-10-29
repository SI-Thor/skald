# Skald on-device TTS scorecard

Generated 2026-10-29T12:33:02-08:00 — 7 result run(s) in /home/caseydigennaro/src/skald/benchmark/results. Latest run per engine:

## Environment (ADR-0010 — from newest run `riva_official-trtllm_20261029T001313`)

- Captured: 2026-10-28T23:41:50-08:00
- Device: NVIDIA Jetson AGX Thor Developer Kit — Ubuntu 24.04.5 LTS, kernel 6.8.12-1021-tegra
- JetPack: 7.2.1-b49, L4T R39.2.1
- Power mode (nvpmodel): MAXN (mode id 0)
- Clocks: no_marker (method: presence of /tmp/l4t_dfs_frequence_boost)
- Utilization (tegrastats, 5.0s): CPU 9.0%, tegrastats on this platform reports no GR3D_FREQ/EMC fields; GPU/EMC utilization not captured (CPU%, thermals and power rails were) — CPU 30.5°C, GPU 31.0°C, Tj 31.0°C
- Power draw (VIN rail): 22588 mW avg

## Scorecard

| Engine | Voice | Lang | Cold TTFA (s) | Warm TTFA med (s) | Sustained RTF | Long-doc | Failures | Date |
|---|---|---|---:|---:|---:|---|---:|---|
| mock | sine | en-US | 0.355 | 0.050 | 0.0045 | pass | 0 | 2026-10-28 |
| riva | Magpie-Multilingual.EN-US.Mia | en-US | 0.150 | 0.165 | 0.5506 | pass | 0 | 2026-10-28 |

Notes:

- **Cold TTFA** — first-ever synthesis (model load / connect included);
  **Warm TTFA** — median over the short-sentence phase.
- **Sustained RTF** — wall time / audio duration on the ~500-word passage;
  below 1.0 means the engine synthesizes faster than real time.
- **Long-doc** — the passage repeated 20x; pass = no failures and no
  audio-duration drift beyond 25% of the median.
- Subjective quality (paper / news / story, 1-5) is the other half of
  ADR-0005: listen to the probe WAVs and fill `quality-form.md`.
- Env snapshot above is from the newest run only; older runs carry their
  own `env` block inside their result JSON.
