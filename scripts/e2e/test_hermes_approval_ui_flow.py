#!/usr/bin/env python3
"""Unit coverage for the real-Hermes approval UI E2E supervisor."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parents[2]
FLOW = ROOT / "scripts" / "e2e" / "hermes-approval-ui-flow.py"


def load_flow() -> Any:
    spec = importlib.util.spec_from_file_location("hermes_approval_ui_flow_test", FLOW)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeProcess:
    pid = 43210

    def wait(self, timeout: float | None = None):
        assert timeout is not None
        raise subprocess.TimeoutExpired(["fake"], timeout)


class FakeExitedProcess:
    pid = 43211

    def wait(self, timeout: float | None = None):
        return 7


class HermesApprovalUiFlowTests(unittest.TestCase):
    def setUp(self):
        self.flow = load_flow()

    def test_parallel_run_lock_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.flow.TMP = Path(tmp)
            with self.flow._exclusive_run_lock():
                with self.assertRaisesRegex(RuntimeError, "Another Hermes approval"):
                    with self.flow._exclusive_run_lock():
                        self.fail("second lock unexpectedly succeeded")

    def test_safe_child_environment_drops_provider_credentials_and_proxies(self):
        sentinels = {
            "OPENROUTER_API_KEY": "secret",
            "AWS_SECRET_ACCESS_KEY": "secret",
            "HTTPS_PROXY": "https://external.invalid",
            "SSH_AUTH_SOCK": "/private/agent.sock",
        }
        previous = {key: os.environ.get(key) for key in sentinels}
        try:
            os.environ.update(sentinels)
            child_env = self.flow._safe_child_env()
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

        self.assertFalse(sentinels.keys() & child_env.keys())
        self.assertTrue(child_env["OPENAI_BASE_URL"].startswith("http://127.0.0.1:"))
        self.assertEqual(child_env["NO_PROXY"], "127.0.0.1,localhost,::1")

    def test_bounded_desktop_process_terminates_its_group_on_timeout(self):
        captured: dict[str, object] = {}
        original_popen = self.flow.subprocess.Popen
        original_terminate = self.flow.harness.terminate_process

        def fake_popen(cmd, **kwargs):
            captured["cmd"] = cmd
            captured["kwargs"] = kwargs
            return FakeProcess()

        def fake_terminate(proc, timeout=15):
            captured["terminated"] = proc
            captured["terminate_timeout"] = timeout

        try:
            self.flow.subprocess.Popen = fake_popen
            self.flow.harness.terminate_process = fake_terminate
            with self.assertRaises(subprocess.TimeoutExpired):
                self.flow._run_bounded_process_group(
                    ["fake", "command"],
                    env={"PATH": "/usr/bin"},
                    cwd=ROOT,
                    timeout=1,
                )
        finally:
            self.flow.subprocess.Popen = original_popen
            self.flow.harness.terminate_process = original_terminate

        self.assertIsInstance(captured["terminated"], FakeProcess)
        self.assertEqual(captured["terminate_timeout"], 10)
        kwargs = cast(dict[str, Any], captured["kwargs"])
        self.assertIs(kwargs["start_new_session"], True)

    def test_failed_desktop_process_terminates_surviving_group(self):
        captured: dict[str, object] = {}
        original_popen = self.flow.subprocess.Popen
        original_terminate = self.flow.harness.terminate_process

        def fake_popen(cmd, **kwargs):
            return FakeExitedProcess()

        def fake_terminate(proc, timeout=15):
            captured["terminated"] = proc
            captured["terminate_timeout"] = timeout

        try:
            self.flow.subprocess.Popen = fake_popen
            self.flow.harness.terminate_process = fake_terminate
            with self.assertRaises(subprocess.CalledProcessError):
                self.flow._run_bounded_process_group(
                    ["fake", "command"],
                    env={"PATH": "/usr/bin"},
                    cwd=ROOT,
                    timeout=1,
                )
        finally:
            self.flow.subprocess.Popen = original_popen
            self.flow.harness.terminate_process = original_terminate

        self.assertIsInstance(captured["terminated"], FakeExitedProcess)
        self.assertEqual(captured["terminate_timeout"], 10)


if __name__ == "__main__":
    unittest.main()
