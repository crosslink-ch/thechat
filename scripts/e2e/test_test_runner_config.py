#!/usr/bin/env python3
"""Regression coverage for environment-derived E2E suite configuration."""

from __future__ import annotations

import json
import os
import runpy
import signal
import subprocess
import sys
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, cast

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "scripts" / "test.py"


class TestRunnerConfigTests(unittest.TestCase):
    def _load_runner(self, overrides: dict[str, str]) -> dict[str, Any]:
        original = dict(os.environ)
        try:
            for key in (
                "THECHAT_E2E_API_PORT",
                "THECHAT_E2E_POSTGRES_PORT",
                "THECHAT_E2E_REDIS_PORT",
                "THECHAT_E2E_DATABASE_URL",
                "THECHAT_E2E_REDIS_URL",
                "THECHAT_APPROVAL_E2E_API_PORT",
                "THECHAT_APPROVAL_E2E_POSTGRES_PORT",
                "THECHAT_APPROVAL_E2E_REDIS_PORT",
                "HERMES_APPROVAL_E2E_MODEL_PORT",
                "HERMES_APPROVAL_E2E_WEBHOOK_PORT",
                "HERMES_E2E_SOURCE_DIR",
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

    def test_suite_worker_count_leaves_capacity_for_parallel_test_tools(self):
        suite_worker_count = self._load_runner({})["suite_worker_count"]
        cases = (
            (1, 6, 1),
            (2, 6, 1),
            (3, 6, 1),
            (4, 6, 2),
            (8, 6, 4),
            (32, 6, 6),
            (8, 1, 1),
        )
        for cpu_count, suite_count, expected in cases:
            with self.subTest(cpu_count=cpu_count, suite_count=suite_count):
                self.assertEqual(
                    suite_worker_count(suite_count, cpu_count=cpu_count),
                    expected,
                )

    def test_default_api_suite_uses_integration_timeout_and_skips_guarded_tests(self):
        package = json.loads(
            (ROOT / "packages" / "api" / "package.json").read_text()
        )
        command = package["scripts"]["test"]
        self.assertIn("--timeout=30000", command)
        self.assertIn(
            "--path-ignore-patterns=src/auth/rate-limit.test.ts",
            command,
        )
        self.assertIn(
            "--path-ignore-patterns=src/auth/password-reset.test.ts",
            command,
        )

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

    def test_approval_defaults_to_sibling_hermes_and_honors_webhook_override(self):
        approval = next(
            suite
            for suite in self._load_suites(
                {"HERMES_APPROVAL_E2E_WEBHOOK_PORT": "28082"}
            )
            if suite["name"] == "hermes-approval-ui"
        )
        self.assertEqual(
            approval["env"]["HERMES_E2E_SOURCE_DIR"],
            str(ROOT.parent / "hermes-agent"),
        )
        self.assertEqual(
            approval["env"]["HERMES_APPROVAL_E2E_WEBHOOK_PORT"],
            "28082",
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

    def test_default_opt_in_runs_receive_distinct_service_ports(self):
        first = self._load_suites({})
        second = self._load_suites({})
        first_hermes = next(suite for suite in first if suite["name"] == "hermes")
        second_hermes = next(suite for suite in second if suite["name"] == "hermes")
        first_approval = next(
            suite for suite in first if suite["name"] == "hermes-approval-ui"
        )
        second_approval = next(
            suite for suite in second if suite["name"] == "hermes-approval-ui"
        )
        first_hermes_ports = {
            first_hermes["env"]["THECHAT_E2E_API_PORT"],
            first_hermes["env"]["THECHAT_E2E_POSTGRES_PORT"],
            first_hermes["env"]["THECHAT_E2E_REDIS_PORT"],
        }
        second_hermes_ports = {
            second_hermes["env"]["THECHAT_E2E_API_PORT"],
            second_hermes["env"]["THECHAT_E2E_POSTGRES_PORT"],
            second_hermes["env"]["THECHAT_E2E_REDIS_PORT"],
        }
        first_approval_ports = {
            first_approval["env"]["THECHAT_E2E_API_PORT"],
            first_approval["env"]["THECHAT_E2E_POSTGRES_PORT"],
            first_approval["env"]["THECHAT_E2E_REDIS_PORT"],
            first_approval["env"]["HERMES_APPROVAL_E2E_MODEL_PORT"],
            first_approval["env"]["HERMES_APPROVAL_E2E_WEBHOOK_PORT"],
        }
        second_approval_ports = {
            second_approval["env"]["THECHAT_E2E_API_PORT"],
            second_approval["env"]["THECHAT_E2E_POSTGRES_PORT"],
            second_approval["env"]["THECHAT_E2E_REDIS_PORT"],
            second_approval["env"]["HERMES_APPROVAL_E2E_MODEL_PORT"],
            second_approval["env"]["HERMES_APPROVAL_E2E_WEBHOOK_PORT"],
        }
        self.assertEqual(len(first_hermes_ports), 3)
        self.assertEqual(len(second_hermes_ports), 3)
        self.assertEqual(len(first_approval_ports), 5)
        self.assertEqual(len(second_approval_ports), 5)
        self.assertTrue(first_hermes_ports.isdisjoint(second_hermes_ports))
        self.assertTrue(first_approval_ports.isdisjoint(second_approval_ports))
        self.assertTrue(first_hermes_ports.isdisjoint(first_approval_ports))
        self.assertTrue(second_hermes_ports.isdisjoint(second_approval_ports))

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

    def test_interrupted_main_stops_running_suite_and_cancels_queued_suite(self):
        namespace = self._load_runner({})
        runner_globals = namespace["main"].__globals__
        with TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            running_marker = temporary_path / "running"
            queued_marker = temporary_path / "queued"
            runner_globals["available_cpu_count"] = lambda: 2
            runner_globals["SUITES"] = [
                {
                    "name": "running",
                    "cmd": [
                        sys.executable,
                        "-c",
                        (
                            "from pathlib import Path; import sys, time; "
                            "Path(sys.argv[1]).write_text('running'); time.sleep(60)"
                        ),
                        str(running_marker),
                    ],
                },
                {
                    "name": "queued",
                    "cmd": [
                        sys.executable,
                        "-c",
                        (
                            "from pathlib import Path; import sys; "
                            "Path(sys.argv[1]).write_text('started')"
                        ),
                        str(queued_marker),
                    ],
                },
            ]

            def interrupt_when_running() -> None:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not running_marker.exists():
                    time.sleep(0.01)
                os.kill(os.getpid(), signal.SIGINT)

            interrupt_thread = threading.Thread(
                target=interrupt_when_running,
                daemon=True,
            )
            previous_argv = sys.argv
            interrupt_thread.start()
            try:
                sys.argv = ["scripts/test.py", "running", "queued"]
                started = time.monotonic()
                with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                    with self.assertRaises(SystemExit) as raised:
                        namespace["main"]()
                duration = time.monotonic() - started
            finally:
                sys.argv = previous_argv
            interrupt_thread.join(timeout=5)

            self.assertEqual(raised.exception.code, 128 + signal.SIGINT)
            self.assertTrue(running_marker.exists())
            self.assertFalse(queued_marker.exists())
            self.assertLess(duration, 10)

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
