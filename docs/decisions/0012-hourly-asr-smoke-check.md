# ADR 0012 — An hourly health check with an ASR gate, logged to the journal

- **Status:** Accepted (2026-10-30)
- **Context:** Production means the owner reads every day after reboots
  without anyone fixing it. The intelligibility saga (research notes
  2026-10-29a→b) taught the concrete lesson: a TTS stack can return 200s
  while producing babble, and a whisper-venv in /tmp silently turned the
  gate into a skip. An unattended system needs a check that (a) runs on a
  schedule, (b) proves audio is *intelligible*, not merely that endpoints
  answer, and (c) fails loudly when its own instrumentation is broken.

## Decision

1. **A systemd user timer** (`daemon/systemd/user/skald-smoke.timer`,
   `OnCalendar=hourly`, `Persistent=true`) runs
   `daemon/server/test_smoke.py --require-asr` via the persistent ASR venv
   (`~/src/skald/.venv-asr`). User units (not system) so it runs as the
   daemon's user without root and lives beside the user's other units;
   `loginctl enable-linger` makes it boot-persistent.
2. **The ASR round-trip is the gate**: whisper must hear the utterance, and
   `--require-asr` makes a missing whisper a FAIL, never a skip. A 200 from
   Riva is not evidence of working audio.
3. **Journal is the alert channel**: pass/fail and the heard text are logged
   (`journalctl --user -t skald-smoke`), greppable and timestamped. No
   notifications are built yet — the journal is the substrate a future
   notify tile reads.
4. **No auto-remediation on purpose.** A failed check does not restart the
   daemon or Riva: restart loops can hide real failures and the box shares
   tenants whose services we do not touch. A human (or the director) reads
   the journal and decides.

## Consequences

- The check synthesizes one sentence hourly — negligible load, and it doubles
  as a keep-warm probe between long idle gaps.
- Its artifacts (`smoke_out.wav`) go to `~/.local/state/skald-smoke/`, never
  the repo (weights and audio stay out of git).
- The unit's 5-minute timeout is derived from measured contention
  (10–22 s per sentence at GPU 97%, `docs/research/2026-10-30-lan-latency-under-load.md`),
  not guessed.
- The agent repo carries the install files; enabling on the live system is
  the director's act, after review (same deployment rule as everything).
