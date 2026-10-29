"""lane-c-sim core: the live show state machine.

Validates the hard semantics from docs/design/lane-c-explorations.md BEFORE
any UI/TTS exists:
  - said-aloud ledger (unheard planned turns never enter memory)
  - interrupt dial (cut_now / wrap_thought / let_finish)
  - prefetch buffer (planned turns ahead of the playhead)
  - steering prompt assembly with token economics (stable prefix + suffix)
"""
from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass, field

# ---------------------------------------------------------------- tokens


def est_tokens(text: str) -> int:
    """Cheap token estimate (~chars/4). Good enough for economics tracking."""
    return max(1, len(text) // 4)


# ---------------------------------------------------------------- turns


@dataclass
class Turn:
    speaker: str  # character name or "PRODUCER"
    text: str
    seq: int
    heard: bool = False  # audio actually played past the playhead


# ---------------------------------------------------------------- ledger


class Ledger:
    """The said-aloud ledger: full transcript is debug truth; memory is
    EXCLUSIVELY turns whose audio actually played."""

    def __init__(self) -> None:
        self.turns: list[Turn] = []
        self._seq = 0
        self.playhead = 0  # index of next turn to be 'heard'

    def add(self, speaker: str, text: str) -> Turn:
        self._seq += 1
        t = Turn(speaker=speaker, text=text, seq=self._seq)
        self.turns.append(t)
        return t

    def advance_playhead(self, n: int = 1) -> list[Turn]:
        heard = []
        for _ in range(n):
            if self.playhead >= len(self.turns):
                break
            t = self.turns[self.playhead]
            t.heard = True
            heard.append(t)
            self.playhead += 1
        return heard

    @property
    def pending(self) -> list[Turn]:
        """Planned-but-unheard (the prefetch buffer)."""
        return self.turns[self.playhead :]

    def discard_pending(self) -> list[Turn]:
        """Interrupt: unheard material never happened. Returns what was dropped."""
        dropped = self.pending
        self.turns = self.turns[: self.playhead]
        return dropped

    def memory(self, last_n: int = 10) -> list[Turn]:
        """What the characters remember: heard turns only."""
        return [t for t in self.turns if t.heard][-last_n:]

    @property
    def discarded_count(self) -> int:
        return self._seq - len(self.turns)


# ---------------------------------------------------------------- steering


@dataclass
class CharacterSheet:
    name: str
    persona: str
    voice_slot: str

    def prompt_block(self) -> str:
        return f"## {self.name}\n{self.persona}\n(voice: {self.voice_slot})\n"


class SteeringLLM:
    """Protocol: given assembled prompt parts, yield the next turn's (speaker, text)."""

    def next_turn(self, prompt: str) -> tuple[str, str]:
        raise NotImplementedError


class ScriptedLLM(SteeringLLM):
    """Deterministic fixture: rotates speakers, appends scripted lines.
    Reacts to interjections by echoing a reaction template so tests can
    assert exact behavior."""

    def __init__(self, lines: list[str] | None = None) -> None:
        self.lines = lines or [
            "The introduction frames the whole question, honestly.",
            "But the data section is where it gets contentious.",
            "I'd push back on the methodology there, gently.",
            "Notice how the conclusion hedges everything.",
            "This connects to what we said earlier, actually.",
            "The middle section drags; the examples carry it.",
            "Let me play devil's advocate for a moment.",
            "So the practical takeaway is smaller than it sounds.",
        ]
        self._i = 0

    def next_turn(self, prompt: str) -> tuple[str, str]:
        # interjection reaction: if prompt ends with a producer line, respond to it
        m = re.search(r"\[PRODUCER\] ([^\n]+)", prompt)
        speakers = ["Mia", "Jason"]
        speaker = speakers[self._i % 2]
        if m:
            line = f"Good push — on '{m.group(1)[:40]}': my take is that the article undersells it."
        else:
            line = self.lines[self._i % len(self.lines)]
        self._i += 1
        return speaker, line


class PromptAssembler:
    """Stable prefix + suffix per the cache-economics design (§5)."""

    def __init__(self, article: str, sheets: list[CharacterSheet], bible: str) -> None:
        self.prefix = (
            "You are producing a live two-host show about the article below.\n\n"
            "# SHOW BIBLE\n" + bible + "\n\n"
            "# CHARACTERS\n" + "\n".join(s.prompt_block() for s in sheets) + "\n"
            "# ARTICLE\n" + article + "\n\n"
            "# CONVERSATION SO FAR (only what was actually said aloud)\n"
        )
        self.prefix_tokens = est_tokens(self.prefix)
        self.suffix_tokens_total = 0

    def assemble(self, memory: list[Turn], interjection: str | None = None) -> str:
        lines = [f"[{t.speaker}] {t.text}" for t in memory]
        suffix = "\n".join(lines) if lines else "(show has not started)"
        if interjection:
            suffix += f"\n[PRODUCER] {interjection}"
        suffix += "\n\nNext turn (speaker: text):"
        self.suffix_tokens_total += est_tokens(suffix)
        return self.prefix + suffix

    def economics(self) -> dict:
        return {
            "prefix_tokens": self.prefix_tokens,  # cached, paid once per session
            "suffix_tokens_total": self.suffix_tokens_total,  # per-turn deltas
            "cache_ratio": round(
                self.prefix_tokens / max(1, self.prefix_tokens + self.suffix_tokens_total), 3
            ),
        }


# ---------------------------------------------------------------- the show


class Show:
    def __init__(
        self,
        llm: SteeringLLM,
        assembler: PromptAssembler,
        ledger: Ledger | None = None,
        prefetch: int = 2,
    ) -> None:
        self.llm = llm
        self.asm = assembler
        self.ledger = ledger or Ledger()
        self.prefetch = prefetch
        self.dial = "cut_now"  # cut_now | wrap_thought | let_finish
        self.interjection: str | None = None
        self.metrics = {"interjections": 0, "cuts": 0, "wraps": 0, "llm_calls": 0}

    def _generate_into_buffer(self) -> None:
        while len(self.ledger.pending) < self.prefetch:
            prompt = self.asm.assemble(self.ledger.memory(), self.interjection)
            speaker, text = self.llm.next_turn(prompt)
            self.metrics["llm_calls"] += 1
            if self.interjection and speaker:
                self.interjection = None  # consumed by the next planned turn
            self.ledger.add(speaker, text)

    def tick(self, listen: int = 1) -> Iterator[Turn]:
        """Advance the show: fill prefetch, play `listen` turns past playhead.
        A pending cut_now interjection drops the buffer at tick start."""
        self._generate_into_buffer()
        for t in self.ledger.advance_playhead(listen):
            yield t

    def interject(self, text: str) -> None:
        self.metrics["interjections"] += 1
        if self.dial == "cut_now":
            dropped = self.ledger.discard_pending()  # audio stops NOW
            self.metrics["cuts"] += 1
            self.interjection = text
        elif self.dial == "wrap_thought":
            # current (next unheard) turn completes, then the interjection lands
            self.metrics["wraps"] += 1
            self.interjection = text
            self.dial = "cut_now"
        else:  # let_finish: queue behind everything planned
            self.interjection = text

    def wrap_the_thought(self) -> None:
        self.dial = "wrap_thought"
