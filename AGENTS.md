# AGENTS.md — skald for agents (human-maintained by agents, for agents)

This repo is maintained by AI agents under human direction. If you are an
agent reading this: this is your onboarding. It tells you what skald *is*,
what's *alive* vs *aspirational*, how to *use* the running system, and the
*conventions* that keep the history useful. Read this before any change.

## What skald is (60 seconds)

A voice platform for the NVIDIA Jetson Thor: **Riva serves NVIDIA's TRT-LLM
Magpie TTS** (399 voices × 12 languages × emotion styles, Whisper-verified
intelligible), fronted by a **daemon** with an OpenAI-compatible API
(`:8000`), consumed by a **Firefox/Chrome/Edge extension** that reads web
pages aloud with a live in-page control bar. Two growth lanes exist beyond
reading: **Lane B** (batch article→podcast) and **Lane C** (an interactive,
producer-directed live show with persistent characters — semantics proven in
`experiments/lane-c-sim/`, UI not built). Everything is documented as tiles:
decisions (ADRs), dated research (including failures), and ideas (never
deleted) — see `docs/`.

## Ground truth vs aspiration (do not confuse them)

- **RUNNING on the reference Thor**: `skald-riva` (container), `skald-daemon`
  (systemd :8000). Verify before trusting: `systemctl is-active skald-daemon`,
  `docker ps`, `curl localhost:8000/v1/health`.
- **WORKING, needs a human**: extension browser session
  (`extension/SMOKETEST.md`).
- **PROVEN IN SIM ONLY**: Lane C mechanics (`experiments/lane-c-sim/`,
  5/5 tests). No production UI exists for it yet.
- **PAUSED EXPERIMENT**: NIM second engine (`daemon/riva-nim/README.md` —
  read the three crash-loop lessons before resuming).
- **PARKED (works, superseded)**: from-scratch Magpie deployment
  (`daemon/riva-deploy/repair/` — its audio was NOT intelligible; the
  canonical prebuilt won).

## Using the live system (agents can do this now)

```bash
# health + voices
curl -s http://localhost:8000/v1/health
curl -s http://localhost:8000/v1/voices | python3 -m json.tool | head -30

# synthesize (voice aliases: mia, jason, aria; canonical names work too)
curl -s http://localhost:8000/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"input":"Hello from an agent.","voice":"mia"}' --output /tmp/t.wav
```

- Any LAN device can do the same against `http://<thor-ip>:8000` (unauthenticated by design; auth is a pre-client-site tile, ADR-0008).
- Riva's richer surface (streaming PCM, multipart forms) is spec'd in
  `docs/research/riva-2.26-http-openapi.json`; prefer the daemon for
  OpenAI-shape, Riva directly for streaming/chunking experiments.
- Latency claims you may rely on: cold TTFA 0.150 s, warm 0.165 s median,
  RTF 0.55 sustained (all @120 W, `benchmark/results/`).

## How to work in this repo (hard conventions)

1. **Tiles**: decisions → new ADR in `docs/decisions/` (never edit old ADRs;
   supersede with a pointer). Verified facts → dated note in
   `docs/research/`. Ideas you considered and rejected → `docs/ideas/` with
   the why. "Another install may be optimized for the option we declined."
2. **Commits**: small, frequent, message body explains *why*. Reversals are
   new commits, never rewrites. The history is written for future agents.
3. **Verify or label**: never commit "it works" without the check that
   proves it (benchmark, smoke test, ASR round-trip for anything audio).
   The ASR gate story (2026-10-29a→b) is why.
4. **Don't trust; probe**: vendor stacks here have shipped false success
   (`echo`-success scripts), dead download URLs, and RMIRs with absolute
   paths to an engineer's home dir. Probe the live system; read the error;
   instrument before guessing (see `docs/features/index.md` methodology).
5. **Model/artifact hygiene**: weights and audio never enter git
   (`.gitignore`); engine licenses live in the research notes; the
   from-scratch path's scripts are parameterized (`BASE_DIR`) — keep them so.

## Skill recipes (compose these; don't reinvent)

- **"Make the machine say X"** → daemon `/v1/audio/speech` (above). For
  streaming PCM use Riva `/v1/audio/synthesize_online` (chunked, no WAV
  header — wrap or pipe raw).
- **"How fast is engine E?"** → `benchmark/`: `./benchmark/run --engine riva
  --voice <name>` (installs `nvidia-riva-client` into a venv first); report
  via `./benchmark/run report`. Intelligibility gate is mandatory for any
  "working" claim.
- **"Change the deployed Riva"** → stop container, edit
  `~/src/skald-riva/model-repo-official/...` (host-visible), `rm -rf
  __pycache__` inside the model dir, `03_start_server.sh restart`, probe.
  The backend module (`magpie_unified_model.py`) ships with the repo and
  carries our shims — extend them idempotently (marker comments).
- **"Pull anything from NGC"** → native CLI at `~/src/ngc-cli-arm/ngc-cli/ngc`
  with `NGC_CLI_API_KEY` + `NGC_CLI_ORG=nvidia` env (see `SETUP.md` §1).
- **"Test Lane C logic"** → `python3 experiments/lane-c-sim/tests.py`; extend
  `show.py` (ledger/dial/prefetch) before any UI work; ADR-0009 is the
  graduation gate.

## Fast pointers

| Want | Go |
|---|---|
| The plan | `docs/ROADMAP.md` |
| Why any decision | `docs/decisions/0001…0010` |
| What happened & why (incl. failures) | `docs/research/` |
| What's novel (for humans) | `docs/features/index.md` |
| Live-show design | `docs/design/lane-c-explorations.md` |
| Deploy from zero | `SETUP.md` |
| Voice quality verdicts needed | `benchmark/quality-form.md` |
