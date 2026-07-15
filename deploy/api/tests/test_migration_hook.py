#!/usr/bin/env python3
"""Render-level tests for the TheChat API Helm chart."""

from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

CHART = Path(__file__).resolve().parents[1]


def render(
    template: str,
    *values: str,
    json_values: tuple[str, ...] = (),
    set_migrate_tag: bool = True,
) -> str:
    command = [
        "helm",
        "template",
        "thechat-api",
        str(CHART),
        "--namespace",
        "thechat",
        "--show-only",
        template,
        "--set",
        "image.tag=sha-test",
    ]
    if set_migrate_tag:
        command.extend(("--set", "migrateImage.tag=sha-test"))
    for value in values:
        command.extend(("--set", value))
    for value in json_values:
        command.extend(("--set-json", value))

    return subprocess.run(
        command,
        check=True,
        text=True,
        capture_output=True,
    ).stdout


class MigrationHookRenderTests(unittest.TestCase):
    def test_migration_is_a_blocking_helm_hook(self) -> None:
        job = render("templates/migration-job.yaml")

        self.assertIn("kind: Job", job)
        self.assertRegex(
            job,
            re.compile(r'["\']?helm\.sh/hook["\']?: pre-install,pre-upgrade'),
        )
        self.assertRegex(
            job,
            re.compile(
                r'["\']?helm\.sh/hook-delete-policy["\']?: '
                r'before-hook-creation,hook-succeeded'
            ),
        )
        self.assertNotIn("hook-failed", job)
        self.assertIn("activeDeadlineSeconds: 300", job)
        self.assertIn("backoffLimit: 1", job)
        self.assertIn("restartPolicy: Never", job)
        self.assertIn("automountServiceAccountToken: false", job)
        self.assertIn("app.kubernetes.io/name: thechat-api-migrate", job)
        self.assertNotIn("app.kubernetes.io/name: thechat-api\n", job)
        self.assertIn(
            "image: \"ghcr.io/crosslink-ch/thechat-api-migrate:sha-test\"",
            job,
        )
        self.assertIn("name: thechat-db", job)
        self.assertIn("key: DATABASE_URL", job)

    def test_migration_job_settings_are_configurable(self) -> None:
        job = render(
            "templates/migration-job.yaml",
            "migrationJob.activeDeadlineSeconds=123",
            "migrationJob.backoffLimit=4",
        )

        self.assertIn("activeDeadlineSeconds: 123", job)
        self.assertIn("backoffLimit: 4", job)

    def test_migration_job_defaults_support_reused_release_values(self) -> None:
        job = render(
            "templates/migration-job.yaml",
            json_values=("migrationJob=null",),
        )

        self.assertIn("activeDeadlineSeconds: 300", job)
        self.assertIn("backoffLimit: 1", job)
        self.assertIn("cpu: 25m", job)
        self.assertIn("memory: 64Mi", job)

    def test_application_and_migration_image_tags_must_match(self) -> None:
        with self.assertRaises(subprocess.CalledProcessError) as error:
            render(
                "templates/migration-job.yaml",
                "migrateImage.tag=sha-other",
            )

        self.assertIn(
            "image.tag and migrateImage.tag must match",
            error.exception.stderr,
        )

    def test_long_names_keep_the_migration_suffix(self) -> None:
        long_name = "a" * 63
        expected_migration_name = f'{"a" * 55}-migrate'
        job = render(
            "templates/migration-job.yaml",
            f"nameOverride={long_name}",
            f"fullnameOverride={long_name}",
        )

        self.assertIn(f"name: {expected_migration_name}", job)
        self.assertIn(
            f"app.kubernetes.io/name: {expected_migration_name}",
            job,
        )

    def test_reused_release_values_receive_safe_better_auth_defaults(self) -> None:
        deployment = render(
            "templates/deployment.yaml",
            json_values=(
                "betterAuthSecret=null",
                'env={"THECHAT_BACKEND_URL":"https://api.example",'
                '"BETTER_AUTH_URL":null,"NODE_ENV":null}',
            ),
        )

        self.assertIn("name: thechat-better-auth", deployment)
        self.assertRegex(
            deployment,
            re.compile(r'name: NODE_ENV\s+value: "production"'),
        )
        self.assertRegex(
            deployment,
            re.compile(
                r'name: BETTER_AUTH_URL\s+value: "https://api.example"'
            ),
        )

    def test_reused_release_values_receive_migration_image_defaults(self) -> None:
        job = render(
            "templates/migration-job.yaml",
            json_values=("migrateImage=null",),
            set_migrate_tag=False,
        )

        self.assertIn(
            'image: "ghcr.io/crosslink-ch/thechat-api-migrate:sha-test"',
            job,
        )
        self.assertIn("imagePullPolicy: IfNotPresent", job)

    def test_api_no_longer_runs_migrations_in_an_init_container(self) -> None:
        deployment = render("templates/deployment.yaml")

        self.assertNotIn("initContainers:", deployment)
        self.assertNotIn("thechat-api-migrate", deployment)

    def test_api_receives_explicit_better_auth_configuration(self) -> None:
        deployment = render("templates/deployment.yaml")

        self.assertIn("name: BETTER_AUTH_SECRET", deployment)
        self.assertIn("name: thechat-better-auth", deployment)
        self.assertIn("key: BETTER_AUTH_SECRET", deployment)
        self.assertIn("name: BETTER_AUTH_URL", deployment)
        self.assertIn('value: "https://api.thechat.app"', deployment)
        self.assertNotIn("name: JWT_SECRET", deployment)
        self.assertNotIn("name: ENABLE_LEGACY_AUTH_BRIDGE", deployment)
        self.assertIn("name: AUTH_TRUST_PROXY", deployment)
        self.assertIn("name: AUTH_TRUSTED_IP_HEADER", deployment)

    def test_better_auth_secret_is_required_when_explicitly_empty(self) -> None:
        with self.assertRaises(subprocess.CalledProcessError) as error:
            render("templates/deployment.yaml", "betterAuthSecret=")

        self.assertIn("betterAuthSecret is required", error.exception.stderr)


if __name__ == "__main__":
    unittest.main()
