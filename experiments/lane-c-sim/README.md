# lane-c-sim — the live show, validated in text

Implements docs/design/lane-c-explorations.md §7: the hard Lane C semantics,
proven before any UI or TTS exists.

**Status (ADR-0009):** layer 1 semantics **DONE**; layer 2 steering + producer
REPL **DONE**; layer 3 (daemon show endpoint + sidebar) is next.

**Validated (tests.py, 9/9):**

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
- **OpenAI-compatible steering** (layer 2) — against a fake stdlib HTTP
  server: `Speaker: text` parse success, malformed-content round-robin
  fallback, non-JSON envelope / HTTP error / timeout → `SteeringError`,
  `/models` probe. Plus producer-command parsing (`parse_command`).

**Run:**

    python3 tests.py                    # semantics + steering tests (stdlib only)
    python3 simulate.py runs/demo       # headless scripted show -> transcript + metrics
    python3 repl.py                     # producer REPL, scripted steering
    python3 repl.py --llm openai        # real steering via an OpenAI-compatible endpoint
    python3 repl.py --article my.txt --prefetch 3

**The producer REPL** — the show auto-advances (heard turns print as they
play); you steer:

    <plain text>      question to the room (an interjection)
    @Mia <text>       address one character (any cast name)
    !cut / !wrap      interrupt dial: cut_now / wrap_thought
    !pause / !resume  stop / restart playback
    !state            said-aloud ledger (heard / pending / discarded)
    !metrics          token economics + show counters
    !quit             end the show

Input is polled with POSIX `select` between ticks (one turn per ~0.5s), so
the show keeps playing while you type; only `!pause` blocks on a prompt.
With `--llm openai` the endpoint is probed once at startup (`{base}/models`);
if unreachable it warns and falls back to scripted steering, and generation
failures mid-show (`SteeringError`) never kill the session.

**LLM slot:** `ScriptedLLM` (deterministic fixtures) and `OpenAICompatLLM`
(`llm.py`, stdlib urllib — any `/chat/completions` endpoint). Env config,
read at startup:

    LANE_C_LLM_BASE_URL     default http://localhost:11434/v1  (Ollama on this box)
    LANE_C_LLM_MODEL        default llama3.1
    LANE_C_LLM_TIMEOUT      default 30 (seconds)
    LANE_C_LLM_TEMPERATURE  default 0.8

The model must answer in `Speaker: text` form (max_tokens 120); responses
that don't parse degrade to a round-robin speaker with a stderr note rather
than killing the show.

Semantics notes for the daemon that grows out of this: interject() with
cut_now discards IMMEDIATELY (audio stops now); tick() is a generator —
consume it.
