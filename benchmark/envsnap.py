"""Environment snapshot that every benchmark result file must carry.

ADR-0010: "No benchmark number without power context." On Jetson, clocks and
power caps move scores by multiples, so each result JSON embeds one of these
snapshots: nvpmodel power mode, jetson_clocks state, a short tegrastats
sample (utilization / thermals / power), and kernel/JetPack identification.

Every probe degrades gracefully to an explicit "unavailable" marker when the
tool or file is missing, so the harness also runs on non-Jetson hosts.
"""

from __future__ import annotations

import platform
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

# Marker file the L4T jetson_clocks script historically touches when it locks
# clocks. Absence is treated as "not locked" — newer L4T builds may use a
# different mechanism, so we cross-check CPU clock variance in the tegrastats
# sample and say so in `detail` below.
JETSON_CLOCKS_MARKER = Path("/tmp/l4t_dfs_frequence_boost")

DEVICE_TREE_MODEL = Path("/proc/device-tree/model")
NV_TEGRA_RELEASE = Path("/etc/nv_tegra_release")
OS_RELEASE = Path("/etc/os-release")


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(errors="replace").replace("\x00", "").strip()
    except OSError:
        return None


def _run(cmd: list[str], timeout: float = 10.0) -> str | None:
    """Run a read-only probe command; None if missing or failing."""
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    return proc.stdout if proc.returncode == 0 else None


def _capture_platform() -> dict:
    os_pretty = None
    os_text = _read_text(OS_RELEASE)
    if os_text:
        m = re.search(r'^PRETTY_NAME="?([^"\n]+)"?', os_text, re.MULTILINE)
        if m:
            os_pretty = m.group(1)

    l4t = None
    tegra_rel = _read_text(NV_TEGRA_RELEASE)
    if tegra_rel:
        m = re.search(r"R(\d+)\s*\(release\),\s*REVISION:\s*([\d.]+)", tegra_rel)
        if m:
            l4t = f"R{m.group(1)}.{m.group(2)}"

    jetpack = _run(["dpkg-query", "-W", "-f=${Version}", "nvidia-jetpack"])

    return {
        "device_model": _read_text(DEVICE_TREE_MODEL) or "unavailable",
        "os": os_pretty or platform.platform(),
        "kernel": platform.release(),
        "machine": platform.machine(),
        "l4t_release": l4t or "unavailable",
        "jetpack": jetpack.strip() if jetpack else "unavailable",
    }


def _capture_power_mode() -> dict:
    out = _run(["nvpmodel", "-q"])
    if out is None:
        return {"available": False, "note": "nvpmodel unavailable (non-Jetson host?)"}
    mode, mode_id = "unknown", None
    m = re.search(r"NV Power Mode:\s*(.+)", out)
    if m:
        mode = m.group(1).strip()
    id_lines = [ln for ln in out.splitlines() if ln.strip().isdigit()]
    if id_lines:
        mode_id = int(id_lines[-1])
    return {"available": True, "mode": mode, "mode_id": mode_id}


def _capture_clock_state() -> dict:
    if JETSON_CLOCKS_MARKER.exists():
        state = "locked"
        detail = f"{JETSON_CLOCKS_MARKER} present (jetson_clocks applied)."
    else:
        state = "no_marker"
        detail = (
            f"{JETSON_CLOCKS_MARKER} absent: treated as clocks NOT locked. "
            "Method note: the marker is what the L4T jetson_clocks script "
            "historically touches; newer L4T builds may lock clocks without "
            "it. Cross-check cpu_freq_range_mhz in the tegrastats sample — "
            "widely varying CPU frequencies are consistent with unlocked DVFS."
        )
    return {
        "jetson_clocks_state": state,
        "method": "presence of /tmp/l4t_dfs_frequence_boost",
        "detail": detail,
    }


def _parse_tegrastats_line(line: str) -> dict | None:
    """Extract per-line averages from one tegrastats record.

    Fields are format-tolerant: GR3D_FREQ/EMC utilization (Orin-era output)
    are simply absent on JetPack 7 / Thor tegrastats, in which case the
    corresponding keys are missing rather than zero.
    """
    rec: dict = {}

    m = re.search(r"CPU \[([^\]]*)\]", line)
    if m:
        pcts, freqs = [], []
        for core in m.group(1).split(","):
            cm = re.match(r"\s*(\d+)%@(\d+)", core)
            if cm:
                pcts.append(int(cm.group(1)))
                freqs.append(int(cm.group(2)))
        if pcts:
            rec["cpu_pct"] = sum(pcts) / len(pcts)
            rec["cpu_freq_min"] = min(freqs)
            rec["cpu_freq_max"] = max(freqs)

    m = re.search(r"GR3D_FREQ (\d+)%", line)
    if m:
        rec["gpu_pct"] = int(m.group(1))
    m = re.search(r"EMC (\d+)%", line)
    if m:
        rec["emc_pct"] = int(m.group(1))

    for key, pat in (
        ("cpu_temp_c", r"cpu@([\d.]+)C"),
        ("tj_temp_c", r"tj@([\d.]+)C"),
        ("gpu_temp_c", r"gpu@([\d.]+)C"),
    ):
        m = re.search(pat, line)
        if m:
            rec[key] = float(m.group(1))

    # Total rail power: "VIN <avg>mW/<min>mW/<max>mW"
    m = re.search(r"\bVIN (\d+)mW", line)
    if m:
        rec["power_mw"] = int(m.group(1))

    return rec if rec else None


def _capture_tegrastats(seconds: float, interval_ms: int = 500) -> dict:
    if seconds <= 0:
        return {"available": False, "note": "tegrastats sampling disabled"}
    try:
        proc = subprocess.Popen(
            ["tegrastats", "--interval", str(interval_ms)],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except (FileNotFoundError, OSError):
        return {"available": False, "note": "tegrastats unavailable (non-Jetson host?)"}

    time.sleep(seconds)
    proc.terminate()
    try:
        out, _ = proc.communicate(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, _ = proc.communicate()

    records = [r for ln in (out or "").splitlines() if (r := _parse_tegrastats_line(ln))]

    def avg(key: str) -> float | None:
        vals = [r[key] for r in records if key in r]
        return sum(vals) / len(vals) if vals else None

    snap: dict = {
        "available": True,
        "sampled_seconds": seconds,
        "interval_ms": interval_ms,
        "lines_sampled": len(records),
    }
    if not records:
        snap["note"] = "tegrastats ran but produced no parseable output"
        return snap

    def pct(v: float | None) -> float | None:
        return round(v, 1) if v is not None else None

    snap.update(
        {
            "avg_cpu_util_pct": pct(avg("cpu_pct")),
            "avg_gpu_util_pct": pct(avg("gpu_pct")),
            "avg_emc_util_pct": pct(avg("emc_pct")),
            "avg_cpu_temp_c": pct(avg("cpu_temp_c")),
            "avg_gpu_temp_c": pct(avg("gpu_temp_c")),
            "avg_tj_temp_c": pct(avg("tj_temp_c")),
            "avg_power_mw": round(avg("power_mw") or 0),
        }
    )
    freq_mins = [r["cpu_freq_min"] for r in records if "cpu_freq_min" in r]
    freq_maxs = [r["cpu_freq_max"] for r in records if "cpu_freq_max" in r]
    if freq_mins:
        snap["cpu_freq_range_mhz"] = [min(freq_mins), max(freq_maxs)]

    if snap["avg_gpu_util_pct"] is None and snap["avg_emc_util_pct"] is None:
        snap["gpu_emc_note"] = (
            "tegrastats on this platform reports no GR3D_FREQ/EMC fields; "
            "GPU/EMC utilization not captured (CPU%, thermals and power rails were)"
        )
    return snap


def capture(tegrastats_seconds: float = 5.0) -> dict:
    """Assemble the full environment snapshot dict (JSON-serializable)."""
    return {
        "captured_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "platform": _capture_platform(),
        "power_mode": _capture_power_mode(),
        "clocks": _capture_clock_state(),
        "tegrastats": _capture_tegrastats(tegrastats_seconds),
    }


def summarize(env: dict) -> str:
    """One-line human summary for console output / report headers."""
    plat = env.get("platform", {})
    power = env.get("power_mode", {})
    clocks = env.get("clocks", {})
    model = plat.get("device_model", "?")
    power_s = power.get("mode", "power n/a") if power.get("available") else "power n/a"
    clocks_s = "clocks locked" if clocks.get("jetson_clocks_state") == "locked" else "clocks not locked"
    jp = plat.get("jetpack", "?")
    return f"{model} — JetPack {jp} — {power_s} — {clocks_s}"
