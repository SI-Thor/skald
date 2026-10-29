# benchmark/ — on-device TTS engine scorecard

Status (2026-10-29): **live-verified** — all four phases pass against the
production Riva server (voice `Magpie-Multilingual.EN-US.Mia`), and the mock
engine keeps the harness itself testable offline. Curated evidence lives in
`evidence/` (committed); raw run JSONs land in `results/` (gitignored —
redirect with `--results-dir` if you want them elsewhere). Spec: ADR-0005
(engine strategy) and ADR-0010 (Thor-first: no benchmark number without
power context).

Published RTF numbers come from datacenter GPUs (e.g. fish-speech S2-Pro's
0.195 is an H200 figure) and do not transfer to the Thor's embedded
Blackwell. Engine selection is therefore decided by measurements on the
actual target hardware, in the power state it will actually run in.

## Layout

| File | Role |
|---|---|
| `envsnap.py` | ADR-0010 environment snapshot embedded in every result JSON |
| `engines.py` | `Engine` interface, `MockEngine` (deterministic sine), `RivaEngine` |
| `harness.py` | CLI; runs the 4 scorecard phases, writes one JSON per run |
| `report.py` | Renders the Markdown scorecard from all result JSONs |
| `quality-form.md` | Subjective 1–5 rating template (paper / news / story) |
| `run` | Shell launcher; `pyproject.toml` optional `[riva]` extra |
| `results/` | Raw run output — gitignored (write location; redirect via `--results-dir`) |
| `evidence/` | **Committed** scorecard + canonical run JSONs backing doc claims |

## Quickstart (verified on this host)

From the repository root:

```sh
# Mock demo — full scorecard run, ~25 s, writes results/mock_demo_<ts>.json
./benchmark/run --engine mock --label demo --save-probes

# Scorecard — Markdown table from every result JSON
./benchmark/run report
```

Equivalent module form (what `run` wraps):

```sh
python3 -m benchmark run --engine mock --label demo
python3 -m benchmark report
```

A typical pass looks like:

```
[1/4] cold first synthesis (9 words)      ttfa=0.354s
[2/4] 8 short sentences (warm TTFA)       ttfa median=0.050s
[3/4] sustained passage (495 words)       wall=0.922s audio=198.0s rtf=0.0047
[4/4] long-doc stability (20 x passage)   pass — 0 failure(s)
```

`report` output can be archived with `--out`, e.g.
`./benchmark/run report --out results/scorecard-$(date +%F).md`.

## Dependencies

- Python **3.10+**, standard library only — no installs needed for the mock
  path (verified with the system CPython 3.12 on the Thor).
- Optional, only to target a live Riva server:

  ```sh
  python3 -m pip install -e './benchmark[riva]'   # pulls nvidia-riva-client
  ```

  The import is lazy: without it, `--engine riva` fails fast with an
  install hint (exit 2) and everything else still runs.

## What a run measures

Every run puts **one JSON file** in `results/` named
`<engine>_<label>_<timestamp>.json`, containing the engine config, the env
snapshot, and four phases (all timed harness-side with `perf_counter`, so
numbers are comparable across engines):

1. **cold** — first-ever synthesis on a fresh engine object (model load /
   gRPC connect included). Timed separately from everything warm.
2. **short** — N short sentences (default 8); per-sentence TTFA, reported
   as median/min/max. Sentences include names, numbers, and nested clauses.
3. **passage** — a fixed ~495-word passage as one sustained stream; RTF =
   wall time / audio duration (audio duration computed from PCM byte count
   at the engine's declared sample rate). RTF < 1.0 = faster than real time.
4. **longdoc** — the passage repeated 20x (~9,900 words). Pass = no errors,
   no zero-audio iterations, no per-iteration audio-duration drift beyond
   25% of the median (desync / degradation heuristic). If the very first
   iteration fails, remaining ones are skipped rather than hammering a dead
   engine.

Add `--save-probes` to also write `sentence.wav` + `passage.wav` (16-bit
mono PCM) under `results/probes/<run_id>/` for subjective listening
(`quality-form.md` is the template for that half of ADR-0005).

Exit codes: `0` all phases clean, `1` phases ran but failures recorded
(result JSON still written), `2` engine unavailable (nothing measured).

### CLI reference (`run` phase)

| Flag | Default | Meaning |
|---|---|---|
| `--engine` | `mock` | `mock` or `riva` |
| `--voice` | engine default | voice name (`sine` / e.g. `Magpie-Multilingual.EN-US.Mia` (live names: `curl localhost:8000/v1/voices`)) |
| `--language-code` | `en-US` | passed through to the engine |
| `--riva-uri` | `localhost:50051` | gRPC endpoint |
| `--label` | `run` | baked into the result filename |
| `--results-dir` | `benchmark/results` | where JSONs go |
| `--sentences` | 8 | warm-TTFA sentence count |
| `--repeats` | 20 | long-doc repetitions |
| `--tegrastats-seconds` | 5 | env-sample length (`0` disables) |
| `--save-probes` | off | write listening WAVs |

`report [--results-dir DIR] [--out FILE]` — one row per engine (latest run,
all runs counted), sorted by engine, env header from the newest run.

## Environment snapshot (ADR-0010)

`envsnap.capture()` records, with the method used for each:

- **Power mode** — `nvpmodel -q` (here: `120W`, mode id 1).
- **Clock state** — presence of `/tmp/l4t_dfs_frequence_boost`, the marker
  the L4T `jetson_clocks` script historically touches when locking clocks.
  Absent → recorded as `no_marker` = treated as *not locked*, with the
  caveat that newer L4T builds may lock clocks without the marker; the
  tegrastats sample also records `cpu_freq_range_mhz` (e.g. 972–2601 MHz =
  clearly varying DVFS) as corroborating evidence. This is the documented
  proxy, not a guarantee.
- **tegrastats** — 5 s sample (`--interval 500`): avg CPU%, GPU% (GR3D),
  EMC%, CPU/GPU/Tj temps, VIN rail power. **Known gap on this host:** JetPack 7
  (L4T R39.2.1) `tegrastats` on the Thor prints no `GR3D_FREQ`/`EMC` fields,
  so GPU/EMC utilization is recorded as absent with an explicit note rather
  than faked; CPU%, thermals and power are captured. When Riva is actually
  under load, re-check whether a newer tegrastats (or jtop) fills the gap.
- **Platform** — `/proc/device-tree/model`, `/etc/os-release`, kernel,
  `/etc/nv_tegra_release` (L4T), `dpkg-query nvidia-jetpack` (JetPack).

On non-Jetson hosts every probe degrades to an explicit `unavailable`
marker (e.g. `nvpmodel unavailable (non-Jetson host?)`) so the harness and
the mock path run anywhere; results then just carry less context.

## Verification status

- **`RivaEngine` call shapes — VERIFIED live (2026-10-29).** All four
  phases pass against the production Riva server; the documented gRPC
  shapes worked first-try (the `UNVERIFIED` markers in `engines.py` are
  historical). Request-side chunking was added for the server's caps
  (2000 chars/request, 400 tokens/sentence).
- **Still unverified:** GPU/EMC utilization from tegrastats on JetPack 7 /
  Thor (platform doesn't report it — recorded as such, see above).

Verified working on this host (2026-10-28/29): mock demo run + probe WAVs +
scorecard render + `python3 -m benchmark` entry + riva-without-dependency
error path + report-on-empty error path + live-Riva 4-phase run (Mia) +
second independent live run by a cold-eyes agent.
