import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_TEST = ROOT / "tests" / "dashboard_runtime.test.js"
DURATION_TEST = ROOT / "duration-format.test.js"


class DashboardJavaScriptRuntimeTests(unittest.TestCase):
    def test_dashboard_runtime_behaviors(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node.js is unavailable")

        result = subprocess.run(
            [node, "--test", str(RUNTIME_TEST)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"Node dashboard tests failed:\n{result.stdout}\n{result.stderr}",
        )

    def test_duration_formatting_helper(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node.js is unavailable")
        if not DURATION_TEST.exists():
            self.skipTest("duration-format.test.js is unavailable")

        result = subprocess.run(
            [node, "--test", str(DURATION_TEST)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"Duration format tests failed:\n{result.stdout}\n{result.stderr}",
        )


if __name__ == "__main__":
    unittest.main()
