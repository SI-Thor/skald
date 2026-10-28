"""Render the ADR-0005 scorecard: Markdown table (engine x metrics) built
from every result JSON in benchmark/results/, with the ADR-0010 environment
snapshot of the newest run as a header block.

Usage: python3 -m benchmark report [--results-dir DIR] [--out FILE]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

RESULTS_DIR = Path(__file__).resolve().parent / "results"


def load_results(results_dir: Path) -> list[dict]:
    """All valid result JSONs, oldest first."""
    results = []
    for path in sorted(results_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            print(f"warning: skipping unreadable result {path.name}: {exc}",
                  file=sys.stderr)
            continue
        if isinstance(data, dict) and "engine" in data:
            results.append(data)
    results.sort(key=lambda r: r.get("started_at", ""))
    return results


def _s(value) -> str:
    return "n/a" if value is None else str(value)


def _seconds(value) -> str:
    return "n/a" if value is None else f"{value:.3f}"


def _rtf(value) -> str:
    return "n/a" if value is None else f"{value:.4f}"


def _env_lines(env: dict) -> list[str]:
    plat = env.get("platform", {})
    power = env.get("power_mode", {})
    clocks = env.get("clocks", {})
    stats = env.get("tegrastats", {})

    if stats.get("available"):
        gpu_emc = "not reported"
        if stats.get("avg_gpu_util_pct") is not None:
            gpu_emc = f"GPU {stats['avg_gpu_util_pct']}%"
            if stats.get("avg_emc_util_pct") is not None:
                gpu_emc += f", EMC {stats['avg_emc_util_pct']}%"
        elif stats.get("gpu_emc_note"):
            gpu_emc = stats["gpu_emc_note"]

        thermals = [
            f"{label} {stats[key]}°C"
            for label, key in (("CPU", "avg_cpu_temp_c"), ("GPU", "avg_gpu_temp_c"),
                               ("Tj", "avg_tj_temp_c"))
            if stats.get(key) is not None
        ]
        util_line = (
            f"- Utilization (tegrastats, {stats.get('sampled_seconds', '?')}s): "
            f"CPU {stats.get('avg_cpu_util_pct', 'n/a')}%, {gpu_emc}"
        )
        if thermals:
            util_line += " — " + ", ".join(thermals)
        power_line = (f"- Power draw (VIN rail): "
                      f"{stats.get('avg_power_mw', 0) or 0} mW avg")
    else:
        util_line = f"- Utilization (tegrastats): {stats.get('note', 'unavailable')}"
        power_line = "- Power draw: unavailable"

    if power.get("available"):
        power_txt = f"{power.get('mode')} (mode id {power.get('mode_id')})"
    else:
        power_txt = power.get("note", "unavailable")
    clocks_txt = (f"{clocks.get('jetson_clocks_state', 'unavailable')} "
                  f"(method: {clocks.get('method', '?')})")

    return [
        f"- Captured: {env.get('captured_at', 'unavailable')}",
        f"- Device: {plat.get('device_model', 'unavailable')} — "
        f"{plat.get('os', 'unavailable')}, kernel {plat.get('kernel', 'unavailable')}",
        f"- JetPack: {plat.get('jetpack', 'unavailable')}, "
        f"L4T {plat.get('l4t_release', 'unavailable')}",
        f"- Power mode (nvpmodel): {power_txt}",
        f"- Clocks: {clocks_txt}",
        util_line,
        power_line,
    ]


def _engine_row(result: dict) -> list[str]:
    engine = result.get("engine", {})
    short = result.get("short_sentences", {})
    passage = result.get("sustained_passage", {})
    longdoc = result.get("long_doc_stability", {})
    date = (result.get("started_at", "") or "")[:10]

    if longdoc:
        n_fail = len(longdoc.get("failures", []))
        longdoc_txt = ("pass" if longdoc.get("pass")
                       else f"FAIL ({n_fail})") + (
            f", {longdoc.get('iterations_completed')}/{longdoc.get('repeat_count')}"
            if longdoc.get("iterations_completed") != longdoc.get("repeat_count")
            else "")
    else:
        longdoc_txt = "n/a"

    return [
        engine.get("name", "?"),
        engine.get("voice", "?"),
        engine.get("language_code", "?"),
        _seconds(result.get("cold", {}).get("ttfa_s")),
        _seconds(short.get("ttfa_median_s")),
        _rtf(passage.get("rtf")),
        longdoc_txt,
        str(result.get("failures_total", "n/a")),
        date or "n/a",
    ]


def render(results: list[dict], results_dir: Path | None = None) -> str:
    results_dir = results_dir or RESULTS_DIR
    newest = results[-1]
    # One row per engine, latest run wins; sorted by engine name.
    latest_by_engine: dict[str, dict] = {}
    run_counts: dict[str, int] = {}
    for r in results:
        name = r.get("engine", {}).get("name", "?")
        latest_by_engine[name] = r  # input is oldest-first
        run_counts[name] = run_counts.get(name, 0) + 1

    lines = [
        "# Skald on-device TTS scorecard",
        "",
        f"Generated {datetime.now().astimezone().isoformat(timespec='seconds')} — "
        f"{len(results)} result run(s) in {results_dir}. Latest run per engine:",
        "",
        "## Environment (ADR-0010 — from newest run "
        f"`{newest.get('run_id', '?')}`)",
        "",
        *_env_lines(newest.get("env", {})),
        "",
        "## Scorecard",
        "",
        "| Engine | Voice | Lang | Cold TTFA (s) | Warm TTFA med (s) | "
        "Sustained RTF | Long-doc | Failures | Date |",
        "|---|---|---|---:|---:|---:|---|---:|---|",
    ]
    for name in sorted(latest_by_engine):
        row = _engine_row(latest_by_engine[name])
        lines.append("| " + " | ".join(row) + " |")

    lines += [
        "",
        "Notes:",
        "",
        "- **Cold TTFA** — first-ever synthesis (model load / connect included);",
        "  **Warm TTFA** — median over the short-sentence phase.",
        "- **Sustained RTF** — wall time / audio duration on the ~500-word passage;",
        "  below 1.0 means the engine synthesizes faster than real time.",
        "- **Long-doc** — the passage repeated 20x; pass = no failures and no",
        "  audio-duration drift beyond 25% of the median.",
        "- Subjective quality (paper / news / story, 1-5) is the other half of",
        "  ADR-0005: listen to the probe WAVs and fill `quality-form.md`.",
        "- Env snapshot above is from the newest run only; older runs carry their",
        "  own `env` block inside their result JSON.",
    ]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="skald-benchmark report",
        description="Render the Markdown scorecard from all result JSONs.",
    )
    parser.add_argument("--results-dir", default=str(RESULTS_DIR),
                        help=f"directory holding result JSONs (default: {RESULTS_DIR})")
    parser.add_argument("--out", default=None,
                        help="write Markdown here instead of stdout")
    args = parser.parse_args(argv)

    results = load_results(Path(args.results_dir))
    if not results:
        print(f"error: no result files found in {args.results_dir} — "
              f"run the harness first", file=sys.stderr)
        return 1

    markdown = render(results, Path(args.results_dir))
    if args.out:
        Path(args.out).write_text(markdown)
        print(f"wrote {args.out}")
    else:
        sys.stdout.write(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
