"""python3 -m benchmark — CLI dispatcher.

Subcommands: ``run`` (default; the benchmark harness) and ``report``
(the Markdown scorecard). If the first argument is not a subcommand it is
treated as arguments to ``run``, so ``./run --engine mock`` works.
"""

from __future__ import annotations

import sys

from .harness import main as run_main
from .report import main as report_main


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:]) if argv is None else argv
    if argv and argv[0] == "report":
        return report_main(argv[1:])
    if argv and argv[0] == "run":
        argv = argv[1:]
    return run_main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
