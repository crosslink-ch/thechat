#!/usr/bin/env python3
"""Regression tests for side-by-side development and production Tauri flavors."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parent.parent
TAURI_DIR = ROOT / "packages" / "desktop" / "src-tauri"


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def merge_config(base: dict, overlay: dict) -> dict:
    """Model Tauri's object merge and array replacement for these config files."""
    merged = copy.deepcopy(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = merge_config(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


class TauriFlavorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.base = load_json(TAURI_DIR / "tauri.conf.json")
        cls.dev_overlay = load_json(TAURI_DIR / "tauri.dev.conf.json")
        cls.dev = merge_config(
            cls.base,
            cls.dev_overlay,
        )
        cls.macos = merge_config(
            cls.base,
            load_json(TAURI_DIR / "tauri.macos.conf.json"),
        )
        cls.macos_dev = merge_config(cls.macos, cls.dev_overlay)
        cls.release = merge_config(
            cls.base,
            load_json(TAURI_DIR / "tauri.release.conf.json"),
        )
        cls.scripts = load_json(ROOT / "package.json")["scripts"]
        cls.desktop_scripts = load_json(
            ROOT / "packages" / "desktop" / "package.json"
        )["scripts"]
        cls.e2e_config = (
            ROOT / "packages" / "desktop" / "e2e" / "wdio.conf.js"
        ).read_text(encoding="utf-8")
        cls.release_workflow = (
            ROOT / ".github" / "workflows" / "release.yml"
        ).read_text(encoding="utf-8")

    @staticmethod
    def wrapper_args(*args: str) -> list[str]:
        env = os.environ.copy()
        env["THECHAT_TAURI_WRAPPER_PRINT_ARGS"] = "1"
        result = subprocess.run(
            ["node", "scripts/tauri-cli.mjs", *args],
            cwd=ROOT / "packages" / "desktop",
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)

    def test_development_identity_is_isolated(self) -> None:
        self.assertEqual(self.base["identifier"], "com.bruno.thechat")
        self.assertEqual(self.dev["identifier"], "com.bruno.thechat.dev")
        self.assertNotEqual(self.dev["identifier"], self.base["identifier"])
        self.assertEqual(self.dev["productName"], "TheChat Dev")
        self.assertFalse(self.dev["bundle"]["createUpdaterArtifacts"])

    def test_development_overlay_preserves_window_behavior(self) -> None:
        self.assertNotIn("app", self.dev_overlay)
        self.assertEqual(self.dev["app"]["windows"], self.base["app"]["windows"])
        self.assertEqual(
            self.macos_dev["app"]["windows"],
            self.macos["app"]["windows"],
        )

    def test_release_overlay_preserves_production_identity(self) -> None:
        self.assertEqual(self.release["identifier"], "com.bruno.thechat")
        self.assertEqual(self.release["productName"], "thechat")
        self.assertEqual(self.release["app"]["windows"][0]["title"], "TheChat")
        self.assertTrue(self.release["bundle"]["createUpdaterArtifacts"])

    def test_release_action_pins_the_production_backend(self) -> None:
        release_action = self.release_workflow.split(
            "- uses: tauri-apps/tauri-action@v0", 1
        )[1]
        self.assertIn(
            "THECHAT_BACKEND_URL: https://thechat.testkopie.dev",
            release_action,
        )

    def test_canonical_development_commands_apply_the_overlay(self) -> None:
        expected = "--config src-tauri/tauri.dev.conf.json"
        self.assertIn(expected, self.scripts["tauri:dev"])
        self.assertIn(expected, self.scripts["tauri:build:dev"])
        self.assertIn(expected, self.e2e_config)
        self.assertNotIn("tauri.dev.conf.json", self.scripts["tauri:build"])
        self.assertEqual(
            self.desktop_scripts["tauri"],
            "node scripts/tauri-cli.mjs",
        )

    def test_direct_tauri_dev_is_rewritten_to_the_dev_flavor(self) -> None:
        dev_config = "src-tauri/tauri.dev.conf.json"
        self.assertEqual(
            self.wrapper_args("dev", "--features", "otel"),
            ["dev", "--features", "otel", "--config", dev_config],
        )
        self.assertEqual(
            self.wrapper_args("dev", "--config", dev_config),
            ["dev", "--config", dev_config],
        )
        self.assertEqual(
            self.wrapper_args("dev", f"-c={dev_config}"),
            ["dev", "--config", dev_config],
        )
        self.assertEqual(
            self.wrapper_args(
                "dev",
                "--config",
                "src-tauri/tauri.conf.json",
            ),
            [
                "dev",
                "--config",
                "src-tauri/tauri.conf.json",
                "--config",
                dev_config,
            ],
        )
        self.assertEqual(
            self.wrapper_args("-vv", "dev"),
            ["-vv", "dev", "--config", dev_config],
        )
        self.assertEqual(
            self.wrapper_args(
                "dev",
                "--",
                "--config",
                "src-tauri/tauri.conf.json",
            ),
            [
                "dev",
                "--config",
                dev_config,
                "--",
                "--config",
                "src-tauri/tauri.conf.json",
            ],
        )
        self.assertEqual(
            self.wrapper_args(
                "build",
                "--config",
                "src-tauri/tauri.release.conf.json",
                "--target",
                "x86_64-pc-windows-msvc",
            ),
            [
                "build",
                "--config",
                "src-tauri/tauri.release.conf.json",
                "--target",
                "x86_64-pc-windows-msvc",
            ],
        )
        self.assertEqual(self.wrapper_args("android", "dev"), ["android", "dev"])


if __name__ == "__main__":
    unittest.main()
