"""Failing-first tests for harness/telemetry.py (plan Task 4).

Parser tests get fixture strings. Every subprocess call goes through the
module `run_cmd` seam, which snapshot() resolves by name at call time — so a
mock.patch.object on harness.telemetry.run_cmd (and the direct-subprocess
call inside _memory_pressure) intercepts everything. The suite never runs a
real system command.
"""
import json
import unittest
from unittest import mock

import harness.telemetry as telemetry
from harness.telemetry import (LEVELS, parse_therm, parse_swap)


# Fixture strings mirroring real macOS output (M4 MBP).
PMSET_THERM_FIXTURE = "\n".join([
    "Note: No thermal warning level has been recorded",
    "Note: No performance warning level has been recorded",
])

PMSET_THERM_HOT_FIXTURE = (
    "Note: CPU power status has been recorded\n"
    "CPU_Thermal_Level: 2\n")

SYSCTL_SWAP_FIXTURE = "vm.swapusage: total = 0.00M  used = 0.00M  " \
                      "free = 0.00M  (encrypted)"

# Real sysctl emits "Swapusage =" — accept both wordings in the parser.
SYSCTL_SWAP_USED_FIXTURE = "vm.swapusage: Swapusage = 1.25G used,\n"

MEMSIZE_FIXTURE = "hw.memsize: 34359738368"

VM_16K_FIXTURE = "\n".join([
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                   70095.",
    "Pages active:                                 484254.",
    "Pages inactive:                               465746.",
])

VM_16K_LOW_FIXTURE = "\n".join([
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                    2907.",
    "Pages active:                                 484254.",
    "Pages inactive:                                3907.",
])

VM_16K_MODERATE_FIXTURE = "\n".join([
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                   45693.",
    "Pages active:                                 484254.",
    "Pages inactive:                               75907.",
])

MEMPRESS_NORMAL_FIXTURE = (
    "System memory status is normal\nOut of Memory count: 0\n")

MEMPRESS_WARN_FIXTURE = (
    "System memory status is warn\nOut of Memory count: 1\n")

MEMPRESS_CRIT_FIXTURE = (
    "System memory status is critical\nOut of Memory count: 3\n")

BATT_AC_FIXTURE = (
    "Now drawing from 'AC Power' (InternalBattery-0) - "
    "discharging: 100.0%\n"
    "\tInternalBattery-0 (id=...) 100%; discharging; ")

BATT_BATTERY_FIXTURE = (
    "Now drawing from 'Battery Power' (InternalBattery-0) - "
    "discharging: 42.0%\n")


def _fixtured_run(fixtures, seen):
    """Fake run_cmd: dict keyed by argv tuple; records every call."""
    def fake_run(cmd, timeout=10):
        key = tuple(str(c) for c in cmd)
        seen.append(key)
        return fixtures.get(key)
    return fake_run


class TestThermal(unittest.TestCase):
    def test_parse_therm_nominal(self):
        self.assertEqual(parse_therm("CPU_Thermal_Level: 0\n"), "nominal")
        self.assertEqual(parse_therm("CPU_Thermal_Level: 2\n"), "hot")

    def test_parse_therm_garbage(self):
        self.assertEqual(parse_therm("not a therm output"), "unknown")

    def test_parse_therm_no_level_recorded(self):
        # idle M4: pmset prints only the three "No ... recorded" notes.
        self.assertEqual(parse_therm(PMSET_THERM_FIXTURE), "nominal")

    def test_level_map(self):
        self.assertEqual(LEVELS, {"0": "nominal", "1": "moderate",
                                   "2": "hot"})


class TestMemory(unittest.TestCase):
    def test_parse_swap(self):
        self.assertEqual(parse_swap("Swapusage = 512M used"), 512)
        self.assertEqual(parse_swap("Swapusage = 1.25G used"), 1280)

    def test_parse_memory_pressure(self):
        self.assertEqual(
            telemetry.parse_memory_pressure("System memory status is normal"),
            "none")
        self.assertEqual(
            telemetry.parse_memory_pressure("System memory status is free"),
            "none")
        self.assertEqual(
            telemetry.parse_memory_pressure("System memory status is warn"),
            "moderate")
        self.assertEqual(
            telemetry.parse_memory_pressure(MEMPRESS_CRIT_FIXTURE), "high")

    def test_parse_vm_stat_pagesize_aware(self):
        # 16K pages, free+inactive = 535_841 -> 8372 MB
        self.assertEqual(telemetry.parse_vm_stat(VM_16K_FIXTURE), 8372)
        # classic 4096-byte pages: free+inactive = 1,638,000 pages
        # -> 1,638,000 * 4096 / (1024*1024) = 6398 MB
        self.assertEqual(
            telemetry.parse_vm_stat(
                "Mach Virtual Memory Statistics: (page size of 4096 bytes)"
                "\nPages free:             150000."
                "\nPages inactive:       1488000."), 6398)
        # "Pages throttled:" must not be picked up as the free label.
        # free(1) + inactive(2047) = 2048 pages * 4096 B = 8 MB; if the
        # 900000 throttled pages were counted it would read ~3522 MB.
        self.assertEqual(
            telemetry.parse_vm_stat(
                "Mach Virtual Memory Statistics: (page size of 4096 bytes)"
                "\nPages free:                 1."
                "\nPages throttled:      900000."
                "\nPages inactive:        2047."), 8)

    def test_parse_pressure_thresholds(self):
        # valid kernel state wins over the numeric fallback
        self.assertEqual(telemetry.parse_pressure("normal", 10276, None), "none")
        self.assertEqual(telemetry.parse_pressure("normal", 1024, None), "none")
        self.assertEqual(telemetry.parse_pressure("critical", 1024, 513), "high")
        # missing state -> thresholds on avail/total (MB / MB): 3.1% -> high,
        # 6.25% -> moderate, 48% -> none
        self.assertEqual(telemetry.parse_pressure(None, 1024, 32768), "high")
        self.assertEqual(telemetry.parse_pressure(None, 2048, 32768), "moderate")
        self.assertEqual(telemetry.parse_pressure(None, 15728, 32768), "none")


class TestPower(unittest.TestCase):
    def test_ac(self):
        self.assertEqual(telemetry.parse_power(BATT_AC_FIXTURE), "ac")

    def test_battery(self):
        self.assertEqual(telemetry.parse_power(BATT_BATTERY_FIXTURE), "battery")

    def test_garbage(self):
        self.assertIsNone(telemetry.parse_power("nothing useful"))


class TestSnapshot(unittest.TestCase):
    def setUp(self):
        self.seen = []

    def _run_snapshot(self, fixtures):
        fake = _fixtured_run(fixtures, self.seen)
        with mock.patch.object(telemetry, "run_cmd", fake):
            return telemetry.snapshot()

    def test_snapshot_all_commands(self):
        fixtures = {
            ("pmset", "-g", "therm"): PMSET_THERM_HOT_FIXTURE,
            ("memory_pressure", "-Q"): MEMPRESS_WARN_FIXTURE,
            ("vm_stat",): VM_16K_FIXTURE,
            ("sysctl", "hw.memsize"): MEMSIZE_FIXTURE,
            ("sysctl", "vm.swapusage"): SYSCTL_SWAP_USED_FIXTURE,
            ("pmset", "-g", "batt"): BATT_AC_FIXTURE,
        }
        snap = self._run_snapshot(fixtures)
        self.assertEqual(snap["thermal"], "hot")
        self.assertEqual(snap["memory_pressure"], "moderate")
        self.assertEqual(snap["mem_avail_mb"], 8372)
        self.assertEqual(snap["swap_mb"], 1280)
        self.assertEqual(snap["power_source"], "ac")
        json.dumps(snap)  # JSON-serializable

    def test_snapshot_vm_stat_fallback(self):
        # memory_pressure -Q missing output -> vm_stat thresholds decide.
        fixtures = {
            ("pmset", "-g", "therm"): None,
            ("memory_pressure", "-Q"): None,
            ("vm_stat",): VM_16K_LOW_FIXTURE,        # ~105 MB avail of 32 GB
            ("sysctl", "hw.memsize"): MEMSIZE_FIXTURE,
            ("sysctl", "vm.swapusage"): SYSCTL_SWAP_FIXTURE,
            ("pmset", "-g", "batt"): BATT_BATTERY_FIXTURE,
        }
        snap = self._run_snapshot(fixtures)
        self.assertEqual(snap["memory_pressure"], "high")  # < 5% avail

    def test_snapshot_vm_stat_moderate(self):
        fixtures = {
            ("pmset", "-g", "therm"): None,
            ("memory_pressure", "-Q"): None,
            ("vm_stat",): VM_16K_MODERATE_FIXTURE,      # ~1.5% avail of 32 GB
            ("sysctl", "hw.memsize"): MEMSIZE_FIXTURE,
            ("sysctl", "vm.swapusage"): None,
            ("pmset", "-g", "batt"): BATT_BATTERY_FIXTURE,
        }
        snap = self._run_snapshot(fixtures)
        self.assertEqual(snap["memory_pressure"], "moderate")  # < 10%
        # 45693 + 75907 = 121600 pages * 16384 B = 1900 MB (5.8% of 32 GB)
        self.assertEqual(snap["mem_avail_mb"], 1900)

    def test_snapshot_all_commands_fail(self):
        snap = self._run_snapshot({})  # everything -> None
        for key in ("thermal", "memory_pressure", "mem_avail_mb",
                    "swap_mb", "power_source"):
            self.assertIn(key, snap)
        json.dumps(snap)  # degrades to safe sentinels, never raises

    def test_no_real_subprocess_calls(self):
        # Nothing in the module may reach a real subprocess during snapshot.
        def explode(*a, **k):
            raise AssertionError("real subprocess invoked: %r" % (a,))

        fake = _fixtured_run({
            ("pmset", "-g", "therm"): PMSET_THERM_FIXTURE,
            ("memory_pressure", "-Q"): MEMPRESS_NORMAL_FIXTURE,
            ("vm_stat",): VM_16K_FIXTURE,
            ("sysctl", "hw.memsize"): MEMSIZE_FIXTURE,
            ("sysctl", "vm.swapusage"): SYSCTL_SWAP_FIXTURE,
            ("pmset", "-g", "batt"): BATT_AC_FIXTURE,
        }, self.seen)
        with mock.patch.object(telemetry.subprocess, "run", explode):
            self._run_snapshot({})  # seams intercept; subprocess.run untouched
            snap = self._run_snapshot({})
        self.assertEqual(snap["thermal"], "unknown")
        self.assertGreater(len(self.seen), 0)


if __name__ == "__main__":
    unittest.main()
