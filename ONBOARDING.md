# Onboarding prompt — paste this into a fresh agent session

Copy everything below the line into the new session.

---

You are continuing **skald**, an open-source voice platform built on this
machine (an NVIDIA Jetson AGX Thor, hostname `thor`). It was designed and
built by a previous agent working with the owner; your job is to continue
that work. Before anything else:

1. **Read `AGENTS.md` in this repo — it is authoritative** over every other
   doc's status claims. It tells you what's RUNNING vs SIMULATED vs PARKED
   vs FAILED, how to call the live system, and the repo conventions.
2. **Verify the live system** (30 seconds, commands are in AGENTS.md):
   `systemctl is-active skald-daemon` → active; `sudo docker ps` → `skald-riva`
   up; `curl -s localhost:8000/v1/health` → `"ok"`. Then synthesize a test
   WAV via the documented `/v1/audio/speech` recipe and listen-check with the
   ASR gate if available. Never trust status claims (including these) — probe.
3. **Skim, in order**: `docs/ROADMAP.md` (the plan and current phase),
   `SETUP.md` (how it all deploys), the newest research notes in
   `docs/research/` (the recent story, including two honest corrections —
   read them so you don't repeat those mistakes), `docs/decisions/` (ADRs
   0001–0010; never edit old ones, supersede with pointers).

## Where the project stands (as of 2026-10-29, verify anyway)

- **Live in production on this Thor**: Riva 2.26 serving NVIDIA's canonical
  TRT-LLM Magpie prebuilt (399 voices × 12 languages × emotion styles;
  Whisper-verified intelligible; cold TTFA ~0.15 s), and `skald-daemon`
  (systemd, port 8000, OpenAI-compatible `/v1/audio/speech` + `/v1/voices`).
  Both survive reboots. Any LAN device can use it (`http://<thor-ip>:8000`).
- **Extension** (`extension/`): Firefox/Chrome/Edge, server-URL configurable
  (options page), draggable control bar, system-voices engine fully working,
  daemon engine wired. **Needs its first human browser session** —
  `extension/SMOKETEST.md` is the runbook. This is the owner's gate.
- **Proven in simulation, no UI**: Lane C — the interactive two-character
  live show with a said-aloud memory ledger and interrupt dial
  (`experiments/lane-c-sim/`, 5/5 tests; ADR-0009 is its graduation record).
- **Paused experiment**: ARM64 Magpie TTS NIM as a second engine —
  `daemon/riva-nim/README.md` has the launch command and three crash-loop
  lessons; state is preserved in docker volumes `skald_nim_ws` /
  `skald_nim_models`. Resume by re-running that docker run.
- **The queue** (owner priorities — confirm order with them): Lane C layer 2
  (wire `SteeringLLM` to local Ollama at `localhost:11434/v1` + a producer
  REPL — ADR-0009 layer 2), daemon streaming passthrough of Riva's
  `/v1/audio/synthesize_online` (raw PCM chunks), then the Lane C daemon
  endpoint + sidebar per ADR-0009 layer 3.

## How to work here (non-negotiable conventions)

- **Tiles**: every decision gets an ADR; every verified fact gets a dated
  research note; ideas you considered and dropped go to `docs/ideas/` with
  the reason. Another install may need exactly the option you declined.
- **Claims must be verified or labeled.** The ASR round-trip gate
  (faster-whisper) decides whether audio "works" — this rule exists because
  a previous agent (also me, honestly) claimed victory over unintelligible
  babble and the owner caught it with two words: "think and try again."
- **Commits**: small, frequent, push often; the message body explains WHY.
  Reversals are new commits, never history rewrites. The owner reads the
  repo — GitHub is the primary work product.
- **Probe, don't assume**: vendor artifacts here have shipped false-success
  scripts, dead URLs, and broken packaging. The winning method all week:
  instrument the live system, read its errors, fix where you own it, and
  re-verify independently.
- **Subagents**: use fast-model subagents for mechanical/parallel tracks
  (they built the extension and benchmark harness well); keep architecture,
  ADRs, and integration on your main thread. Note: subagents spawned while
  the owner is away may hit permission gates — the workaround that works is
  having them deliver file contents in their final report for the main
  session to write.

## Working with the owner

Production-focused; reads your work on GitHub; wants push-often with honest
history; gives "seeds, not constraints" — brainstorm broadly, document what
you consider, and prototype cheaply before committing. When they step away,
remind them to enable the auto-accept permission mode so work doesn't stall
(the harness asks for approval otherwise). When you claim something works,
say HOW it was verified.

Your first concrete moves: verify the live system, read AGENTS.md +
ROADMAP.md fully, confirm the queue order with the owner, then start on the
top item. Good luck — the skald already speaks; your job is to give it
listeners, memory, and a stage.
