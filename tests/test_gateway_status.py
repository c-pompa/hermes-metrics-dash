import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


import forwarder


def _write(home, rel, pid, platforms, state="running"):
    path = home / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"pid": pid, "gateway_state": state, "platforms": platforms}))


class GatewayStatusTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        patcher = mock.patch.object(forwarder, "HERMES_HOME", self.home)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)
        self.pid = os.getpid()

    def states(self, records):
        return {r["platform"]: r["label"] for r in records}

    def test_baseline_then_changes_only(self):
        _write(self.home, "gateway_state.json", self.pid, {
            "discord": {"state": "connected", "writer_pid": self.pid},
            "work:discord": {"state": "fatal", "error_message": "intents\nfix: portal", "writer_pid": self.pid},
            "feishu": {"state": "connected", "writer_pid": 1},
        })
        last = {}
        first = forwarder.sample_gateway_status(last)
        self.assertEqual(self.states(first), {
            "default:discord": "connected", "work:discord": "fatal", "default:feishu": "stale"})
        self.assertEqual([r["error_message"] for r in first if r["platform"] == "work:discord"], ["intents"])
        self.assertEqual(forwarder.sample_gateway_status(last), [])

        _write(self.home, "gateway_state.json", self.pid, {
            "discord": {"state": "disconnected", "writer_pid": self.pid},
            "work:discord": {"state": "fatal", "error_message": "intents", "writer_pid": self.pid},
        })
        self.assertEqual(self.states(forwarder.sample_gateway_status(last)), {
            "default:discord": "disconnected", "default:feishu": "stopped"})
        self.assertEqual(forwarder.sample_gateway_status(last), [])

    def test_dead_or_stopped_gateway_is_ignored(self):
        _write(self.home, "profiles/work/gateway_state.json", 2 ** 22 + 12345, {"discord": {"state": "connected"}})
        _write(self.home, "gateway_state.json", self.pid, {"discord": {"state": "connected"}}, state="stopped")
        self.assertEqual(forwarder.sample_gateway_status({}), [])

    def test_unchanged_state_is_resent_hourly(self):
        _write(self.home, "gateway_state.json", self.pid, {"discord": {"state": "connected"}})
        last = {}
        forwarder.sample_gateway_status(last)
        last["default:discord"] = last["default:discord"][:2] + (0.0,)
        self.assertEqual(self.states(forwarder.sample_gateway_status(last)), {"default:discord": "connected"})


if __name__ == "__main__":
    unittest.main()
