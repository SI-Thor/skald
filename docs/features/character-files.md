# Character files: personas as versioned text

> A skald character is a directory, not a database row — edited by
> conversation, versioned by git, hot-reloaded into the live show.

## The idea

Creating a character in most systems means filling a form or writing a prompt
you can't diff. Skald characters are **files the producer shapes in a
green-room chat session**:

```
characters/mia/
├── persona.md           # identity, worldview, speech patterns, tics,
│                        #   what she never says
├── voice.yaml           # voice SLOT (registry id) + style defaults
├── relationships.json   # dynamics with other hosts — and with the producer
└── memory/
    ├── episodic/        # per-show summaries
    └── semantic.md      # durable facts & opinions ("Mia now believes X")
```

Talk to the green room — *"make her wearier", "she should distrust vendors"*
— and the file diffs; the next show turn already reflects it. Because
generation is small-delta (see [cache-economics.md](cache-economics.md)),
auditioning a change costs seconds and a few tokens: *vibe-coding for
characters*.

## What's novel

1. **Audition while shaping.** The character replies in their actual voice
   during the green-room session — you hear the persona as you tune it, and
   can A/B emotion styles (Mia vs Mia.Calm vs Mia.Sad are already live
   registry voices).
2. **Two creation modes.** *Director*: describe them in third person, a
   casting pass asks the seed questions. *Method*: perform them yourself;
   the system distills your performance into the sheet.
3. **Git as the biography.** `git log characters/mia/` *is* how the character
   developed — every opinion change is a commit with a reason. For an
   open-source install business, a character file is portable, reviewable,
   and forkable like any other configuration.
4. **Memory with provenance.** The semantic tier's entries are citable in
   show dialogue ("last week, when we covered…") because they carry their
   episode source.

## The voice slot (companion feature)

`voice.yaml` binds to a **registry slot**, never a concrete voice file:

```yaml
voice_slot: riva:mia        # resolves via daemon /v1/voices
style_default: Neutral
```

Consequence: when the cloning tier lands (fish-speech/Chatterbox benchmark,
or the gated zeroshot NIM), Mia's persona survives the engine swap
untouched — only the slot's resolution changes. It already survived one
engine generation on this Thor (see
[voice-slot-indirection.md](voice-slot-indirection.md)).

## Where it lives

Design: `docs/design/lane-c-explorations.md` §1 (green room), §4 (memory
tiers). Semantics proven in `experiments/lane-c-sim/` (ledger + prompt
assembly are the character-memory engine). Starter files ship with the sim
(`characters/` in the next drop); the sidebar's character cards are the UI
surface (Phase 4).
