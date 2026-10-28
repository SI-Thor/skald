# Ideas backlog — tiles for later (and for other installs)

Per ADR-0007: nothing considered is thrown away. Each entry records what the idea is,
why it wasn't taken *for this install now*, and where it might fit better later — a
different client, a different phase, or a different product entirely.

## Voice & listening

- **Clone the owner's own voice** as the universal narrator.
  Not now: cloning quality evaluation belongs to Phase 2 with the engine benchmark.
  Fits: any install where the listener has a strong preference for a familiar voice
  (family member reading to kids, brand voice for client content).
- **ASR voice control of the reader** ("skip this section", "slower") via Parakeet-class
  local ASR on the Thor. Not now: adds a microphone pipeline to a v1 that must nail the
  control bar first. Fits: kiosks, accessibility installs, car/kitchen use cases.
- **Hover-to-read mode** — read the paragraph under the cursor without clicking.
  Not now: interaction conflicts with draggable bar need design care. Fits: scan-reading
  research workflows, low-vision users who point better than they select.
- **Reading queue across tabs** — enqueue articles, drain like a podcast playlist.
  Not now: state/sync complexity before v1 feels right. Fits: news-junkie installs,
  commutes, "read it later" integrations.
- **Per-site remembered settings** (voice/speed per domain). Not now: needs the profile
  system first, else it fragments settings. Fits: heavy multi-site users.
- **Adaptive speed by content density** — local LLM judges difficulty, nudges wpm.
  Deferred to Phase 4 with LLM text prep. Fits: student/technical-reader installs.
- **Auto profile detection** — classify page as paper/news/story, pick the profile.
  Cheap once profiles exist; deliberately manual at first so the owner stays in charge
  of the A/B evaluation that motivated this whole project.

## Podcast lane extensions

- **Intro/outro music beds + chapter markers** in generated MP3s. Later: polish.
- **Distinct cloned host personas** (two consistent synthetic hosts across episodes).
  Phase 3+, after cloning quality is proven. Fits: client-branded content pipelines.
- **Drama 3 (35B-A3B) batch-quality experiment** — too heavy for live, but maybe the
  best offline narrator on 128 GB. One experiment when Lane B exists.
- **"Explain this" ear-hook** — while listening, press a button; local LLM elaborates
  the current sentence in-ear, then resumes. Needs LLM in/near the hot path — exactly
  what Lane A avoids, so it must be strictly opt-in. Fits: technical readers.

## Infrastructure / ecosystem

- **House-wide announcement mode** — daemon broadcasts to LAN clients (phone, speakers):
  "printer finished," doorbell, calendar nudges. The shared daemon was designed for
  this (ADR-0002). Fits: smart-home installs, small offices.
- **Export article → MP3 directly from the bar** (mini podcast lane without dialogue).
  Cheap once Lane B's renderer exists. Fits: offline listening, driving.
- **NIM drop-in when ARM64 lands** — re-run the benchmark scorecard against NIM speech
  containers. Trigger is external (NVIDIA shipping), so this is a re-check, not work.
  *Update 2026-10-28 (later):* NIM prereqs now list ARM64 CPUs and a ProArt x86 laptop
  joined the fleet — see ADR-0008 for the two concrete evaluation paths; this idea
  graduated from "wait for trigger" to "scheduled experiment." Re-check everything
  after GTC DC (Nov 30–Dec 3, 2026).
- **Broadcast-style mic processing for Linux calls** (PipeWire/WebRTC denoise on the
  Thor as a system audio node) — out of scope for skald (NVIDIA Broadcast is
  Windows-only), but the Thor could host the Linux equivalent for a client whose calls
  matter. Separate project tile.
- **Position sync across devices** — stop reading on the desktop, resume on a phone
  client. Only meaningful after LAN clients exist (Phase 4).
- **JEV / pi-agent (typesafe.ai) as a cheap decision model** — owner has this installed
  in the environment; candidate for routing small decisions (engine pick per request,
  retry policy) at near-zero cost instead of a big model. Not needed until the daemon
  has decisions worth delegating.

## Explicitly rejected (for this install; see also ADRs)

- Forking Read Aloud (ADR-0001) — revisit only for cloud-voice-zoo client requirements.
- Coqui/XTTS as an engine (ADR-0003/0005) — dead project, license-restricted.
- NIM dependency today (ADR-0006) — x86 + enterprise license; revisit on ARM64.
- Reader-mode UI — the owner explicitly doesn't use it; page-as-is with highlighting.

## Added 2026-10-28 (late evening — Riva deploy session + Lane C brainstorm)

- **GGUF Magpie on llama.cpp (CPU engine).** HF ships f16/q8_0 GGUF builds of
  Magpie 357M. A llama.cpp TTS path would give a zero-GPU fallback engine for
  any client host. Fits: tiny edge installs, CPU-only kiosks, phones someday.
- **Riva HTTP :50000 bridge probe.** Riva 2.26 ships an HTTP server next to
  gRPC; if its API is OpenAI-shaped (or close), the skald daemon bridge becomes
  trivial. One evening, once the server is up. Fits: every Riva-hosting install.
- **Voice-slot indirection.** Characters bind to a registry voice *slot*, not a
  concrete voice — personas survive engine upgrades (fixed Magpie voices today,
  cloned voices when the expressive tier lands). Adopted into Lane C design.
- **Producer-as-character.** The listener enters show memory and
  relationships.json; hosts relate to *you* over time. Part of Lane C design doc.
- **Method-mode character creation.** Perform the character yourself in 1st
  person; the system distills your performance into the persona sheet. In the
  Lane C doc; needs sim validation.
- **Subagent content-relay ops pattern.** When approval gates block subagent
  writes, the subagent delivers file content in its final report; the main
  session materializes verbatim on resume. Worked 2026-10-28; reusable for any
  unattended session. (Also in research note d, §5.)


## Added 2026-10-28 (later, from the NVIDIA toolkit survey)

- **TAO Toolkit — per-client custom TTS voices.** Fine-tune brand voices for client
  installs; a sellable SI-Thor service ("your narrator"). Tile: business, post-Phase-2.
- **NGC private registry — SI-Thor distribution backbone.** Push adapted per-client
  images; technicians pull on site. Tile: deployment story for every install, not just
  skald. Alternative: GitHub Container Registry if NGC gating is annoying.
- **Nsight Systems — benchmark profiling.** Fold into `benchmark/` to see where
  time-to-first-audio actually goes (GPU vs queue vs synthesis). Tile: Phase 2.
- **LAN worker trust boundary.** Shared-secret or wireguard between daemon and
  upstream workers before any client-site deployment (raised by ADR-0008).
- **Riva L4T early-access experiment on Thor.** Gated build; one evening to try the
  l4t-aarch64 speech containers; adopt only if benchmark-worthy and licensable.
- **Omniverse Audio2Face talking avatar.** Only if a future client wants a face with
  the voice. Tile: other installs.
- **Isaac / Metropolis / Clara / DRIVE as install families.** Not skald — but the
  "technicians installing hardware" business will meet these on other jobs; the tiles
  methodology (ADR-0007) applies to them exactly as it does here.
