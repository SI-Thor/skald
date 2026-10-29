# Voice slots: personas that survive engine churn

> A character binds to a *name in the voice registry*, never to a voice file
> — so the persona outlives every engine generation.

## The problem it solves

TTS voices are the least stable part of a voice platform: engines get
replaced (this project replaced its engine architecture twice in one week),
voices get renamed across releases, cloning tiers arrive later than
personas. Any character system that stores "voice = file X" or
"voice = model Y's speaker 3" breaks on the first upgrade — and takes the
user's relationship with the character down with it.

## The mechanism

```
character file          daemon registry              engine
voice_slot: riva:mia ──▶ "mia" → Magpie-Multilingual
                                   .EN-US.Mia ────────▶ TRT-LLM render
       ▲                                                  │
       └── upgrade swaps THIS mapping only, persona untouched
```

- The daemon's `/v1/voices` publishes the live mapping (399 voices today).
- Character files reference the slot (`riva:mia`); aliases (`mia`, `jason`,
  `aria`) resolve server-side.
- The emotion dimension rides along free: `Mia` vs `Mia.Happy` are registry
  entries, not new personas — measured to cost zero extra latency.

## Proven on this project

The Lane C design assumed zero-shot cloning would provide character voices
"from a 10–30 s sample." The open checkpoint then shipped *without* cloning,
and the deployment path changed architecture entirely — twice. Because
characters (in design and sim) reference slots, none of that churn touched a
persona. When the cloning tier arrives (zeroshot NIM or
fish-speech/Chatterbox), slot `riva:mia` re-resolves to a cloned voice and
every character inherits it by one registry edit.

## Where it lives

`daemon/server/voices.py` (registry + alias resolution),
`daemon/server/app.py` (`/v1/voices` with locale/speaker/style metadata),
character-file anatomy in [character-files.md](character-files.md), the
correction trail in `docs/research/2026-10-28d` §6.
