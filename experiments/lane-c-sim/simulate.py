"""Headless simulation: scripted interjections, transcript + metrics out.

    python3 simulate.py [outdir]
"""
import json
import os
import sys
import time

from show import CharacterSheet, Ledger, PromptAssembler, ScriptedLLM, Show

ARTICLE = (
    "Researchers announced a new on-device speech system today, claiming "
    "sub-200-millisecond response times on embedded hardware. The approach "
    "compiles neural vocoders directly to the target chip, trading portability "
    "for latency. Critics note that benchmark numbers without power context "
    "are meaningless on battery-constrained devices. The team counters that "
    "their measurements include thermals and sustained throughput, not just "
    "burst performance. Independent replication is pending. Meanwhile, "
    "open-source alternatives continue to close the quality gap, and several "
    "hardware vendors have announced reference designs. The real question, "
    "analysts say, is whether developers want one optimized system or many "
    "portable ones."
)
BIBLE = (
    "Two hosts, warm and curious. Short turns (1-3 sentences). Disagree politely. "
    "Refer back to earlier points. Never read the article verbatim."
)
SHEETS = [
    CharacterSheet("Mia", "Analytical, skeptical of hype, loves methodology details.", "riva:mia"),
    CharacterSheet("Jason", "Energetic connector, jumps to practical takeaways.", "riva:jason"),
]

SCRIPT = [  # (action, payload) — the producer's score
    ("listen", 2),
    ("interject", "is the 200ms claim even credible?"),
    ("listen", 2),
    ("dial", "wrap_thought"),
    ("interject", "compare it to the open-source route"),
    ("listen", 2),
    ("dial", "cut_now"),
    ("interject", "skip ahead to the ending"),
    ("listen", 3),
]


def run(outdir: str | None = None) -> dict:
    llm = ScriptedLLM()
    asm = PromptAssembler(ARTICLE, SHEETS, BIBLE)
    show = Show(llm, asm, prefetch=2)
    lines = []
    for action, payload in SCRIPT:
        if action == "listen":
            for t in show.tick(payload):
                mark = " (heard)" if True else ""
                lines.append(f"[{t.speaker}] {t.text}")
        elif action == "interject":
            lines.append(f">>> PRODUCER: {payload}")
            show.interject(payload)
        elif action == "dial":
            show.dial = payload
            lines.append(f">>> (dial -> {payload})")

    e = asm.economics()
    m = show.metrics
    metrics = {
        **e,
        "turns_total": len(show.ledger.turns),
        "turns_heard": len([t for t in show.ledger.turns if t.heard]),
        "turns_discarded": show.ledger.discarded_count,
        "llm_calls": m["llm_calls"],
        "interjections": m["interjections"],
        "cuts": m["cuts"],
    }
    print(json.dumps(metrics, indent=1))
    if outdir:
        os.makedirs(outdir, exist_ok=True)
        with open(os.path.join(outdir, "transcript.md"), "w") as f:
            f.write(f"# lane-c-sim transcript ({time.strftime('%Y-%m-%d %H:%M')})\n\n")
            f.write("\n".join(lines))
            f.write("\n\n## metrics\n```json\n" + json.dumps(metrics, indent=1) + "\n```\n")
        with open(os.path.join(outdir, "metrics.json"), "w") as f:
            json.dump(metrics, f, indent=1)
        print(f"wrote {outdir}/")
    return metrics


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else None
    run(out)
