#!/usr/bin/env python3
"""Render-level tests for the TheChat outbox worker Deployment."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

CHART = Path(__file__).resolve().parents[1]
PRODUCTION_VALUES = CHART / "values-production.example.yaml"


def render(template: str, *values: str, files: tuple[Path, ...] = ()) -> str:
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
        "image.tag=sha-0123456789abcdef",
        "--set",
        "migrateImage.tag=sha-0123456789abcdef",
    ]
    for path in files:
        command.extend(("-f", str(path)))
    for value in values:
        command.extend(("--set", value))
    return subprocess.run(
        command, check=True, text=True, capture_output=True
    ).stdout


def env_value(rendered: str, name: str) -> str | None:
    lines = rendered.splitlines()
    for index, line in enumerate(lines):
        if line.strip() == f"- name: {name}":
            following = lines[index + 1].strip()
            if following.startswith("value: "):
                return following.removeprefix("value: ").strip('"')
            return following
    return None


def env_count(rendered: str, name: str) -> int:
    return sum(1 for line in rendered.splitlines() if line.strip() == f"- name: {name}")


class WorkerDeploymentTests(unittest.TestCase):
    def test_runs_three_spread_replicas_by_default(self) -> None:
        worker = render("templates/worker-deployment.yaml")
        self.assertIn("replicas: 3", worker)
        self.assertIn("topologySpreadConstraints:", worker)
        self.assertIn("topologyKey: kubernetes.io/hostname", worker)
        self.assertIn("whenUnsatisfiable: ScheduleAnyway", worker)

    def test_single_replica_has_no_spread_constraint(self) -> None:
        worker = render("templates/worker-deployment.yaml", "worker.replicaCount=1")
        self.assertIn("replicas: 1", worker)
        self.assertNotIn("topologySpreadConstraints:", worker)

    def test_shutdown_window_covers_the_outbox_grace_period(self) -> None:
        worker = render("templates/worker-deployment.yaml")
        self.assertIn("terminationGracePeriodSeconds: 45", worker)

    def test_worker_env_is_merged_over_shared_env_for_the_worker_only(self) -> None:
        worker = render(
            "templates/worker-deployment.yaml",
            "env.LOG_LEVEL=info",
            "worker.env.LOG_LEVEL=debug",
        )
        api = render(
            "templates/deployment.yaml",
            "env.LOG_LEVEL=info",
            "worker.env.LOG_LEVEL=debug",
        )
        self.assertEqual(env_value(worker, "LOG_LEVEL"), "debug")
        self.assertEqual(env_count(worker, "LOG_LEVEL"), 1)
        self.assertEqual(env_value(api, "LOG_LEVEL"), "info")

        self.assertEqual(env_value(worker, "DATABASE_POOL_MAX"), "6")
        self.assertEqual(env_value(worker, "DATABASE_IDLE_TIMEOUT_SECONDS"), "60")
        self.assertIsNone(env_value(api, "DATABASE_POOL_MAX"))
        # Shared settings and secret references still reach the worker.
        self.assertEqual(env_value(worker, "ATTACHMENT_VALIDATION_CONCURRENCY"), "1")
        self.assertIn("name: DATABASE_URL", worker)
        self.assertIn("name: REDIS_URL", worker)

    def test_production_overlay_raises_replicas_over_reused_release_values(self) -> None:
        # Production upgrades pass the current release values first; they pin
        # the old replicaCount, so the overlay must set it explicitly.
        with tempfile.NamedTemporaryFile("w", suffix=".yaml") as current:
            current.write("worker:\n  replicaCount: 1\n")
            current.flush()
            worker = render(
                "templates/worker-deployment.yaml",
                "env.ATTACHMENT_S3_BUCKET=thechat-test-attachments",
                "attachments.infisical.identityId=00000000-0000-0000-0000-000000000000",
                "attachments.infisical.projectSlug=thechat",
                files=(Path(current.name), PRODUCTION_VALUES),
            )
        self.assertIn("replicas: 3", worker)


if __name__ == "__main__":
    unittest.main()
