#!/usr/bin/env python3
"""Unit coverage for the Hermes bot E2E harness."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from typing import Any, IO, cast


ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "scripts" / "e2e" / "hermes-bot-flow.py"


def load_harness() -> Any:
    spec = importlib.util.spec_from_file_location("hermes_bot_flow", HARNESS)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeGatewayProcess:
    returncode = None

    def poll(self):
        return None


class HermesBotFlowTests(unittest.TestCase):
    def test_gateway_starts_without_hermes_cli_service_refresh_path(self):
        """The E2E gateway must not invoke `hermes gateway run`.

        The Hermes CLI foreground command refreshes the installed user systemd
        unit on startup. With an isolated HERMES_HOME, that can rewrite the
        developer's normal `hermes-gateway.service` to point at the temporary
        E2E home. The harness should call the gateway runtime directly instead.
        """
        harness = load_harness()
        captured: dict[str, object] = {}

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            harness.HERMES_SOURCE_DIR = tmp_path / "hermes-src"
            harness.HERMES_HOME_ROOT = tmp_path / "homes"
            harness.HERMES_LOG_ROOT = tmp_path / "logs"
            harness.HERMES_PROVIDER = "fake-provider"
            harness.HERMES_MODEL = "fake-model"
            harness.UV = "uv"
            harness.HERMES_SOURCE_DIR.mkdir()

            original_popen = harness.subprocess.Popen
            original_sleep = harness.time.sleep

            def fake_popen(
                cmd,
                *,
                cwd=None,
                env=None,
                stdout=None,
                stderr=None,
                text=None,
                start_new_session=None,
            ):
                captured["cmd"] = list(cmd)
                captured["cwd"] = cwd
                captured["env"] = dict(env or {})
                captured["stdout"] = stdout
                captured["stderr"] = stderr
                captured["text"] = text
                captured["start_new_session"] = start_new_session
                return FakeGatewayProcess()

            try:
                harness.subprocess.Popen = fake_popen
                harness.time.sleep = lambda _seconds: None
                proc = harness.start_hermes_gateway(
                    {"PATH": "/usr/bin"},
                    "http://localhost:3338",
                    "bot_test",
                    "Nova E2E",
                )
            finally:
                stream = cast(IO[str] | None, captured.get("stdout"))
                if stream is not None:
                    stream.close()
                harness.subprocess.Popen = original_popen
                harness.time.sleep = original_sleep

            self.assertIsInstance(proc, FakeGatewayProcess)
            cmd = cast(list[object], captured["cmd"])
            joined = " ".join(str(part) for part in cmd)
            self.assertNotIn("hermes gateway run", joined)
            self.assertNotIn("hermes_cli.main", joined)
            self.assertIn("python", joined)
            self.assertEqual(captured["cwd"], harness.HERMES_SOURCE_DIR)
            self.assertIs(captured["start_new_session"], True)
            env = cast(dict[str, str], captured["env"])
            self.assertEqual(
                env["HERMES_HOME"],
                str(harness.HERMES_HOME_ROOT / "nova-e2e"),
            )

    def test_gateway_can_force_manual_approval_with_chat_completions(self):
        harness = load_harness()
        captured: dict[str, object] = {}

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            harness.HERMES_SOURCE_DIR = tmp_path / "hermes-src"
            harness.HERMES_HOME_ROOT = tmp_path / "homes"
            harness.HERMES_LOG_ROOT = tmp_path / "logs"
            harness.HERMES_PROVIDER = "custom"
            harness.HERMES_MODEL = "approval-e2e"
            harness.UV = "uv"
            harness.HERMES_SOURCE_DIR.mkdir()

            original_popen = harness.subprocess.Popen
            original_sleep = harness.time.sleep

            def fake_popen(
                cmd,
                *,
                cwd=None,
                env=None,
                stdout=None,
                stderr=None,
                text=None,
                start_new_session=None,
            ):
                captured["stdout"] = stdout
                return FakeGatewayProcess()

            try:
                harness.subprocess.Popen = fake_popen
                harness.time.sleep = lambda _seconds: None
                harness.start_hermes_gateway(
                    {"PATH": "/usr/bin"},
                    "http://localhost:3339",
                    "bot_test",
                    "Approval E2E",
                    approval_mode="manual",
                    approval_timeout=180,
                    model_api_mode="chat_completions",
                    model_base_url="http://127.0.0.1:18081/v1",
                    require_loopback_model=True,
                    additional_config="""
security:
  tirith_enabled: false
auxiliary:
  title_generation:
    enabled: false
""",
                )
            finally:
                stream = cast(IO[str] | None, captured.get("stdout"))
                if stream is not None:
                    stream.close()
                harness.subprocess.Popen = original_popen
                harness.time.sleep = original_sleep

            config = (harness.HERMES_HOME_ROOT / "approval-e2e" / "config.yaml").read_text()
            self.assertIn("  api_mode: chat_completions\n", config)
            self.assertIn("  base_url: http://127.0.0.1:18081/v1\n", config)
            self.assertIn("approvals:\n  mode: manual\n  timeout: 180\n", config)
            self.assertIn("security:\n  tirith_enabled: false\n", config)
            self.assertIn("title_generation:\n    enabled: false\n", config)

    def test_gateway_rejects_non_loopback_model_when_isolation_is_required(self):
        harness = load_harness()
        with tempfile.TemporaryDirectory() as tmp:
            harness.HERMES_SOURCE_DIR = Path(tmp)
            harness.HERMES_PROVIDER = "custom"
            with self.assertRaisesRegex(ValueError, "must be loopback"):
                harness.start_hermes_gateway(
                    {"PATH": "/usr/bin"},
                    "http://localhost:3339",
                    "bot_test",
                    "Approval E2E",
                    model_base_url="https://api.example.com/v1",
                    require_loopback_model=True,
                )


if __name__ == "__main__":
    unittest.main()
