"""Benchmark CLI: one engine through the ADR-0005 scorecard phases.

Phases per run (all timed with time.perf_counter from the harness side, so
the numbers mean the same thing for every engine):

1. cold    — first-ever synthesis (one-time load/connect, timed separately)
2. short   — N short sentences, TTFA per sentence (warm)
3. passage — ~500-word sustained stream, wall time vs audio duration -> RTF
4. longdoc — the passage repeated N times; no failures, no duration drift

Writes one JSON result file per run into benchmark/results/ (gitignored) and
embeds the ADR-0010 environment snapshot in it.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
import wave
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from . import __version__, envsnap
from .engines import Engine, MockEngine, RivaEngine

RESULTS_DIR = Path(__file__).resolve().parent / "results"

SCHEMA_VERSION = 1

SHORT_SENTENCES = [
    "The quick brown fox jumps over the lazy dog.",
    "JetPack seven ships with CUDA thirteen on the Thor.",
    "Yesterday, Dr. Nguyen calibrated the microphone at 48 kilohertz.",
    "Can streaming speech begin in under a second?",
    "She read 42 pages before the battery dropped to 19 percent.",
    "The valley fog lifted around 6:40 in the morning.",
    "A voice that can carry a story is worth two that cannot.",
    "Numbers, names, and nested clauses stress-test every synthesizer.",
]

# ~500-word sustained-reading passage (word count is reported in the result).
PASSAGE = """\
Reading aloud is one of the oldest technologies we have, and one of the
strangest. When a machine performs it, every choice becomes visible: where
the voice pauses, which syllables it leans on, how it treats a name it has
never seen before. A good synthetic reader disappears into the text. A bad
one reminds you, sentence by sentence, that something is being done to the
words rather than with them.

The craft of measuring such a voice is less about a single number than
about a small set of honest observations. Time to first audio tells you how
long a listener waits after pressing play. Real-time factor tells you
whether the engine can keep up with playback on this exact piece of
silicon, at this clock, in this power mode. Stability tells you whether the
ten-thousandth word sounds as composed as the first. None of these figures
survive being moved between machines. A datacenter score is a rumor; a
score from the board on the desk is a fact.

That is why every result file carries its environment beside its numbers.
The power mode in force during the run, whether the clocks were locked, the
temperature of the die, the load on the memory controllers: each of these
can move a benchmark by multiples, not percentages. An engine that looks
broken at fifteen watts may look effortless at a hundred and twenty. A
model that thrives while cool may throttle in a fanless case on a summer
afternoon. Recording the context is not pedantry; it is the difference
between a measurement and an anecdote.

Between the meters there is the matter of taste. The same voice that makes
short work of a dense technical paper may flatten a paragraph of dialogue.
Another voice, expressive and unhurried, may be a poor companion for
skimming the morning news. This is why each engine is rated by ear for each
use: paper, news, and story. The ear is the final instrument, and it
belongs to the person who will live with the voice.

What the harness cannot do is cheat. A mock engine exists so the machinery
itself can be rehearsed: it produces a deterministic tone, pretends to be
slow in configurable ways, and exercises every stage of the pipeline before
a real model is loaded. When the real engines arrive, they slot into the
same interface, run the same sentences, and land in the same scorecard.
The numbers stay comparable because the path they travel is identical.

In the end the scorecard is a decision aid, not a verdict. It ranks engines
on this board, today, under these conditions, for these three kinds of
listening. Firmware updates, quantized rebuilds, and new voices will each
shuffle the order. The right response to that instability is not despair
but repetition: run the harness again, compare against the archived
results, and let the delta tell the story. Measurement, like reading
itself, rewards the habit more than the single performance.
"""


@dataclass
class CallMetrics:
    """Timings for a single streaming synthesis call."""

    text_words: int
    ttfa_s: float | None
    wall_time_s: float
    chunk_count: int
    audio_bytes: int
    audio_duration_s: float
    rtf: float | None
    error: str | None = None


def _run_stream(engine: Engine, text: str) -> tuple[CallMetrics, bytes]:
    start = time.perf_counter()
    ttfa: float | None = None
    chunks = 0
    audio = bytearray()
    error: str | None = None
    try:
        for chunk in engine.synthesize_stream(text):
            if ttfa is None:
                ttfa = time.perf_counter() - start
            chunks += 1
            audio += chunk
    except Exception as exc:  # engine failure is a measurement, not a crash
        error = f"{type(exc).__name__}: {exc}"
    wall = time.perf_counter() - start

    duration = engine.audio_duration(len(audio))
    rtf = (wall / duration) if duration > 0 else None
    metrics = CallMetrics(
        text_words=len(text.split()),
        ttfa_s=ttfa,
        wall_time_s=wall,
        chunk_count=chunks,
        audio_bytes=len(audio),
        audio_duration_s=duration,
        rtf=rtf,
        error=error,
    )
    return metrics, bytes(audio)


def _call_dict(m: CallMetrics) -> dict:
    return {
        "text_words": m.text_words,
        "ttfa_s": _round(m.ttfa_s),
        "wall_time_s": _round(m.wall_time_s),
        "chunk_count": m.chunk_count,
        "audio_bytes": m.audio_bytes,
        "audio_duration_s": _round(m.audio_duration_s),
        "rtf": _round(m.rtf),
        "error": m.error,
    }


def _round(v: float | None, nd: int = 6) -> float | None:
    return None if v is None else round(v, nd)


def _write_probe_wav(path: Path, pcm: bytes, sample_rate_hz: int) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate_hz)
        wav.writeframes(pcm)


def execute_run(
    engine: Engine,
    *,
    label: str,
    results_dir: Path,
    sentence_count: int,
    repeat_count: int,
    tegrastats_seconds: float,
    save_probes: bool,
) -> tuple[dict, Path]:
    """Run all phases; return (result dict, result file path)."""
    print(f"skald benchmark v{__version__} — engine={engine.name} "
          f"voice={engine.voice} label={label}")
    env = envsnap.capture(tegrastats_seconds)
    print(f"env: {envsnap.summarize(env)}")

    result: dict = {
        "schema_version": SCHEMA_VERSION,
        "harness_version": __version__,
        "started_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "label": label,
        "engine": {
            "name": engine.name,
            "voice": engine.voice,
            "language_code": engine.language_code,
            "sample_rate_hz": engine.sample_rate_hz,
            "params": engine.params,
        },
        "env": env,
    }

    run_id: str  # set below, just before writing the result file
    probe_audio: dict[str, bytes] = {}

    # Phase 1: cold first synthesis (one-time load/connect).
    print(f"[1/4] cold first synthesis ({len(SHORT_SENTENCES[0].split())} words)")
    cold, cold_audio = _run_stream(engine, SHORT_SENTENCES[0])
    result["cold"] = _call_dict(cold)
    print(f"      ttfa={_fmt_s(cold.ttfa_s)} wall={_fmt_s(cold.wall_time_s)} "
          f"audio={_fmt_s(cold.audio_duration_s)} error={cold.error or 'none'}")

    # Phase 2: short sentences, TTFA each (warm).
    sentences = SHORT_SENTENCES[: max(1, sentence_count)]
    print(f"[2/4] {len(sentences)} short sentences (warm TTFA)")
    calls: list[CallMetrics] = []
    probe_sentence_audio = b""
    for i, sentence in enumerate(sentences, 1):
        m, audio = _run_stream(engine, sentence)
        calls.append(m)
        if i == 1:
            probe_sentence_audio = audio
        if m.error:
            print(f"      {i}/{len(sentences)} FAILED: {m.error}")
    ttfas = [c.ttfa_s for c in calls if c.ttfa_s is not None]
    result["short_sentences"] = {
        "count": len(calls),
        "failures": [c.error for c in calls if c.error],
        "ttfa_s": [_round(t) for t in ttfas],
        "ttfa_mean_s": _round(statistics.fmean(ttfas)) if ttfas else None,
        "ttfa_median_s": _round(statistics.median(ttfas)) if ttfas else None,
        "ttfa_min_s": _round(min(ttfas)) if ttfas else None,
        "ttfa_max_s": _round(max(ttfas)) if ttfas else None,
        "mean_rtf": _round(_mean([c.rtf for c in calls if c.rtf is not None])),
        "calls": [_call_dict(c) for c in calls],
    }
    print(f"      ttfa median={_fmt_s(result['short_sentences']['ttfa_median_s'])} "
          f"min={_fmt_s(result['short_sentences']['ttfa_min_s'])} "
          f"max={_fmt_s(result['short_sentences']['ttfa_max_s'])}")

    # Phase 3: sustained passage -> streaming RTF.
    print(f"[3/4] sustained passage ({len(PASSAGE.split())} words)")
    passage_m, passage_audio = _run_stream(engine, PASSAGE)
    result["sustained_passage"] = _call_dict(passage_m)
    print(f"      ttfa={_fmt_s(passage_m.ttfa_s)} wall={_fmt_s(passage_m.wall_time_s)} "
          f"audio={_fmt_s(passage_m.audio_duration_s)} rtf={_fmt_rtf(passage_m.rtf)}")

    # Phase 4: long-doc stability — passage repeated, no failures / drift.
    print(f"[4/4] long-doc stability ({repeat_count} x passage = "
          f"{len(PASSAGE.split()) * repeat_count} words)")
    iterations: list[dict] = []
    failures: list[str] = []
    for i in range(repeat_count):
        m, _ = _run_stream(engine, PASSAGE)
        iterations.append(_call_dict(m))
        if m.error:
            failures.append(f"iteration {i}: {m.error}")
        elif m.audio_bytes == 0:
            failures.append(f"iteration {i}: zero audio bytes")
        if m.error and i == 0:
            # Engine is down; do not hammer it repeat_count times.
            print(f"      iteration 0 failed ({m.error}); skipping remaining")
            break
    durations = [it["audio_duration_s"] for it in iterations
                 if it["audio_duration_s"] and not it["error"]]
    if durations:
        med = statistics.median(durations)
        for i, d in enumerate(durations):
            if abs(d - med) > 0.25 * med:
                failures.append(
                    f"iteration {i}: audio duration drift ({d:.1f}s vs median {med:.1f}s)"
                )
    result["long_doc_stability"] = {
        "repeat_count": repeat_count,
        "iterations_completed": len(iterations),
        "total_words": len(PASSAGE.split()) * repeat_count,
        "audio_duration_median_s": _round(statistics.median(durations)) if durations else None,
        "wall_time_total_s": _round(sum(it["wall_time_s"] for it in iterations)),
        "pass": not failures,
        "failures": failures,
        "iterations": iterations,
    }
    print(f"      {'pass' if not failures else 'FAIL'} — {len(iterations)} iterations, "
          f"{len(failures)} failure(s)")

    if save_probes:
        probe_audio["sentence"] = probe_sentence_audio or cold_audio
        probe_audio["passage"] = passage_audio

    result["failures_total"] = (
        len(result["short_sentences"]["failures"])
        + (1 if cold.error else 0)
        + (1 if passage_m.error else 0)
        + len(failures)
    )
    result["finished_at"] = datetime.now().astimezone().isoformat(timespec="seconds")

    # Persist.
    results_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    safe_label = re.sub(r"[^A-Za-z0-9._-]+", "-", label) or "run"
    run_id = f"{engine.name}_{safe_label}_{stamp}"
    result["run_id"] = run_id
    result_path = results_dir / f"{run_id}.json"
    result_path.write_text(json.dumps(result, indent=2) + "\n")

    if save_probes and probe_audio:
        result["probes"] = {}
        probe_dir = results_dir / "probes" / run_id
        probe_dir.mkdir(parents=True, exist_ok=True)
        for kind, pcm in probe_audio.items():
            wav_path = probe_dir / f"{kind}.wav"
            _write_probe_wav(wav_path, pcm, engine.sample_rate_hz)
            result["probes"][kind] = str(wav_path.relative_to(results_dir))
        # Re-write so probe paths land in the stored JSON.
        result_path.write_text(json.dumps(result, indent=2) + "\n")
        print(f"probes: {probe_dir}/")

    print(f"result: {result_path}")
    return result, result_path


def _mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def _fmt_s(v: float | None) -> str:
    return "n/a" if v is None else f"{v:.3f}s"


def _fmt_rtf(v: float | None) -> str:
    return "n/a" if v is None else f"{v:.4f}"


def build_engine(args: argparse.Namespace) -> Engine:
    if args.engine == "mock":
        return MockEngine(voice=args.voice or "sine")
    if args.engine == "riva":
        return RivaEngine(
            voice=args.voice or RivaEngine.DEFAULT_VOICE,
            language_code=args.language_code,
            uri=args.riva_uri,
        )
    raise SystemExit(f"unknown engine {args.engine!r}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="skald-benchmark run",
        description="Run one TTS engine through the ADR-0005 scorecard phases "
        "and write a JSON result file with the ADR-0010 env snapshot.",
    )
    parser.add_argument("--engine", choices=("mock", "riva"), default="mock",
                        help="engine under test (default: mock)")
    parser.add_argument("--voice", default=None,
                        help="voice name (engine-specific default if omitted)")
    parser.add_argument("--language-code", default="en-US",
                        help="BCP-47 language code passed to the engine (default: en-US)")
    parser.add_argument("--riva-uri", default=RivaEngine.DEFAULT_URI,
                        help=f"gRPC endpoint for Riva (default: {RivaEngine.DEFAULT_URI})")
    parser.add_argument("--label", default="run",
                        help="short label baked into the result filename")
    parser.add_argument("--results-dir", default=str(RESULTS_DIR),
                        help=f"directory for result JSONs (default: {RESULTS_DIR})")
    parser.add_argument("--sentences", type=int, default=8,
                        help="short sentences for the warm-TTFA phase (default: 8)")
    parser.add_argument("--repeats", type=int, default=20,
                        help="passage repetitions for long-doc stability (default: 20)")
    parser.add_argument("--tegrastats-seconds", type=float, default=5.0,
                        help="tegrastats sample length, 0 disables (default: 5)")
    parser.add_argument("--save-probes", action="store_true",
                        help="also write the sentence and passage audio as probe WAVs")
    args = parser.parse_args(argv)

    try:
        engine = build_engine(args)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    result, _ = execute_run(
        engine,
        label=args.label,
        results_dir=Path(args.results_dir),
        sentence_count=args.sentences,
        repeat_count=args.repeats,
        tegrastats_seconds=args.tegrastats_seconds,
        save_probes=args.save_probes,
    )
    return 1 if result["failures_total"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
