import json
import unittest
from unittest import mock


import forwarder

LINK = json.dumps({"deviceName": "host-b", "peers": [{"deviceIdentifier": "fb02", "deviceName": "DESKTOP"}]})
PS = json.dumps([{"identifier": "qwen", "deviceIdentifier": "fb02"}, {"identifier": "gemma", "deviceIdentifier": None}])


class DeviceMapTest(unittest.TestCase):
    def test_keeps_names_when_link_status_fails(self):
        link_ok = [True]

        def lms(args, **_):
            if args[1] == "link":
                if not link_ok[0]:
                    raise OSError("lms link status timed out")
                return LINK.encode()
            return PS.encode()

        devices = forwarder.DeviceMap()
        with mock.patch.object(forwarder.subprocess, "check_output", side_effect=lms):
            self.assertEqual(devices.snapshot(), {"qwen": "DESKTOP", "gemma": "host-b"})
            link_ok[0] = False
            devices._polled = 0.0
            self.assertEqual(devices.snapshot(), {"qwen": "DESKTOP", "gemma": "host-b"})


class ShortHostLabelTest(unittest.TestCase):
    def test_default_and_configured_labels(self):
        self.assertEqual([forwarder.short_host_label(n) for n in ("My-Mac-mini", "Someones-MacBook-Pro", "DESKTOP")],
                         ["mini", "mbp", "DESKTOP"])
        with mock.patch.object(forwarder, "LINK_LABELS", [["desk", "gpu"], ["mini", "mini"]]):
            self.assertEqual(forwarder.short_host_label("DESKTOP-1"), "gpu")


if __name__ == "__main__":
    unittest.main()
