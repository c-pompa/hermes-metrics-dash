#!/usr/bin/env python3
"""Host conformance checks: run on each host by the forwarder, stored by the collector.

The standard is hermes-desktop-iac's conformance.yaml, read from a local checkout named
by $CONFORMANCE_STANDARD (unset = no host checks). The host finds its own entry in
`hosts:` by its forwarder label, runs every `host_rules` check whose `applies_to` names
one of its roles or its OS, and sends one {"event": "conformance_result"} record. A host
missing from `hosts:` sends a single `unclassified` result and runs nothing.

Check kinds (see the IaC repo's docs/conformance.md): revision, job, port (loopback
only), keys (key names only; values are never kept). Anything else reports as failing,
so a rule this agent cannot run never looks healthy. Every check is read-only.

Stdlib only (PyYAML is imported when a standard is configured) and Python 3.9-safe:
the forwarder runs under the system python.
"""
from __future__ import annotations

import datetime
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

INTERVAL_S = 300
CHECK_TIMEOUT_S = 10
RETENTION_DAYS = 14
STATUSES = ("pass", "warn", "fail", "na")
EVIDENCE_LINES, EVIDENCE_CHARS = 5, 200
_SECRET_RE = re.compile(r"glpat-[\w-]+|gh[pousr]_\w+|sk-[\w-]{8,}|Bearer\s+\S+")
_KEY_RE = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=")
# Where every hermes-desktop-iac installer records the commit it ran from.
STAMP_PATH = Path("~/.hermes/iac-stamp.json").expanduser()

COLUMNS = ["ts", "host", "rule", "standard", "standard_rev", "status", "value",
           "evidence", "verified"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS conformance_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  host TEXT NOT NULL,
  rule TEXT NOT NULL,
  standard TEXT,
  standard_rev TEXT,
  status TEXT NOT NULL,      -- pass|warn|fail|na
  value TEXT,
  evidence TEXT,             -- JSON list of short lines
  verified INTEGER NOT NULL  -- 1 when the sender's ingest token may report as this host
);
CREATE INDEX IF NOT EXISTS idx_conformance_host_rule_ts ON conformance_results(host, rule, ts);
"""


def _run(cmd: list) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=CHECK_TIMEOUT_S)


def _first_line(text: str) -> str:
    return (text or "").strip().splitlines()[0] if (text or "").strip() else ""


def _key_names(path: Path) -> list:
    names = []
    for line in path.read_text().splitlines():
        m = _KEY_RE.match(line.strip())
        if m:
            names.append(m.group(1))
    return names


def _role_jobs(std: dict, host: dict) -> list:
    roles = std.get("roles") or {}
    jobs = []
    for role in host.get("roles") or []:
        for label in ((roles.get(role) or {}).get("jobs") or {}).get(host.get("os"), []):
            if label not in jobs:
                jobs.append(label)
    return jobs


def check_revision(check: dict, repo: Path, now: float) -> tuple:
    stamp_path = Path(os.path.expanduser(check["stamp"]))
    if not stamp_path.exists():
        return False, "no install stamp", [f"{check['stamp']} not found: no installer has run since stamps began"]
    installers = json.loads(stamp_path.read_text()).get("installers") or {}
    if not installers:
        return False, "empty install stamp", []
    upstream = "origin/main" if _run(["git", "-C", str(repo), "rev-parse", "-q", "--verify", "origin/main"]).returncode == 0 else "main"
    worst_behind, oldest_days, unknown, evidence = 0, 0.0, False, []
    for name, entry in sorted(installers.items()):
        commit = entry.get("commit") or "unknown"
        days = (now - datetime.datetime.fromisoformat(entry["at"]).timestamp()) / 86400
        oldest_days = max(oldest_days, days)
        r = _run(["git", "-C", str(repo), "rev-list", "--count", f"{commit}..{upstream}"])
        if r.returncode != 0:
            unknown = True
            evidence.append(f"{name}: commit {commit} is not in this checkout")
            continue
        behind = int(r.stdout.strip())
        worst_behind = max(worst_behind, behind)
        if behind > check["max_behind_commits"] or days > check["max_age_days"]:
            evidence.append(f"{name}: {commit}, {behind} behind {upstream}, {days:.0f} days old")
        if entry.get("dirty"):
            evidence.append(f"{name}: installed from a checkout with uncommitted changes")
    ok = not unknown and worst_behind <= check["max_behind_commits"] and oldest_days <= check["max_age_days"]
    behind_text = "unknown commits" if unknown else f"{worst_behind} commits"
    return ok, f"{behind_text} behind, oldest {oldest_days:.0f} days", evidence


def check_jobs(std: dict, host: dict, stamp_path: Path) -> tuple:
    labels = _role_jobs(std, host)
    missing = []
    for label in labels:
        if host.get("os") == "windows":
            r = _run(["schtasks", "/query", "/tn", label])
        else:
            r = _run(["launchctl", "print", f"gui/{os.getuid()}/{label}"])
        if r.returncode != 0:
            missing.append(f"{label}: {_first_line(r.stderr or r.stdout) or 'not loaded'}")
    # The stamp is evidence only: a job installed here that no role declares.
    undeclared = []
    if stamp_path.exists():
        for name in json.loads(stamp_path.read_text()).get("installers") or {}:
            _, _, label = name.partition(":")
            if label and label not in labels:
                undeclared.append(f"undeclared: {label} is installed but none of this host's roles list it")
    return not missing, f"{len(labels) - len(missing)} of {len(labels)}", missing + undeclared


def check_port(check: dict) -> tuple:
    url = check["url"]
    if urllib.parse.urlparse(url).hostname not in ("127.0.0.1", "localhost", "::1"):
        return False, "not loopback", [f"{url}: port checks only probe loopback"]
    try:
        with urllib.request.urlopen(url, timeout=check.get("timeout_s", 2)) as resp:
            return 200 <= resp.status < 300, str(resp.status), []
    except urllib.error.HTTPError as exc:
        return False, str(exc.code), [f"{url}: HTTP {exc.code}"]
    except (urllib.error.URLError, OSError) as exc:
        return False, "no answer", [f"{url}: {getattr(exc, 'reason', exc)}"]


def check_keys(check: dict, repo: Path) -> tuple:
    have_path, want_path = repo / check["file"], repo / check["against"]
    if not have_path.exists():
        return False, f"{check['file']} missing", [f"{have_path} not found"]
    want, have = _key_names(want_path), set(_key_names(have_path))
    missing = [k for k in want if k not in have]
    return not missing, f"{len(want) - len(missing)} of {len(want)}", [f"missing key: {k}" for k in missing]


def _evidence(lines: list) -> list:
    return [_SECRET_RE.sub("[redacted]", str(line))[:EVIDENCE_CHARS] for line in lines[:EVIDENCE_LINES]]


def run(label: str, standard_path: Path, now: float = None) -> dict:
    """One conformance_result record for this host against the standard at standard_path."""
    import yaml  # only hosts with a standard configured need PyYAML

    now = time.time() if now is None else now
    repo = standard_path.parent
    std = yaml.safe_load(standard_path.read_text())
    rev = _run(["git", "-C", str(repo), "rev-parse", "--short", "HEAD"])
    rec = {"event": "conformance_result", "ts": now,
           "standard": {"name": std.get("standard"), "rev": rev.stdout.strip() if rev.returncode == 0 else "unknown"},
           "results": []}
    host = (std.get("hosts") or {}).get(label)
    if host is None:
        rec["results"].append({"rule": "unclassified", "status": "warn", "value": "not in hosts:",
                               "evidence": [f"{label} is not declared in {standard_path.name}"]})
        return rec
    tags = set(host.get("roles") or []) | {host.get("os")}
    for rule in std.get("host_rules") or []:
        check = rule.get("check") or {}
        if not tags & set(rule.get("applies_to") or []):
            rec["results"].append({"rule": rule["id"], "status": "na", "value": "", "evidence": []})
            continue
        try:
            kind = check.get("kind")
            if kind == "revision":
                ok, value, evidence = check_revision(check, repo, now)
            elif kind == "job":
                ok, value, evidence = check_jobs(std, host, STAMP_PATH)
            elif kind == "port":
                ok, value, evidence = check_port(check)
            elif kind == "keys":
                ok, value, evidence = check_keys(check, repo)
            else:
                ok, value, evidence = False, f"unsupported kind {kind}", ["this host agent cannot run this check"]
        except Exception as exc:  # one broken check must not stop the others
            ok, value, evidence = False, "check error", [f"{type(exc).__name__}: {exc}"]
        status = "pass" if ok else ("fail" if rule.get("severity") == "blocks" else "warn")
        rec["results"].append({"rule": rule["id"], "status": status, "value": value[:EVIDENCE_CHARS],
                               "evidence": _evidence(evidence)})
    return rec


def normalize_results(rec: dict, host: str, verified: bool) -> list:
    """Rows for conformance_results from one ingest record; malformed results are dropped."""
    std = rec.get("standard") if isinstance(rec.get("standard"), dict) else {}
    ts = rec.get("ts") if isinstance(rec.get("ts"), (int, float)) else time.time()
    rows = []
    for r in rec.get("results") or []:
        if not isinstance(r, dict) or r.get("status") not in STATUSES:
            continue
        rule = r.get("rule")
        if not isinstance(rule, str) or not rule or len(rule) > 100:
            continue
        evidence = r.get("evidence") if isinstance(r.get("evidence"), list) else []
        rows.append({"ts": ts, "host": host, "rule": rule, "standard": str(std.get("name") or "")[:100],
                     "standard_rev": str(std.get("rev") or "")[:40], "status": r["status"],
                     "value": str(r.get("value") or "")[:EVIDENCE_CHARS],
                     "evidence": json.dumps(_evidence(evidence)), "verified": 1 if verified else 0})
    return rows


if __name__ == "__main__":
    # Manual run: python3 host_checks.py <label> <path/to/conformance.yaml>
    print(json.dumps(run(sys.argv[1], Path(sys.argv[2])), indent=1))
