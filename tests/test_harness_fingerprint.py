import unittest

from harness.fingerprint import fingerprint, normalize_config


class TestFingerprint(unittest.TestCase):
    def test_normalize_config_drops_volatile_keys(self):
        cfg = {"context_length": 32768, "gpu_offload": 999, "kv_quant": "q8_0",
               "flash_attention": True, "draft_model": None, "wallclock": "x"}
        n = normalize_config(cfg)
        self.assertNotIn("wallclock", n)
        self.assertEqual(n["draft_model"], "none")

    def test_fingerprint_is_stable_and_short(self):
        a = fingerprint({"context_length": 32768, "gpu_offload": 999})
        b = fingerprint({"gpu_offload": 999, "context_length": 32768})
        self.assertEqual(a, b)
        self.assertEqual(len(a), 12)

    def test_parallel_participates_in_fingerprint(self):
        """H-8 fix: parallel sessions are a real lever and must move the fp."""
        base = {"context_length": 87040, "parallel": 1}
        self.assertNotEqual(fingerprint(base), fingerprint({**base, "parallel": 2}))
        n = normalize_config({"context_length": 87040})
        self.assertIn("parallel", n)
        self.assertIsNone(n["parallel"])


if __name__ == "__main__":
    unittest.main()
