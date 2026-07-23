#!/usr/bin/env python3
"""Regression coverage for environment-derived E2E suite configuration."""

from __future__ import annotations

import os
import runpy
import signal
import subprocess
import sys
import unittest
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "scripts" / "test.py"


class TestRunnerConfigTests(unittest.TestCase):
    def _load_runner(self, overrides: dict[str, str]) -> dict[str, Any]:
        original = dict(os.environ)
        try:
            for key in (
                "THECHAT_E2E_POSTGRES_PORT",
                "THECHAT_E2E_REDIS_PORT",
                "THECHAT_E2E_DATABASE_URL",
                "THECHAT_E2E_REDIS_URL",
            ):
                os.environ.pop(key, None)
            os.environ.update(overrides)
            return runpy.run_path(str(RUNNER), run_name="thechat_test_runner_config")
        finally:
            os.environ.clear()
            os.environ.update(original)

    def _load_suites(self, overrides: dict[str, str]) -> list[dict[str, Any]]:
        namespace = self._load_runner(overrides)
        return cast(list[dict[str, Any]], namespace["SUITES"])

    def test_approval_urls_follow_explicit_port_overrides(self):
        suites = self._load_suites(
            {
                "THECHAT_E2E_POSTGRES_PORT": "25432",
                "THECHAT_E2E_REDIS_PORT": "26379",
            }
        )
        approval = next(
            suite for suite in suites if suite["name"] == "hermes-approval-ui"
        )
        self.assertEqual(
            approval["env"]["THECHAT_E2E_DATABASE_URL"],
            "postgres://thechat:thechat@localhost:25432/thechat",
        )
        self.assertEqual(
            approval["env"]["THECHAT_E2E_REDIS_URL"],
            "redis://localhost:26379",
        )

    def test_explicit_service_urls_still_win_over_derived_defaults(self):
        suites = self._load_suites(
            {
                "THECHAT_E2E_POSTGRES_PORT": "25432",
                "THECHAT_E2E_REDIS_PORT": "26379",
                "THECHAT_E2E_DATABASE_URL": "postgres://explicit.invalid/db",
                "THECHAT_E2E_REDIS_URL": "redis://explicit.invalid:6379",
            }
        )
        approval = next(
            suite for suite in suites if suite["name"] == "hermes-approval-ui"
        )
        self.assertEqual(
            approval["env"]["THECHAT_E2E_DATABASE_URL"],
            "postgres://explicit.invalid/db",
        )
        self.assertEqual(
            approval["env"]["THECHAT_E2E_REDIS_URL"],
            "redis://explicit.invalid:6379",
        )

    def test_bounded_suite_returns_timeout_failure(self):
        namespace = self._load_runner({})
        run_suite = namespace["run_suite"]
        result = run_suite(
            {
                "name": "timeout-probe",
                "cmd": [sys.executable, "-c", "import time; time.sleep(60)"],
                "timeout": 0.05,
            }
        )
        self.assertEqual(result.returncode, 124)
        self.assertIn("wall-clock timeout", result.output)

    def test_shutdown_forwarding_terminates_registered_suite_group(self):
        namespace = self._load_runner({})
        register = namespace["_register_suite_group"]
        unregister = namespace["_unregister_suite_group"]
        forward = namespace["_forward_suite_shutdown"]
        proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            start_new_session=True,
        )
        register(proc.pid)
        try:
            forward(signal.SIGTERM)
            proc.wait(timeout=5)
            self.assertNotEqual(proc.returncode, 0)
        finally:
            unregister(proc.pid)
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
