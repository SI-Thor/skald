# CLAUDE.md — skald

Read **AGENTS.md** first: it is authoritative for what skald is, what is live,
and this repo's conventions (ADRs in `docs/decisions/`, dated notes in
`docs/research/`, ideas never deleted, small commits that explain why, never
rewrite history). This file adds only what a Claude session on Casey's
machines needs on top of it.

## Who it is for

Skald is Casey's own read-aloud and voice service. The first user is Casey,
on the **ProArt** laptop (Windows 11 + WSL), reading web pages aloud in
**Chrome** (Firefox is not installed there). Production means: Casey clicks,
and a page is read aloud from the Thor with a sub-second start, every day,
after reboots, without anyone fixing it.

## Where things run

| Piece | Machine | How to reach / check |
|---|---|---|
| Riva (Magpie TTS, TRT-LLM) | Thor `192.168.0.78` | container `skald-riva`, restart unless-stopped, `:50000` |
| skald daemon (OpenAI-shaped API) | Thor | systemd `skald-daemon`, enabled at boot, `http://192.168.0.78:8000/v1/health` |
| Chrome extension | ProArt | unpacked from `C:\Users\casey\skald-extension` (a copy of `extension/`); Server URL set to `http://192.168.0.78:8000` in its options, then **Grant** |
| Repo working copies | Thor `~/src/skald` (the deployed tree), ProArt `~/projects/skald` | GitHub `SI-Thor/skald` (Casey's org; push allowed) |

Access to the Thor: `ssh thor-lan`. Casey gave full SSH access and sole use of
the Thor (see the last-mile notes); log every change to a shared service, with
its undo, in `~/last-mile-ops.md` on the Thor.

## How work is done

- **Coders on the Thor do the changes** (Casey, 2026-10-30): briefs go to the
  AI seats (zcode, mcode) in worktrees of `~/src/skald` on the Thor; they
  follow AGENTS.md and commit there with full messages; the director reviews,
  then pushes to GitHub (the Thor's GitHub keyring locks after a reboot, so
  push from the ProArt: `git fetch thor main && git push origin main`).
- **"Working audio" means an ASR round-trip**, never a 200:
  `daemon/server/.venv/bin/python daemon/server/test_smoke.py --require-asr`
  on the Thor (whisper lives in the persistent `~/src/skald/.venv-asr`).
- **Latency is the product.** Measure first audio from the ProArt, not only on
  the Thor, and record the box's load beside every number: the Thor is shared
  with last-mile's decision models, and contention there is what Casey hears.

## Open as of 2026-10-30

- From the ProArt, a short line took 1.4–4.9 s with the Thor at load ~100 and
  GPU 97% (last-mile jobs); the scorecard's 0.165 s is the unloaded case.
- The extension README documents Firefox only (temporary install); Chrome is
  the target here.
- The intelligibility gate is not yet run on a schedule.
