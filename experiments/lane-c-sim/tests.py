"""Tests for the lane-c-sim hard semantics. Plain asserts, python3 tests.py."""
import sys

from show import Ledger, PromptAssembler, ScriptedLLM, Show, CharacterSheet, est_tokens


def test_ledger_excludes_unheard_after_cut():
    led = Ledger()
    led.add("Mia", "one")
    led.add("Jason", "two")
    led.advance_playhead(1)  # heard 'one'
    led.add("Mia", "three-planned")
    dropped = led.discard_pending()
    assert [t.text for t in dropped] == ["two", "three-planned"]
    mem = led.memory()
    assert [t.text for t in mem] == ["one"], "unheard turns leaked into memory!"
    assert led.discarded_count == 2


def test_cut_now_drops_buffer_and_lands_interjection():
    llm = ScriptedLLM()
    asm = PromptAssembler("ARTICLE", [CharacterSheet("Mia", "p", "v")], "bible")
    show = Show(llm, asm, prefetch=3)
    list(show.tick(1))  # hear one turn
    assert len(show.ledger.pending) == show.prefetch - 1  # generate fills, then playhead consumed one
    show.interject("what about the methodology?")
    assert show.metrics["cuts"] == 1
    # pending dropped; next generate must react to the interjection
    t = next(show.tick(1))
    assert "methodology" in t.text.lower(), f"interjection lost: {t.text}"
    assert show.interjection is None


def test_wrap_thought_completes_then_injects():
    llm = ScriptedLLM()
    asm = PromptAssembler("A", [CharacterSheet("Mia", "p", "v")], "b")
    show = Show(llm, asm, prefetch=3)
    list(show.tick(1))
    show.dial = "wrap_thought"
    show.interject("redirect me")
    # tick: current pending turn completes (heard), interjection lands after
    heard = list(show.tick(2))
    assert len(heard) >= 1
    assert any("redirect" in t.text.lower() for t in show.ledger.turns), "wrap lost the interjection"


def test_token_economics_shape():
    asm = PromptAssembler("word " * 400, [CharacterSheet("Mia", "p", "v")], "b")
    llm = ScriptedLLM()
    show = Show(llm, asm, prefetch=1)
    for _ in range(6):
        list(show.tick(1))
    e = asm.economics()
    assert e["prefix_tokens"] >= 100
    assert e["suffix_tokens_total"] > 0
    assert 0 < e["cache_ratio"] < 1, e
    # design claim: prefix dominates for long articles
    assert e["cache_ratio"] > 0.5, f"prefix not dominant: {e}"


def test_prefetch_refill():
    led = Ledger()
    llm = ScriptedLLM()
    asm = PromptAssembler("A", [CharacterSheet("Mia", "p", "v")], "b")
    show = Show(llm, asm, ledger=led, prefetch=2)
    list(show.tick(2))
    assert len(led.pending) == show.prefetch - 2, "prefetch semantics: prefetch minus listened"


def run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"PASS {fn.__name__}")
    print(f"{len(fns)}/{len(fns)} tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(run_all())
