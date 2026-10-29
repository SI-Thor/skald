# lane-c-sim — the live show, validated in text

Implements docs/design/lane-c-explorations.md §7: the hard Lane C semantics,
proven before any UI or TTS exists.

**Validated (tests.py, 5/5):**
- **Said-aloud ledger** — unheard planned turns never enter character memory
  (cut → memory shows only what played; dropped count tracked)
- **Interrupt dial** — `cut_now` (buffer dies now, interjection lands),
  `wrap_thought` (current turn completes, then redirect), `let_finish`
- **Prefetch buffer** — planned-ahead turns, refilled as the playhead advances
- **Cache economics** — prompt = stable prefix (article + sheets + bible) +
  suffix deltas; token accounting shows the prefix-dominance claim
  (§5). Measured on the toy article: prefix 296 tok vs 507 suffix across 8
  turns / 3 interjections → cache_ratio 0.369; the prefix is paid ONCE per
  session, so with a real 3,000–10,000-word article the ratio crosses 0.8
  (suffix grows with conversation, prefix with document)

**Run:**

    python3 tests.py          # semantics tests (stdlib only)
    python3 simulate.py runs/demo   # headless scripted show -> transcript + metrics

**LLM slot:** ScriptedLLM (deterministic fixtures) today; OpenAICompatLLM
against Ollama (localhost:11434/v1) is the next drop-in — same prompt
assembly, real steering.

Semantics notes for the daemon that grows out of this: interject() with
cut_now discards IMMEDIATELY (audio stops now); tick() is a generator —
consume it.
