"""macOS host telemetry without sudo: thermal + memory pressure (+ battery/AC).

Stdlib only, py3.9-compatible (runs on the MBP collector and the mini).
Every shell command goes through `run_cmd` — snapshot() calls that module
attribute, so tests monkeypatch it (via mock.patch.object on harness.telemetry)
with fixture strings and the suite never touches the real system.

`snapshot()` runs a safe pass over:

  pmset -g therm          -> thermal level (nominal/moderate/hot/unknown)
  memory_pressure -Q      -> kernel memory pressure state (fallback: vm_stat)
  sysctl vm.swapusage     -> swap used, MB (plus hw.memsize for thresholds)
  pmset -g batt           -> power source ("ac" / "battery")

Anything that fails or is unparseable degrades to a safe sentinel and never
raises.
"""
import re
import subprocess

# pmset -g therm CPU_Thermal_Level -> label
LEVELS = {"0": "nominal", "1": "moderate", "2": "hot"}


def run_cmd(cmd, timeout=10):
    """Run an argv list and return its stdout as text.

    This is the ONLY subprocess seam in the module. It returns ``None`` when
    the binary is missing / raises or times out, but NOT on a non-zero exit:
    several diagnostics (notably ``memory_pressure -Q``) signal *state* via a
    non-zero exit code while still printing the status line we want. Callers
    that need strict success should check returncode themselves; here the
    parsers degrade safely on any unexpected text.
    """
    try:
        proc = subprocess.run(
            [str(c) for c in cmd], capture_output=True, text=True,
            timeout=timeout)
    except Exception:
        return None
    if proc.returncode < 0 or proc.stdout is None:
        return None
    return proc.stdout


def parse_therm(text):
    """pmset -g therm output -> 'nominal' | 'moderate' | 'hot' | 'unknown'.

    Real M4 output when idle is just three "Note: No ... has been recorded"
    lines (no level recorded) — that counts as nominal, not unknown.
    """
    if text is None:
        return "unknown"
    m = re.search(r"CPU_Thermal_Level:\s*(\d)", text)
    if m:
        return LEVELS.get(m.group(1), "unknown")
    if re.search(r"No thermal warning level|No performance warning level", text):
        return "nominal"  # nothing recorded — cooler than nominal is unknown
    return "unknown"


def parse_swap(text):
    """Swap used in MB, or None.

    Accepts the modern `sysctl vm.swapusage` line
    ("total = 512.0M used = 480.0M (encrypted)") and the plan's classic
    "Swapusage = 512M used" wording; both are seen in the wild.
    """
    if text is None:
        return None
    for pat in (r"[Uu]sage.*?used\s*=\s*([\d.]+)([MG])\b",
                r"[Ss]wapusage\s*=\s*([\d.]+)([MG])\w*\s+used"):
        m = re.search(pat, text)
        if m:
            val = float(m.group(1))
            return int(val * 1024) if m.group(2) == "G" else int(val)
    return None


def parse_memory_pressure(text):
    """`memory_pressure -Q` stdout -> 'none' | 'moderate' | 'high'.

    Formats seen: macOS < 26 prints "System memory status is free/warn" and
    exits non-zero on warn/critical; 26+ prints "System memory status is
    normal/warn/critical" plus an Out of Memory count. We only read the state
    word; run_cmd returns its stdout even when it exits non-zero.
    """
    if text is None:
        return None
    m = re.search(r"System memory status is (\w+)", text)
    if not m:
        return None
    state = m.group(1).lower()
    if "crit" in state:  # critical / critically high
        return "high"
    if state == "warn":
        return "moderate"
    # normal / free / others -> no pressure
    return "none"


def parse_vm_stat(text):
    """`vm_stat` stdout -> available-ish memory in MB (free + inactive), or None.

    Handles the page-size header so Apple-silicon 16K pages and classic
    4K/8K machines all come out in the same units.

    >>> parse_vm_stat("...(page size of 4096 bytes)... free 150000. "
    ...               "inactive 1488000.")  # 1,638,000 pages = 6398 MB
    6398
    """
    if text is None:
        return None
    m = re.search(r"page size of (\d+) bytes", text)
    if not m:
        return None
    page = int(m.group(1))
    pages = 0.0
    for label in ("free", "inactive"):
        lm = re.search(r"Pages %s:\s*([\d.]+)\b" % label, text)
        if lm:
            pages += float(lm.group(1))
    return int(page * pages // (1024 * 1024))


def parse_memsize(text):
    """`sysctl hw.memsize` -> physical memory in MB, or None."""
    if text is None:
        return None
    m = re.search(r"hw\.memsize:\s*(\d+)", text)
    return int(m.group(1)) // (1024 * 1024) if m else None


def parse_power(text):
    """`pmset -g batt` first line -> 'ac' | 'battery', or None."""
    if text is None:
        return None
    first = next((ln for ln in text.splitlines() if ln.strip()), "")
    fl = first.lower()
    if "ac power" in fl:
        return "ac"
    if "battery power" in fl:
        return "battery"
    return None


CANON_PRESSURE = {
    "none": "none", "normal": "none", "free": "none",
    "warn": "moderate", "moderate": "moderate",
    "critical": "high", "critically high": "high", "high": "high",
}


def parse_pressure(kernel_state, avail_mb, total_mb):
    """Combine the kernel memory-pressure state with a numeric availability
    check into 'none' | 'moderate' | 'high'.

    Accepts either the canonical states ('none'/'moderate'/'high', as
    parse_memory_pressure emits) or the raw kernel wording
    ('normal'/'free'/'warn'/'critical'). When the kernel state is
    missing or unrecognized, fall back to thresholds on available-vs-total
    memory: < 5% -> high, < 10% -> moderate.
    """
    if kernel_state is not None:
        canon = CANON_PRESSURE.get(str(kernel_state).lower())
        if canon is not None:
            return canon
    if avail_mb is None or total_mb in (None, 0):
        return "none"
    pct = avail_mb * 100.0 / total_mb
    if pct < 5:
        return "high"
    if pct < 10:
        return "moderate"
    return "none"


def _memory_pressure():
    """Kernel state via `memory_pressure -Q` -> 'none'|'moderate'|'high' or None.

    Goes through the module `run_cmd` seam (patchable in tests). run_cmd
    returns stdout even on a non-zero exit, which is exactly what we need:
    legacy `memory_pressure -Q` exits non-zero when pressure is warn/critical
    while still printing its status line.
    """
    return parse_memory_pressure(
        run_cmd(["memory_pressure", "-Q"], timeout=15))


def snapshot():
    """One host telemetry sample. Keys are always present and JSON-safe:

      thermal          nominal | moderate | hot | unknown
      memory_pressure  none | moderate | high
      mem_avail_mb     free+inactive from vm_stat, or None
      swap_mb          swap used, or None
      power_source     "ac" | "battery" | None

    Every shell call goes through the module `run_cmd` attribute (patch it in
    tests). No parameter: a same-named argument would shadow the module seam.
    """
    out = {}

    def rc(cmd, timeout=10):
        return run_cmd(cmd, timeout=timeout)

    # Thermal pressure.
    out["thermal"] = parse_therm(rc(["pmset", "-g", "therm"]))

    # Memory pressure: kernel state, with a vm_stat-derived fallback when the
    # kernel diagnostic is unreadable.
    out["memory_pressure"] = None
    try:
        out["memory_pressure"] = _memory_pressure()
    except Exception:
        pass
    vm_out = rc(["vm_stat"])
    out["mem_avail_mb"] = parse_vm_stat(vm_out)
    total_mb = parse_memsize(rc(["sysctl", "hw.memsize"]))
    if out["memory_pressure"] is None:
        out["memory_pressure"] = parse_pressure(
            None, out["mem_avail_mb"], total_mb)

    # Swap + power.
    out["swap_mb"] = parse_swap(rc(["sysctl", "vm.swapusage"]))
    out["power_source"] = parse_power(rc(["pmset", "-g", "batt"]))
    return out
