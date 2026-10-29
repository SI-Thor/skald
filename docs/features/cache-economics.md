# Hot-prefix steering: the cache-economics architecture

> The owner's insight that shaped Lane C: let a large LLM do the *steering*
> with tiny text deltas over a hot prompt cache — and let the local GPU do
> the *last mile* to the speaker.

## The idea

An interactive show needs a smart model, but smart models are slow and
cloud-priced. The architecture splits the work by what each side is good at:

- **Steering LLM (large, API or local)**: decides *what the hosts say next* —
  a few sentences at a time. Its prompt is:
  - a **stable prefix** — article + character sheets + show bible + condensed
    memory — identical across turns, so providers' prompt caches (and local
    KV caches) hit it every time;
  - a **suffix delta** — the last few said-aloud turns + your interjection.
- **Local TTS (Thor GPU)**: renders *every audible word*. Private, free per
  minute, sub-200 ms to first audio.

## Why it's novel

Podcast generators pay the LLM for a whole script up front. Chat assistants
re-send everything each turn. Lane C's shape — long *unchanging* context
+ tiny *wandering* suffix — is the exact pattern prompt caching was built
for, applied to spoken media:

1. **Wandering keeps the cache hot.** Redirect the hosts as hard as you like;
   redirections change the *suffix*, never the prefix. The expensive part is
   paid once per session, not per turn.
2. **The big model is never in the audio-latency path.** The prefetch buffer
   (local GPU seconds, discarded on interrupt) absorbs steering latency, so
   the expensive model's speed is irrelevant to the listening experience.
3. **Cognitive cost is decoupled from audio cost.** The article is "paid"
   cognitively once; the conversation on top of it is marginal tokens.

## The measured claim

`experiments/lane-c-sim/simulate.py` instruments every turn:

```
prefix_tokens: 296        # cached, paid once
suffix_tokens_total: 507  # 8 turns incl. 3 interjections
cache_ratio: 0.369        # on a 100-word toy article
```

With a real 5,000-word article the prefix is ~1,250 tokens and the suffix
grows only with conversation length — the design doc's prediction
(`docs/design/lane-c-explorations.md` §5) is that `cache_ratio` crosses 0.8
in real use. The harness exists to keep that claim honest as the show grows.

## Where it lives

- Assembly: `experiments/lane-c-sim/show.py` (`PromptAssembler`,
  `est_tokens`, economics in `PromptAssembler.economics()`)
- Design rationale: `docs/design/lane-c-explorations.md` §5
- Pluggable steering slot: `SteeringLLM` protocol — `ScriptedLLM`
  (deterministic tests) today, `OpenAICompatLLM` (Ollama/NIM/API) next;
  same prompt shape regardless of provider.
