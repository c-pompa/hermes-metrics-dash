import tempfile
import unittest
from pathlib import Path

import app
import benchmark


class YieldTests(unittest.TestCase):
    def test_compute_yield_uses_vram_and_parallel(self):
        self.assertEqual(benchmark.compute_yield(38.2, vram_gb=14.1, parallel=1), 2.7092)
        self.assertEqual(benchmark.compute_yield(11.0, vram_gb=15.2, parallel=2), 0.3618)

    def test_compute_yield_falls_back_to_model_gb(self):
        self.assertEqual(benchmark.compute_yield(20.0, model_gb=10.0, parallel=1), 2.0)

    def test_compute_yield_rejects_bad_inputs(self):
        self.assertIsNone(benchmark.compute_yield(None, vram_gb=10, parallel=1))
        self.assertIsNone(benchmark.compute_yield(10, parallel=1))
        self.assertIsNone(benchmark.compute_yield(10, vram_gb=0, parallel=1))


class NormalizeBenchmarkTests(unittest.TestCase):
    def test_normalize_fills_yield_and_auto_experiment(self):
        row = benchmark.normalize_benchmark_sample(
            {
                "ts": 100.0,
                "model": "qwen3.6-27b-uncensored-hauhaucs-aggressive",
                "usage": "deriver",
                "ctx_k": 45,
                "parallel": 1,
                "tps": 38.2,
                "vram_gb": 14.1,
            },
            "WinPC",
        )
        self.assertEqual(row["host"], "WinPC")
        self.assertEqual(row["experiment"], "auto")
        self.assertEqual(row["named"], 0)
        self.assertEqual(row["yield"], 2.7092)

    def test_named_experiment_flag(self):
        row = benchmark.normalize_benchmark_sample(
            {"model": "x", "tps": 1, "model_gb": 1, "parallel": 1, "experiment": "winpc-45k-p1"},
            "WinPC",
        )
        self.assertEqual(row["named"], 1)
        self.assertEqual(row["experiment"], "winpc-45k-p1")


class InferUsageTests(unittest.TestCase):
    def test_heuristics_and_map_override(self):
        self.assertEqual(benchmark.infer_usage("text-embedding-nomic-embed-text-v1.5", "MBP"), "embeddings")
        self.assertEqual(benchmark.infer_usage("supergemma4-26b-uncensored-mlx-v2", "Mini"), "dialectic")
        self.assertEqual(
            benchmark.infer_usage("custom-model", "Mini", {"custom-model": "MoA ref"}),
            "MoA ref",
        )


class BestAggregationTests(unittest.TestCase):
    def test_best_and_current_per_usage_host(self):
        rows = [
            {"ts": 1, "usage": "deriver", "host": "WinPC", "yield": 0.5, "model": "a"},
            {"ts": 2, "usage": "deriver", "host": "WinPC", "yield": 0.9, "model": "b"},
            {"ts": 3, "usage": "deriver", "host": "WinPC", "yield": 0.4, "model": "c"},
            {"ts": 4, "usage": "dialectic", "host": "Mini", "yield": 0.6, "model": "d"},
        ]
        best = benchmark.best_by_usage_host(rows)
        self.assertEqual([(r["usage"], r["host"], r["model"]) for r in best], [
            ("deriver", "WinPC", "b"),
            ("dialectic", "Mini", "d"),
        ])
        current = benchmark.current_by_usage_host(rows)
        self.assertEqual(current[("deriver", "WinPC")]["model"], "c")


class BenchmarkStoreTests(unittest.TestCase):
    def test_insert_query_best_and_mark(self):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        store = app.Store(str(Path(temp_dir.name) / "metrics.db"))
        self.addCleanup(store._conn.close)

        rows = store.insert_benchmark([
            benchmark.normalize_benchmark_sample(
                {
                    "ts": 10.0,
                    "usage": "deriver",
                    "model": "qwen-a",
                    "tps": 10,
                    "model_gb": 10,
                    "parallel": 1,
                },
                "WinPC",
            ),
            benchmark.normalize_benchmark_sample(
                {
                    "ts": 20.0,
                    "usage": "deriver",
                    "model": "qwen-b",
                    "tps": 40,
                    "model_gb": 10,
                    "parallel": 1,
                    "experiment": "win",
                },
                "WinPC",
            ),
        ])
        self.assertEqual(len(rows), 2)

        samples = store.benchmark_samples(since=0, until=100, limit=10)
        self.assertEqual([r["model"] for r in samples], ["qwen-a", "qwen-b"])

        store.set_benchmark_mark("sprint-1", host="WinPC")
        attached = store.insert_benchmark([
            benchmark.normalize_benchmark_sample(
                {"ts": 30.0, "usage": "deriver", "model": "qwen-c", "tps": 5, "model_gb": 10, "parallel": 1},
                "WinPC",
            )
        ])
        self.assertEqual(attached[0]["experiment"], "sprint-1")
        self.assertEqual(attached[0]["named"], 1)

        payload = store.benchmark_best(since=0, until=100)
        self.assertEqual(payload["best"][0]["model"], "qwen-b")
        self.assertEqual(payload["current"][0]["model"], "qwen-c")


if __name__ == "__main__":
    unittest.main()
