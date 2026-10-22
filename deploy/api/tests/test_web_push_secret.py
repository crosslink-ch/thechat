#!/usr/bin/env python3
"""Render-level tests for Web Push (VAPID) secret wiring."""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

CHART = Path(__file__).resolve().parents[1]
KEYS = ("WEB_PUSH_VAPID_PUBLIC_KEY", "WEB_PUSH_VAPID_PRIVATE_KEY", "WEB_PUSH_SUBJECT")


def render(*values: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    command = [
        "helm",
        "template",
        "thechat-api",
        str(CHART),
        "--namespace",
        "thechat",
        "--set",
        "image.tag=sha-0123456789ab",
        "--set",
        "migrateImage.tag=sha-0123456789ab",
    ]
    for value in values:
        command.extend(("--set", value))
    return subprocess.run(command, check=check, text=True, capture_output=True)


def deployment_document(rendered: str, name: str) -> str:
    marker = f"kind: Deployment\nmetadata:\n  name: {name}\n"
    for document in rendered.split("---\n"):
        if marker in document:
            return document
    raise AssertionError(f"Deployment {name!r} not found in rendered chart")


class WebPushSecretRenderTests(unittest.TestCase):
    def test_web_push_is_off_by_default(self) -> None:
        rendered = render().stdout
        for key in KEYS:
            self.assertNotIn(key, rendered)

    def test_api_and_worker_read_vapid_keys_from_the_secret(self) -> None:
        rendered = render("webPushSecret=thechat-web-push").stdout
        for name in ("thechat-api", "thechat-api-worker"):
            document = deployment_document(rendered, name)
            for key in KEYS:
                self.assertIn(
                    f"- name: {key}\n"
                    "              valueFrom:\n"
                    "                secretKeyRef:\n"
                    "                  name: thechat-web-push\n"
                    f"                  key: {key}\n",
                    document,
                    f"{name} {key}",
                )

    def test_vapid_values_cannot_be_rendered_literally(self) -> None:
        for key in KEYS:
            result = render(f"env.{key}=literal", check=False)
            self.assertNotEqual(result.returncode, 0, key)
            self.assertIn("is reserved", result.stderr, key)


if __name__ == "__main__":
    unittest.main()
