# Thor-first benchmarking: numbers with their power context

> A Jetson RTF without its power mode is a rumor. Every skald measurement
> carries the machine state it was taken in.

## The rule (ADR-0010)

Every benchmark result embeds an environment snapshot — `nvpmodel` power
mode, clock-lock state, tegrastats sample, JetPack/L4T versions, thermals,
VIN power draw. The scorecard renders it as the header above the numbers.

Example from the live engine row:

```
Power mode (nvpmodel): 120W (mode id 1)
Clocks: no_marker (not locked)
Power draw (VIN rail): 21973 mW avg
JetPack: 7.2.1-b49, L4T R39.2.1
```

## Why it's novel (as discipline)

Published engine numbers come from datacenter cards at unrestricted power —
fish-speech S2-Pro's RTF 0.195 is an H200 figure and transfers nowhere. On
embedded boards the same model can swing **multiples** between power modes
(this Thor idles at 120 W; MAXN unlocks the ceilings) and thermal states. A
benchmark without context isn't pessimistic or optimistic — it's *not a
number*.

## The practice

1. **Capture, don't recall** — `benchmark/envsnap.py` records the machine
   state into every result JSON automatically; degrades honestly
   ("not reported") where a platform lacks a probe (JetPack 7's tegrastats
   emits no GPU/EMC fields — recorded as such, never fabricated).
2. **Comparisons within one snapshot class** — cross-power-mode comparisons
   are labeled as such.
3. **Floor before ceiling** — headline numbers ship in the *default* power
   state a user actually runs (120 W here); MAXN runs are marked as ceiling
   probes, not the operating point.
4. **Re-run on target, always** — engines are Thor-built (TensorRT
   compiled on this board); published specs are hypotheses, the harness is
   the experiment. The harness doubles as the regression suite when
   JetPack/CUDA versions move (ADR-0005).

## Where it lives

`benchmark/envsnap.py` (capture), `benchmark/report.py` (header rendering),
`benchmark/results/*.json` (every run), ADR-0010 (the rule), and the live
worked example in the current scorecard.
