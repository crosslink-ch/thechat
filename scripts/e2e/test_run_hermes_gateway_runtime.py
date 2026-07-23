#!/usr/bin/env python3
"""Regression coverage for the isolated Hermes gateway bootstrap."""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "scripts" / "e2e" / "run-hermes-gateway-runtime.py"
EXPECTED_BASE_URL = "http://127.0.0.1:18081/v1"


def load_runtime():
    spec = importlib.util.spec_from_file_location(
        "hermes_gateway_runtime_test", RUNTIME
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def safe_environment(managed_dir: Path) -> dict[str, str]:
    return {
        "ALL_PROXY": "http://127.0.0.1:9",
        "CUSTOM_BASE_URL": EXPECTED_BASE_URL,
        "HERMES_INFERENCE_MODEL": "approval-e2e",
        "HERMES_INFERENCE_PROVIDER": "custom",
        "HERMES_MANAGED_DIR": str(managed_dir),
        "HERMES_YOLO_MODE": "0",
        "HTTPS_PROXY": "http://127.0.0.1:9",
        "HTTP_PROXY": "http://127.0.0.1:9",
        "OPENAI_API_KEY": "thechat-hermes-approval-e2e-local-only",
        "OPENAI_BASE_URL": EXPECTED_BASE_URL,
        "THECHAT_BASE_URL": "http://127.0.0.1:3339",
        "THECHAT_BOT_TOKEN": "isolated-test-token",
        "TIRITH_ENABLED": "0",
    }


class HermesGatewayRuntimeTests(unittest.TestCase):
    def test_guard_replaces_all_runtime_dotenv_and_secret_reload_entrypoints(self):
        runtime = load_runtime()
        dotenv = types.ModuleType("dotenv")
        env_loader = types.ModuleType("hermes_cli.env_loader")
        hermes_cli = types.ModuleType("hermes_cli")
        setattr(hermes_cli, "env_loader", env_loader)

        def poison(*_args, **_kwargs):
            os.environ["CUSTOM_BASE_URL"] = "https://poison.invalid/v1"
            os.environ["OPENROUTER_API_KEY"] = "poison"
            return True

        setattr(dotenv, "load_dotenv", poison)
        setattr(env_loader, "load_dotenv", poison)
        setattr(env_loader, "load_hermes_dotenv", poison)
        setattr(env_loader, "_apply_managed_env", poison)
        setattr(env_loader, "_apply_external_secret_sources", poison)

        with tempfile.TemporaryDirectory() as tmp:
            managed_dir = Path(tmp) / "managed-scope-must-not-exist"
            with (
                mock.patch.dict(os.environ, safe_environment(managed_dir), clear=True),
                mock.patch.dict(
                    sys.modules,
                    {
                        "dotenv": dotenv,
                        "hermes_cli": hermes_cli,
                        "hermes_cli.env_loader": env_loader,
                    },
                ),
            ):
                protected = runtime._install_runtime_environment_guard(
                    EXPECTED_BASE_URL
                )
                self.assertFalse(getattr(dotenv, "load_dotenv")("ignored.env"))
                self.assertFalse(getattr(env_loader, "load_dotenv")("ignored.env"))
                self.assertEqual(getattr(env_loader, "load_hermes_dotenv")(), [])
                self.assertIsNone(getattr(env_loader, "_apply_managed_env")())
                self.assertIsNone(
                    getattr(env_loader, "_apply_external_secret_sources")(Path(tmp))
                )
                self.assertEqual(os.environ["CUSTOM_BASE_URL"], EXPECTED_BASE_URL)
                self.assertNotIn("OPENROUTER_API_KEY", os.environ)
                self.assertEqual(protected["HERMES_MANAGED_DIR"], str(managed_dir))

    def test_guard_rejects_rehydrated_credentials_before_gateway_import(self):
        runtime = load_runtime()
        with tempfile.TemporaryDirectory() as tmp:
            env = safe_environment(Path(tmp) / "managed-scope-must-not-exist")
            env["OPENROUTER_API_KEY"] = "poison"
            with mock.patch.dict(os.environ, env, clear=True):
                with self.assertRaisesRegex(RuntimeError, "unexpected credential"):
                    runtime._install_runtime_environment_guard(EXPECTED_BASE_URL)

    def test_guard_rejects_non_loopback_expected_provider(self):
        runtime = load_runtime()
        with self.assertRaisesRegex(RuntimeError, "must be loopback"):
            runtime._install_runtime_environment_guard("https://poison.invalid/v1")


if __name__ == "__main__":
    unittest.main()
