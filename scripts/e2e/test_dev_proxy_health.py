from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


DEV_SCRIPT = Path(__file__).resolve().parents[1] / "dev.py"
SPEC = importlib.util.spec_from_file_location("thechat_dev_script", DEV_SCRIPT)
assert SPEC is not None and SPEC.loader is not None
DEV = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = DEV
SPEC.loader.exec_module(DEV)


class DevProxyHealthUrlTests(unittest.TestCase):
    def test_uses_the_reachable_address_for_each_proxy_bind_host(self) -> None:
        cases = {
            "127.0.0.1": "http://127.0.0.1:3338/health",
            "100.99.93.71": "http://100.99.93.71:3338/health",
            "0.0.0.0": "http://127.0.0.1:3338/health",
            "::": "http://[::1]:3338/health",
            "fd7a:115c:a1e0::1": "http://[fd7a:115c:a1e0::1]:3338/health",
        }

        for bind_host, expected in cases.items():
            with self.subTest(bind_host=bind_host):
                self.assertEqual(DEV.proxy_health_url(bind_host, 3338), expected)


if __name__ == "__main__":
    unittest.main()
