# Subjective quality form — TTS engines (ADR-0005)

The other half of the scorecard. After listening to the probe WAVs a run
produced (run the harness with `--save-probes`; files land in
`results/probes/<run_id>/`), rate each engine per use case on a 1–5 scale:

| Rating | Meaning |
|---|---|
| 5 | Would happily listen for hours |
| 4 | Minor flaws, easy to ignore |
| 3 | Usable, flaws are noticeable |
| 2 | Flaws get in the way of listening |
| 1 | Unlistenable for this material |

**Method:** same room, same speakers/headphones, same probes, same sitting.
Listen to the whole probe before scoring; note concrete artifacts (swallowed
words, wrong stress, robotic joins, breath oddities) rather than vibes.
Copy the per-engine block below once per engine (and per voice, if an
engine is tried with several).

---

## Engine: `<name>` — voice: `<voice>` — date: `YYYY-MM-DD`

Probes listened from run: `<run_id>`

| Use case | Overall (1-5) | Naturalness | Clarity | Pacing | Artifacts heard (notes) |
|---|---|---|---|---|---|
| Paper (dense technical prose) |  |  |  |  |  |
| News (names, numbers, dates) |  |  |  |  |  |
| Story (dialogue, expressiveness) |  |  |  |  |  |

**Mispronunciations / failure words:**

- 

**Where this voice wins, where it loses:**

- 

**Tier fit (ADR-0005):** fast tier (live reading) / expressive tier
(stories, podcast lanes) / both / neither — and why:

- 

---
