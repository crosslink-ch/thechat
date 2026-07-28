#!/usr/bin/env python3
"""Unit coverage for the native attachment E2E supervisor."""

from __future__ import annotations

import importlib.util
import json
import runpy
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
ATTACHMENT_FLOW = ROOT / "scripts" / "e2e" / "attachments-ui-flow.py"
APPROVAL_FLOW = ROOT / "scripts" / "e2e" / "hermes-approval-ui-flow.py"


def load_flow(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AttachmentUiFlowTests(unittest.TestCase):
    def setUp(self):
        self.flow = load_flow("attachment_ui_flow_test", ATTACHMENT_FLOW)

    def test_normal_entrypoints_require_verified_durable_evidence(self):
        resolved = self.flow._resolve_evidence_dir(
            {"ATTACHMENT_E2E_REQUIRE_EVIDENCE": "1"},
            run_id="unit-run",
            home=Path("/home/tester"),
        )
        self.assertEqual(
            resolved,
            Path("/home/tester/.cache/thechat/e2e/attachments/unit-run/tempo"),
        )
        self.assertNotIn(".tmp", resolved.parts)

        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertIn(
            "ATTACHMENT_E2E_REQUIRE_EVIDENCE=1",
            package["scripts"]["test:e2e:attachments-ui"],
        )
        runner = runpy.run_path(str(ROOT / "scripts" / "test.py"))
        suite = next(
            item for item in runner["SUITES"] if item["name"] == "attachments-ui"
        )
        self.assertEqual(
            suite["env"], {"ATTACHMENT_E2E_REQUIRE_EVIDENCE": "1"}
        )

    def test_evidence_gate_fails_closed_when_disabled_or_destination_is_empty(self):
        with self.assertRaisesRegex(RuntimeError, "cannot be disabled"):
            self.flow._resolve_evidence_dir(
                {"ATTACHMENT_E2E_REQUIRE_EVIDENCE": "0"},
                run_id="unit-run",
            )
        with self.assertRaisesRegex(RuntimeError, "must not be empty"):
            self.flow._resolve_evidence_dir(
                {
                    "ATTACHMENT_E2E_REQUIRE_EVIDENCE": "1",
                    "ATTACHMENT_E2E_EVIDENCE_DIR": "   ",
                },
                run_id="unit-run",
            )
        with mock.patch.object(self.flow, "TRACE_EVIDENCE_DIR", None):
            with self.assertRaisesRegex(RuntimeError, "destination is required"):
                self.flow._export_tempo_evidence({}, {})

    def test_throttle_gate_targets_only_large_object_puts(self):
        minimum = self.flow.SLOW_UPLOAD_MIN_BYTES
        self.assertFalse(self.flow._should_throttle_upload("PUT", minimum - 1))
        self.assertTrue(self.flow._should_throttle_upload("PUT", minimum))
        self.assertFalse(self.flow._should_throttle_upload("GET", minimum * 2))

    def test_docker_environment_forces_default_context_without_remote_settings(self):
        env = self.flow._local_docker_env(
            {
                "PATH": "/usr/bin",
                "DOCKER_HOST": "tcp://remote.invalid:2376",
                "DOCKER_CONTEXT": "remote",
                "DOCKER_TLS_VERIFY": "1",
                "DOCKER_CERT_PATH": "/secrets",
                "DOCKER_CONFIG": "/remote-config",
            }
        )

        self.assertEqual(env["DOCKER_CONTEXT"], "default")
        self.assertEqual(env["PATH"], "/usr/bin")
        for key in (
            "DOCKER_HOST",
            "DOCKER_TLS_VERIFY",
            "DOCKER_CERT_PATH",
            "DOCKER_CONFIG",
        ):
            self.assertNotIn(key, env)

    def test_docker_endpoint_must_be_a_local_unix_socket(self):
        with mock.patch.object(
            self.flow.subprocess,
            "run",
            return_value=subprocess.CompletedProcess(
                ["docker"], 0, "tcp://remote.invalid:2376\n", ""
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "local Docker Unix socket"):
                self.flow._require_local_docker()

        with mock.patch.object(
            self.flow.subprocess,
            "run",
            return_value=subprocess.CompletedProcess(
                ["docker"], 0, "unix:///var/run/docker.sock\n", ""
            ),
        ):
            self.assertEqual(
                self.flow._require_local_docker(), "unix:///var/run/docker.sock"
            )

    def test_stale_cleanup_is_scoped_to_the_attachment_suite_label(self):
        completed = subprocess.CompletedProcess(["docker"], 0, "abc123\ndef456\n", "")
        with (
            mock.patch.object(self.flow.subprocess, "run", return_value=completed) as run,
            mock.patch.object(self.flow.harness, "run") as docker_run,
        ):
            self.flow._reap_stale_containers()

        self.assertIn(
            f"label={self.flow.CONTAINER_LABEL}", run.call_args.args[0]
        )
        docker_run.assert_called_once_with(
            ["docker", "rm", "-f", "abc123", "def456"],
            env=self.flow.DOCKER_ENV,
        )

    def test_native_attachment_and_approval_flows_share_one_lock(self):
        approval = load_flow("approval_ui_flow_for_lock_test", APPROVAL_FLOW)
        self.assertEqual(
            self.flow.NATIVE_DESKTOP_E2E_LOCK,
            approval.NATIVE_DESKTOP_E2E_LOCK,
        )
        with tempfile.TemporaryDirectory() as temporary:
            shared_tmp = Path(temporary)
            self.flow.TMP = shared_tmp
            approval.TMP = shared_tmp
            with self.flow._exclusive_run_lock():
                with self.assertRaisesRegex(RuntimeError, "Another Hermes approval"):
                    with approval._exclusive_run_lock():
                        self.fail("approval flow unexpectedly acquired native E2E lock")

    def test_source_identity_rejects_build_run_races(self):
        before = {
            "sourceCommit": "a" * 40,
            "sourceTree": "b" * 40,
            "sourceDiffSha256": "c" * 64,
            "sourceStatusLineCount": 0,
        }
        self.flow._assert_source_identity_unchanged(before, dict(before))
        after = {**before, "sourceTree": "d" * 40}
        with self.assertRaisesRegex(RuntimeError, "sourceTree"):
            self.flow._assert_source_identity_unchanged(before, after)

    def test_cancellation_artifact_is_truthful_and_excludes_raw_entity_ids(self):
        source = ATTACHMENT_FLOW.read_text(encoding="utf-8")
        self.assertNotIn('"messageId": matching', source)
        self.assertNotIn('"attachmentId": matching', source)
        self.assertIn('"lateCapabilityBoundary"', source)
        self.assertIn('"revocationClaimed": False', source)
        self.assertIn('"issuedCapabilityExpiresBy": "signed_upload_ttl"', source)

    def test_command_logging_redacts_tokens_headers_assignments_and_urls(self):
        canary = "thechat-secret-canary"
        rendered = self.flow.harness.format_command(
            [
                "tool",
                "--token",
                canary,
                f"OPENROUTER_API_KEY={canary}",
                f"DATABASE_URL=postgres://user:{canary}@db.invalid/thechat",
                "-H",
                f"Authorization: Bearer {canary}",
                f"-HAuthorization: Bearer {canary}",
                f"https://api.invalid/resource?token={canary}",
                f"--password={canary} with spaces",
                "--header=Cookie: session=" + canary,
                "Authorization: Basic " + canary,
                f"SERVICE_SECRET={canary} with whitespace",
                (
                    "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n"
                    f"{canary}\n-----END PRIVATE KEY-----"
                ),
                "--user",
                f"user:{canary}",
                f"--user=user:{canary}",
            ]
        )

        self.assertNotIn(canary, rendered)
        self.assertNotIn("BEGIN PRIVATE KEY", rendered)
        self.assertGreaterEqual(rendered.count("REDACTED"), 8)


if __name__ == "__main__":
    unittest.main()
