"""The producer REPL — the layer-2 interactive surface (ADR-0009).

The show auto-advances: every ~0.5s another planned turn is "heard" and
printed as it plays. You steer from the producer chair:

    <plain text>      question to the room (an interjection)
    @Mia <text>       address one character (any character name)
    !cut              interrupt dial -> cut_now (audio stops NOW)
    !wrap             interrupt dial -> wrap_thought (finish, then pivot)
    !pause / !resume  stop / restart playback
    !state            said-aloud ledger: heard / pending / discarded
    !metrics          token economics (PromptAssembler) + show counters
    !quit             end the show

Input is polled with POSIX select(2) between ticks so the show keeps
playing while you type; only while paused does the repl block on a prompt.
Usage:

    python3 repl.py                      # scripted steering (default)
    python3 repl.py --llm openai         # OpenAI-compatible endpoint (env-config)
    python3 repl.py --article my.txt --prefetch 3

With --llm openai the endpoint is probed once at startup ({base}/models);
if unreachable, the repl warns and falls back to scripted steering.
"""
from __future__ import annotations

import argparse
import select
import sys
import time

from show import PromptAssembler, ScriptedLLM, Show, SteeringLLM
from simulate import ARTICLE, BIBLE, SHEETS
from llm import OpenAICompatLLM, SteeringError

POLL_SECONDS = 0.5  # cadence: one heard turn per poll when the buffer has material


# ---------------------------------------------------------------- commands


def parse_command(line: str) -> dict:
    """Pure producer-line -> action object (unit-tested).

    Kinds: ask_room{text} ask_char{speaker,text} dial{dial} pause resume
    state metrics quit unknown{command} none
    """
    s = line.strip()
    if not s:
        return {"kind": "none"}
    if s.startswith("!"):
        cmd, _, _rest = s[1:].partition(" ")
        table = {
            "cut": {"kind": "dial", "dial": "cut_now"},
            "wrap": {"kind": "dial", "dial": "wrap_thought"},
            "pause": {"kind": "pause"},
            "resume": {"kind": "resume"},
            "state": {"kind": "state"},
            "metrics": {"kind": "metrics"},
            "quit": {"kind": "quit"},
        }
        return table.get(cmd.lower(), {"kind": "unknown", "command": cmd.lower()})
    if s.startswith("@"):
        parts = s[1:].split(None, 1)
        if not parts:
            return {"kind": "ask_room", "text": s}
        speaker = parts[0].rstrip(":")
        text = parts[1].strip() if len(parts) > 1 else ""
        return {"kind": "ask_char", "speaker": speaker, "text": text}
    return {"kind": "ask_room", "text": s}


# ---------------------------------------------------------------- views


BANNER = """\
=== lane-c producer REPL — the show auto-advances; you steer ===
  <text>         ask the room        @Mia <text>  address one character
  !cut / !wrap   interrupt dial      !pause / !resume
  !state         said-aloud ledger   !metrics     token economics
  !quit          end the show
"""


def fmt_state(show: Show) -> str:
    led = show.ledger
    heard = [t for t in led.turns if t.heard]
    lines = [
        "== said-aloud ledger ==",
        f"heard:     {len(heard)} (playhead {led.playhead})",
        f"pending:   {len(led.pending)} in prefetch buffer (dial: {show.dial})",
        f"discarded: {led.discarded_count} planned turns never aired",
    ]
    if heard:
        lines.append("memory (all the characters can remember):")
        lines += [f"  [{t.speaker}] {t.text}" for t in led.memory()]
    if led.pending:
        lines.append("pending (a cut_now would erase these):")
        lines += [f"  [{t.speaker}] {t.text}" for t in led.pending]
    return "\n".join(lines)


def fmt_metrics(show: Show, asm: PromptAssembler) -> str:
    e = asm.economics()
    m = show.metrics
    return "\n".join(
        [
            "== metrics ==",
            f"tokens: prefix {e['prefix_tokens']} (cached) "
            f"+ suffix {e['suffix_tokens_total']} -> cache_ratio {e['cache_ratio']}",
            f"show:   llm_calls {m['llm_calls']}, interjections {m['interjections']}, "
            f"cuts {m['cuts']}, wraps {m['wraps']}",
        ]
    )


# ---------------------------------------------------------------- the loop


def _interjection_text(action: dict) -> str:
    if action["kind"] == "ask_char":
        return f"@{action['speaker']}: {action['text']}" if action["text"] else f"@{action['speaker']}?"
    return action["text"]


def run_repl(show: Show, asm: PromptAssembler, stdin=None, stdout=None) -> None:
    stdin = stdin if stdin is not None else sys.stdin
    out = stdout if stdout is not None else sys.stdout

    def say(msg: str) -> None:
        out.write(msg + "\n")
        out.flush()

    def read_blocking() -> str:
        # Prompt only while paused; on a terminal input() gives line editing.
        if stdin is sys.stdin:
            return input("producer (paused) > ")
        out.write("producer (paused) > ")
        out.flush()
        return stdin.readline()

    say(BANNER)
    paused = False
    consecutive_errors = 0
    try:
        while True:
            if paused:
                line = read_blocking()
                if line == "":
                    raise EOFError
                action = parse_command(line)
            else:
                ready, _, _ = select.select([stdin], [], [], POLL_SECONDS)
                if ready:
                    line = stdin.readline()
                    if line == "":  # EOF (piped stdin exhausted / Ctrl-D)
                        say("\n(stdin closed — ending the show)")
                        break
                    action = parse_command(line)
                else:
                    action = {"kind": "tick"}

            kind = action["kind"]
            if kind == "tick":
                try:
                    for t in show.tick(1):
                        say(f"[{t.speaker}] {t.text}")
                    consecutive_errors = 0
                except SteeringError as e:
                    consecutive_errors += 1
                    wait = min(5.0, POLL_SECONDS * consecutive_errors)
                    say(f"!! steering failed: {e} (show stays up; retry in {wait:.1f}s)")
                    time.sleep(wait)
            elif kind == "ask_room":
                say(f">>> PRODUCER: {action['text']}")
                show.interject(action["text"])
            elif kind == "ask_char":
                text = _interjection_text(action)
                say(f">>> PRODUCER (to {action['speaker']}): {text}")
                show.interject(text)
            elif kind == "dial":
                show.dial = action["dial"]
                say(f">>> (dial -> {action['dial']})")
            elif kind == "pause":
                paused = True
                say("|| paused — playback stopped; commands still work (!resume to play on)")
            elif kind == "resume":
                paused = False
                say(">> resumed")
            elif kind == "state":
                say(fmt_state(show))
            elif kind == "metrics":
                say(fmt_metrics(show, asm))
            elif kind == "unknown":
                say(f"?? unknown command '!{action['command']}' — plain text asks the room; !quit exits")
            elif kind == "quit":
                break
            elif kind == "none":
                pass
    except (EOFError, KeyboardInterrupt):
        say("\n(show interrupted)")

    say("\n=== show over ===")
    say(fmt_metrics(show, asm))
    say(f"turns: {len(show.ledger.turns)} planned, "
        f"{len([t for t in show.ledger.turns if t.heard])} heard, "
        f"{show.ledger.discarded_count} discarded")


# ---------------------------------------------------------------- entry


def build_show(llm_kind: str, article: str, prefetch: int) -> tuple[Show, PromptAssembler]:
    llm: SteeringLLM
    if llm_kind == "openai":
        candidate = OpenAICompatLLM()
        if candidate.probe():
            llm = candidate
            ids = candidate.last_models
            names = ", ".join(ids) if ids else ("none" if ids is not None else "unknown")
            print(
                f"[llm] steering endpoint {candidate.base_url} "
                f"(model: {candidate.model}; models: {names})",
                flush=True,
            )
            if ids is not None and len(ids) == 0:
                print(
                    "[llm] WARNING: endpoint lists no models — pull one "
                    f"(e.g. `ollama pull {candidate.model}`) or generation will fail",
                    file=sys.stderr,
                )
        else:
            print(
                f"[llm] WARNING: no OpenAI-compatible endpoint at {candidate.base_url} "
                "— falling back to ScriptedLLM",
                file=sys.stderr,
            )
            llm = ScriptedLLM()
    else:
        llm = ScriptedLLM()
    asm = PromptAssembler(article, SHEETS, BIBLE)
    return Show(llm, asm, prefetch=max(1, prefetch)), asm


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="lane-c producer REPL (ADR-0009 layer 2)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Usage:")[0],
    )
    ap.add_argument("--llm", choices=("scripted", "openai"), default="scripted",
                    help="steering source (default: scripted fixtures)")
    ap.add_argument("--article", default=None, metavar="PATH",
                    help="article text file (default: built-in demo article)")
    ap.add_argument("--prefetch", type=int, default=2, metavar="N",
                    help="planned turns ahead of the playhead (default: 2)")
    args = ap.parse_args(argv)

    article = ARTICLE
    if args.article:
        with open(args.article, encoding="utf-8") as f:
            article = f.read()

    show, asm = build_show(args.llm, article, args.prefetch)
    run_repl(show, asm)
    return 0


if __name__ == "__main__":
    sys.exit(main())
