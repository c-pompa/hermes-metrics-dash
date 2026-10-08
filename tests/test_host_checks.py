"""host_checks: the forwarder's conformance checks against a standard in a git checkout."""
import json
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import host_checks

STANDARD = """
version: 1
standard: test-baseline
hosts:
  mbp:  { os: macos, roles: [client, lab] }
  mini: { os: macos, roles: [backend] }
roles:
  backend: {}
  client:
    jobs:
      macos: [com.x.tunnel]
      windows: [Tunnel]
  lab:
    jobs:
      macos: [com.x.digest]
host_rules:
  - id: installed-revision
    severity: warns
    applies_to: [macos]
    check: { kind: revision, stamp: "STAMP", max_behind_commits: 1, max_age_days: 7 }
  - id: role-jobs-loaded
    severity: blocks
    applies_to: [macos]
    check: { kind: job, from_roles: true }
  - id: tunnel-answers
    severity: blocks
    applies_to: [client]
    check: { kind: port, url: "URL", timeout_s: 2 }
  - id: config-keys
    severity: blocks
    applies_to: [client]
    check: { kind: keys, file: config.env, against: config.env.example }
  - id: heartbeat
    severity: warns
    applies_to: [lab]
    check: { kind: heartbeat, max_age_s: 60 }
"""


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True,
                          text=True).stdout.strip()


class Ok(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass


class HostChecksTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name, "iac")
        self.repo.mkdir()
        self.stamp = Path(self.tmp.name, "iac-stamp.json")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Ok)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/api/status" % self.server.server_port
        (self.repo / "conformance.yaml").write_text(
            STANDARD.replace("STAMP", str(self.stamp)).replace("URL", self.url))
        (self.repo / "config.env.example").write_text("# comment\nMINI_HOST=x\nexport SESSION_TOKEN=REPLACE_ME\n")
        (self.repo / "config.env").write_text("MINI_HOST=mini\nSESSION_TOKEN=glpat-very-secret-value\n")
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", "conformance.yaml", "config.env.example")
        git(self.repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "one")
        self.first = git(self.repo, "rev-parse", "--short", "HEAD")
        self.loaded = {"com.x.tunnel", "com.x.digest"}
        self.saved = (host_checks._run, host_checks.STAMP_PATH)
        real_run = host_checks._run

        def fake_run(cmd):
            if cmd[0] == "launchctl":
                label = cmd[-1].rsplit("/", 1)[-1]
                if label in self.loaded:
                    return subprocess.CompletedProcess(cmd, 0, "", "")
                return subprocess.CompletedProcess(cmd, 113, "", 'Could not find service "%s"\nmore' % label)
            return real_run(cmd)
        host_checks._run, host_checks.STAMP_PATH = fake_run, self.stamp

    def tearDown(self):
        host_checks._run, host_checks.STAMP_PATH = self.saved
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def write_stamp(self, entries):
        self.stamp.write_text(json.dumps({"repo": "iac", "installers": entries}))

    def results(self, label="mbp", now=None):
        rec = host_checks.run(label, self.repo / "conformance.yaml", now)
        self.assertEqual(rec["standard"], {"name": "test-baseline", "rev": git(self.repo, "rev-parse", "--short", "HEAD")})
        return {r["rule"]: r for r in rec["results"]}

    def test_a_conforming_host_passes(self):
        at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        at = at[:-2] + ":" + at[-2:]
        self.write_stamp({"macos/install.sh": {"commit": self.first, "at": at, "dirty": False}})
        r = self.results()
        self.assertEqual({k: v["status"] for k, v in r.items()},
                         {"installed-revision": "pass", "role-jobs-loaded": "pass", "tunnel-answers": "pass",
                          "config-keys": "pass", "heartbeat": "warn"})
        self.assertEqual(r["role-jobs-loaded"]["value"], "2 of 2")
        self.assertEqual(r["installed-revision"]["value"], "0 commits behind, oldest 0 days")
        self.assertIn("unsupported kind heartbeat", r["heartbeat"]["value"])

    def test_missing_job_fails_with_evidence_and_undeclared_jobs_are_noted(self):
        self.loaded = {"com.x.tunnel"}
        self.write_stamp({"macos/install-launchd-job.sh:com.x.old": {
            "commit": self.first, "at": "2026-10-01T00:00:00-05:00", "dirty": False}})
        r = self.results()["role-jobs-loaded"]
        self.assertEqual((r["status"], r["value"]), ("fail", "1 of 2"))
        self.assertEqual(r["evidence"], ['com.x.digest: Could not find service "com.x.digest"',
                                         "undeclared: com.x.old is installed but none of this host's roles list it"])

    def test_revision_behind_old_dirty_or_unknown(self):
        for n in range(2):
            (self.repo / ("f%d" % n)).write_text("x")
            git(self.repo, "add", "f%d" % n)
            git(self.repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "more")
        self.write_stamp({"macos/install.sh": {"commit": self.first, "at": "2026-01-01T00:00:00-05:00", "dirty": True}})
        r = self.results(now=time.time())["installed-revision"]
        self.assertEqual(r["status"], "warn")
        self.assertTrue(r["value"].startswith("2 commits behind"))
        self.assertIn("installed from a checkout with uncommitted changes", r["evidence"][1])
        self.write_stamp({"macos/install.sh": {"commit": "unknown", "at": "2026-10-01T00:00:00-05:00"}})
        r = self.results()["installed-revision"]
        self.assertEqual((r["status"], r["value"][:15]), ("warn", "unknown commits"))
        self.stamp.unlink()
        self.assertEqual(self.results()["installed-revision"]["value"], "no install stamp")

    def test_keys_report_names_only(self):
        (self.repo / "config.env").write_text("MINI_HOST=glpat-not-a-key-name\n")
        rec = host_checks.run("mbp", self.repo / "conformance.yaml")
        r = {x["rule"]: x for x in rec["results"]}["config-keys"]
        self.assertEqual((r["status"], r["value"], r["evidence"]), ("fail", "1 of 2", ["missing key: SESSION_TOKEN"]))
        self.assertNotIn("glpat", json.dumps(rec))

    def test_port_failures_and_loopback_only(self):
        self.server.shutdown()
        self.server.server_close()
        r = self.results()["tunnel-answers"]
        self.assertEqual((r["status"], r["value"]), ("fail", "no answer"))
        self.assertEqual(host_checks.check_port({"url": "http://192.0.2.10:9119/"})[:2], (False, "not loopback"))

    def test_roles_decide_what_applies_and_unknown_hosts_are_unclassified(self):
        r = self.results("mini")
        self.assertEqual(r["tunnel-answers"]["status"], "na")
        self.assertEqual(r["role-jobs-loaded"]["value"], "0 of 0")
        r = self.results("winpc")
        self.assertEqual(list(r), ["unclassified"])
        self.assertEqual(r["unclassified"]["status"], "warn")

    def test_normalize_drops_malformed_and_caps_evidence(self):
        rec = {"ts": 5.0, "standard": {"name": "s", "rev": "r"}, "results": [
            {"rule": "a", "status": "pass", "value": "v", "evidence": ["Bearer abc"] + ["x" * 500] * 9},
            {"rule": "b", "status": "healthy"}, {"rule": "", "status": "pass"}, "junk"]}
        rows = host_checks.normalize_results(rec, "mbp", False)
        self.assertEqual(len(rows), 1)
        evidence = json.loads(rows[0]["evidence"])
        self.assertEqual((len(evidence), evidence[0], len(evidence[1])), (5, "[redacted]", 200))
        self.assertEqual((rows[0]["host"], rows[0]["verified"], rows[0]["ts"]), ("mbp", 0, 5.0))


if __name__ == "__main__":
    unittest.main()
