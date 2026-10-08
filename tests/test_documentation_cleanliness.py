import subprocess
import unittest
from pathlib import Path

import forwarder


ROOT = Path(__file__).resolve().parents[1]


class DocumentationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.readme = (ROOT / "README.md").read_text(encoding="utf-8")
        cls.readme_lower = cls.readme.lower()

    def test_moa_documentation_describes_always_on_metrics_source(self):
        self.assertIn("~/.hermes/metrics/moa-refs.jsonl", self.readme)
        self.assertIn("every moa turn", self.readme_lower)
        self.assertIn("audit-only", self.readme_lower)
        self.assertNotIn("tails both sources", self.readme_lower)
        self.assertNotIn("`moa_ref` | moa-traces", self.readme_lower)

        doc = (forwarder.__doc__ or "").lower()
        self.assertIn("~/.hermes/metrics/moa-refs.jsonl", doc)
        self.assertIn("every moa turn", doc)
        self.assertIn("audit-only", doc)
        self.assertIn("not tailed", doc)

    def test_readme_documents_hook_deployment_and_operations_filters(self):
        self.assertIn(
            "cp hooks/metrics-emit.py ~/.hermes/hooks/metrics-emit.py",
            self.readme,
        )
        self.assertIn(
            "chmod +x ~/.hermes/hooks/metrics-emit.py",
            self.readme,
        )
        for phrase in (
            "host, search, event, and range",
            "model",
            "conversation",
            "clear all",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, self.readme_lower)

    def test_readme_discloses_operational_assumptions(self):
        for phrase in (
            "trusted lan",
            "unauthenticated",
            "/ingest",
            "0.0.0.0",
            "access-control-allow-origin: *",
            "unbounded",
            "no automatic pruning",
            "hard-coded",
            "launchd",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, self.readme_lower)


class RepositoryCleanlinessTests(unittest.TestCase):
    def test_python_cache_files_are_ignored_and_not_tracked(self):
        ignore = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("__pycache__/", ignore)
        self.assertIn("*.py[cod]", ignore)

        result = subprocess.run(
            ["git", "ls-files"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        tracked = [
            path
            for path in result.stdout.splitlines()
            if "__pycache__/" in path or path.endswith((".pyc", ".pyo"))
        ]
        self.assertEqual(tracked, [])


if __name__ == "__main__":
    unittest.main()
