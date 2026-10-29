# Roadmap

Updated: 2026-10-29 (late evening)

## Phase 0 — Spec & repo foundation ✅ (2026-10-28)

Control-surface spec agreed; two-lane architecture agreed; engine strategy and
deployment stance decided (ADRs 0001–0008); research findings recorded; this repo
created with the tiles methodology in place.

## Live track — Riva/Magpie engine ✅ (2026-10-29)

The skald has a voice: NVIDIA's TRT-LLM prebuilt for Thor
(`models_tts_magpie_multilingual_ipa:2.26.0-tegra-thor`) serving via Riva —
**Whisper-verified intelligible**, cold TTFA 0.150 s, RTF 0.55, 20/20
stability, **emotion-styled voices** (Mia/Jason × Neutral/Calm/Angry/Happy/
Sad). The full war story (15-layer repair, the babble correction, the NGC
CLI unlock) is in `docs/research/2026-10-28d…2026-10-29c` and
`daemon/riva-deploy/`. NGC pulling is now one command (native ARM64 CLI +
env auth — see research note c).

## Phase 1 status (2026-10-29)

- [x] Engine: Riva Magpie official prebuilt, live, verified
- [x] Benchmark harness + ASR intelligibility gate
- [x] Extension v0.1.0 (control bar; needs browser smoke test)
- [x] Daemon bridge v0 (OpenAI-compatible /v1/audio/speech over Riva) — live as systemd service
- [ ] Extension ↔ daemon end-to-end; AMO signing; owner daily-use exit test

## Explorations

- **Lane C — the live show** (opened 2026-10-28): interactive character podcast,
  producer-in-the-loop, vibe-coded characters and show format, simulation-first.
  Seeds, not constraints — see `docs/design/lane-c-explorations.md`. Graduates
  to an ADR when the `lane-c-sim` harness validates the core state machine.

## Phase 1 — Extension v1 + minimal daemon (next)

The goal is the *feel*: the control surface must be right before anything else grows.

- Firefox extension (Manifest V3):
  - Toolbar button + hotkey starts reading (article top, or selection if present)
  - Draggable in-tab control bar exactly as ADR-0004; live speed/volume/voice/engine
  - ⋯ expander rows; save-defaults; detach-to-window mode
  - Sentence highlighting + auto-scroll; skip by sentence
  - Engines: system voices (built-in fallback) + skald daemon
- Daemon v0 (Lane A only): OpenAI-compatible `/v1/audio/speech` + `/v1/voices`,
  sentence streaming, Kokoro engine, docker compose skeleton on jetson-containers
- Sign & install on the owner's Firefox (AMO self-distribution via `web-ext sign`)
- Exit criteria: owner reads a long article daily and doesn't fight the controls.

## Phase 2 — Expressive tier via on-device benchmark

- `benchmark/` harness: TTFA, streaming RTF, VRAM, long-doc stability, per-use-case
  quality (paper/news/story) — run on Thor
- Candidates: Kokoro (control), Piper (fallback), fish-speech S2-Pro, Chatterbox,
  Orpheus-3B
- Winner(s) wired into the daemon registry; voice cloning workflow (10–30 s reference)
- Profile switcher (📄/📰/📖) bound to engines — if not already in Phase 1

## Phase 3 — Podcast lane (Lane B)

- `/v1/jobs`: Docling extraction → chunked LLM dialogue scripting (map-reduce over
  sections; local LLM via jetson-containers/Ollama-class) → render on expressive tier
  → ffmpeg stitch → MP3 + download
- Extension "Make podcast" action with job status
- Guide prompt + monologue flag controls

## Phase 4 — Adaptive reading & ecosystem

- Local-LLM text prep on Lane A (opt-in): abbreviation expansion, citation stripping,
  style/reading-speed adaptation by content
- NIM/Riva evaluation per ADR-0008: speech NIMs on the ProArt laptop (Path A) + one
  ARM64-on-Thor container experiment (Path B); adopt only via benchmark scorecard;
  re-check after GTC DC (Nov 30–Dec 3, 2026)
- LAN clients (phone/other machines) as first-class consumers

## Open questions (owner to confirm)

1. Skip granularity on the bar: sentence / paragraph / both (working assumption:
   sentence first, shift-click paragraph soon after).
2. Profile switcher in v1 or Phase 2? (Lean: include early — cheap, high value.)
3. Post-v1 priority order: expressive-tier benchmark vs podcast lane first.
   (Lean: benchmark — it's fast and unblocks both lanes' voice quality.)
