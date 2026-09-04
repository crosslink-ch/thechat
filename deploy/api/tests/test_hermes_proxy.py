from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

CHART_DIR = Path(__file__).resolve().parent.parent


def helm_template(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["helm", "template", "thechat-api", str(CHART_DIR), *args],
        check=check,
        capture_output=True,
        text=True,
    )


def source_document(rendered: str, source: str) -> str:
    marker = f"# Source: thechat-api/templates/{source}\n"
    for document in rendered.split("---\n"):
        if marker in document:
            return f"---\n{document}"
    raise AssertionError(f"Rendered source {source!r} not found")


class HermesProxyRenderTests(unittest.TestCase):
    def test_proxy_is_disabled_by_default(self) -> None:
        rendered = helm_template().stdout

        self.assertNotIn("templates/hermes-proxy-deployment.yaml", rendered)
        self.assertNotIn("templates/hermes-proxy-service.yaml", rendered)
        self.assertNotIn("THECHAT_HERMES_PROXY_URL", rendered)

    def test_enabled_proxy_requires_an_exact_upstream_origin(self) -> None:
        result = helm_template("--set", "hermesProxy.enabled=true", check=False)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "hermesProxy.allowedOrigins must contain at least one exact upstream origin",
            result.stderr,
        )

    def test_enabled_proxy_uses_scoped_configuration_and_secret_refs(self) -> None:
        rendered = helm_template(
            "--set",
            "hermesProxy.enabled=true",
            "--set-string",
            "hermesProxy.allowedOrigins[0]=wss://hermes.example.com",
        ).stdout
        api = source_document(rendered, "deployment.yaml")
        proxy = source_document(rendered, "hermes-proxy-deployment.yaml")

        self.assertIn("name: THECHAT_HERMES_PROXY_URL", api)
        self.assertIn("name: THECHAT_HERMES_PROXY_ALLOWED_ORIGINS", api)
        self.assertIn('value: "wss://hermes.example.com"', api)

        self.assertIn("automountServiceAccountToken: false", proxy)
        self.assertIn("name: THECHAT_HERMES_PROXY_ALLOWED_ORIGINS", proxy)
        self.assertIn('value: "wss://hermes.example.com"', proxy)
        self.assertIn("name: BETTER_AUTH_SECRET", proxy)
        self.assertIn("valueFrom:", proxy)
        self.assertNotIn("name: THECHAT_SECRET_KEY", proxy)
        self.assertNotIn("name: DATABASE_URL", proxy)

    def test_literal_proxy_and_encryption_secret_overrides_fail_closed(self) -> None:
        for key in (
            "BETTER_AUTH_SECRET",
            "THECHAT_SECRET_KEY",
            "THECHAT_HERMES_PROXY_ALLOWED_ORIGINS",
            "THECHAT_HERMES_PROXY_ALLOW_LOOPBACK",
            "THECHAT_HERMES_PROXY_HOST",
            "THECHAT_HERMES_PROXY_PORT",
            "THECHAT_HERMES_PROXY_URL",
        ):
            with self.subTest(key=key):
                result = helm_template(
                    "--set-string",
                    f"env.{key}=forbidden-literal",
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"env.{key} is reserved", result.stderr)


if __name__ == "__main__":
    unittest.main()
