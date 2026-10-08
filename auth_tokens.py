#!/usr/bin/env python3
"""Issue the collector's tokens (see "Write and ingest auth" in app.py).

  auth_tokens.py admin-init
      Create $HERMES_HOME/metrics/admin.token (0600) if missing. The collector
      and the metrics-dashboard plugin on the same machine both read it.
  auth_tokens.py ingest-issue <sender> [--hosts a,b] [--out PATH]
      Issue (or rotate) the /ingest token for one sending machine. --hosts lists
      the host labels it may report as (default: the sender's own name). With
      --out the token goes to that file (0600); otherwise it is printed once,
      for piping to the sender (e.g. over ssh). Only its sha256 is stored.
  auth_tokens.py ingest-list
  auth_tokens.py ingest-revoke <sender>

Senders read their token from $METRICS_INGEST_TOKEN or ~/.hermes/metrics/ingest.token.
"""
import argparse
import datetime
import hashlib
import json
import os
import secrets
import sys
from pathlib import Path

HOME = Path(os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes"), "metrics")
TOKENS = Path(os.environ.get("METRICS_INGEST_TOKENS") or HOME / "ingest-tokens.json")


def write_private(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(str(tmp), str(path))


def load():
    try:
        return json.loads(TOKENS.read_text())
    except OSError:
        return {}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("admin-init")
    issue = sub.add_parser("ingest-issue")
    issue.add_argument("sender")
    issue.add_argument("--hosts", default="")
    issue.add_argument("--out")
    sub.add_parser("ingest-list")
    revoke = sub.add_parser("ingest-revoke")
    revoke.add_argument("sender")
    args = ap.parse_args(argv)

    if args.cmd == "admin-init":
        path = HOME / "admin.token"
        if path.exists():
            print(f"{path} already exists; left unchanged")
        else:
            write_private(path, secrets.token_urlsafe(32) + "\n")
            print(f"created {path}; restart the collector and the Hermes backend to pick it up")
    elif args.cmd == "ingest-issue":
        hosts = [h.strip() for h in args.hosts.split(",") if h.strip()] or [args.sender]
        token = secrets.token_urlsafe(32)
        entries = load()
        entries[args.sender] = {
            "sha256": hashlib.sha256(token.encode("utf-8")).hexdigest(),
            "hosts": hosts,
            "issued": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        }
        write_private(TOKENS, json.dumps(entries, indent=1) + "\n")
        if args.out:
            write_private(Path(os.path.expanduser(args.out)), token + "\n")
            print(f"issued {args.sender} -> {', '.join(hosts)}; token written to {args.out}", file=sys.stderr)
        else:
            print(f"issued {args.sender} -> {', '.join(hosts)}", file=sys.stderr)
            print(token)
    elif args.cmd == "ingest-list":
        for sender, e in sorted(load().items()):
            print(f"{sender}\thosts={','.join(e.get('hosts') or [sender])}\tissued={e.get('issued', '?')}")
    elif args.cmd == "ingest-revoke":
        entries = load()
        if entries.pop(args.sender, None) is None:
            print(f"no token for {args.sender}", file=sys.stderr)
            return 1
        write_private(TOKENS, json.dumps(entries, indent=1) + "\n")
        print(f"revoked {args.sender}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
