#!/usr/bin/env python3
"""Deterministic tests for collision-safe E2E allocation and evidence binding."""

from __future__ import annotations

import importlib.util
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts" / "e2e" / "e2e_run.py"


def load_helper() -> Any:
    spec = importlib.util.spec_from_file_location("thechat_e2e_run", HELPER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class E2ERunTests(unittest.TestCase):
    def test_default_allocations_are_unique_and_ports_are_bindable(self):
        helper = load_helper()
        first_id = helper.generate_run_id("test")
        second_id = helper.generate_run_id("test")
        first_port = helper.allocate_loopback_port()
        second_port = helper.allocate_loopback_port()
        self.assertNotEqual(first_id, second_id)
        self.assertNotEqual(first_port, second_port)
        helper.refuse_port_collision(first_port, "first")
        helper.refuse_port_collision(second_port, "second")

    def test_bound_port_collision_is_refused(self):
        helper = load_helper()
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as owner:
            owner.bind(("127.0.0.1", 0))
            owner.listen()
            port = owner.getsockname()[1]
            with self.assertRaisesRegex(RuntimeError, "collision"):
                helper.refuse_port_collision(port, "owned")

    def test_directory_collision_is_refused_and_cleanup_is_ownership_scoped(self):
        helper = load_helper()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            owned = helper.acquire_owned_directory(root / "run", "run-1", "evidence")
            (owned / "witness.txt").write_text("keep until owned cleanup")
            with self.assertRaisesRegex(RuntimeError, "collision"):
                helper.acquire_owned_directory(owned, "run-2", "evidence")
            with self.assertRaisesRegex(RuntimeError, "unowned"):
                helper.remove_owned_directory(owned, "run-2", "evidence")
            self.assertTrue(owned.exists())
            helper.remove_owned_directory(owned, "run-1", "evidence")
            self.assertFalse(owned.exists())

    def test_container_ownership_requires_exact_run_and_kind(self):
        helper = load_helper()
        labels = helper.docker_ownership_labels("run-1", "postgres")
        self.assertTrue(helper.ownership_labels_match(labels, "run-1", "postgres"))
        self.assertFalse(helper.ownership_labels_match(labels, "run-2", "postgres"))
        self.assertFalse(helper.ownership_labels_match(labels, "run-1", "redis"))

    def test_source_and_binary_drift_are_refused(self):
        helper = load_helper()
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary) / "repo"
            repo.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(
                ["git", "config", "user.email", "e2e@example.com"], cwd=repo, check=True
            )
            subprocess.run(
                ["git", "config", "user.name", "E2E"], cwd=repo, check=True
            )
            source = repo / "source.txt"
            source.write_text("before")
            subprocess.run(["git", "add", "source.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], cwd=repo, check=True)

            identity = helper.capture_source_identity(repo)
            helper.assert_source_unchanged(repo, identity)
            source.write_text("after")
            with self.assertRaisesRegex(RuntimeError, "source drift"):
                helper.assert_source_unchanged(repo, identity)

            binary = repo / "binary"
            binary.write_bytes(b"first")
            digest = helper.sha256_file(binary)
            helper.assert_binary_unchanged(binary, digest)
            binary.write_bytes(b"second")
            with self.assertRaisesRegex(RuntimeError, "binary drift"):
                helper.assert_binary_unchanged(binary, digest)

    def test_metadata_validation_rejects_missing_and_mismatched_identity(self):
        helper = load_helper()
        metadata = {
            "schemaVersion": 1,
            "runId": "run-1",
            "git": {
                "commit": "a" * 40,
                "tree": "b" * 40,
                "dirty": True,
                "statusSha256": "c" * 64,
                "sourceManifestSha256": "d" * 64,
                "manifestFileCount": 3,
            },
            "binary": {"path": "/owned/binary", "sha256": "e" * 64},
            "resources": {"apiPort": 12345},
            "startedAt": "2026-07-27T10:00:00+00:00",
            "endedAt": "2026-07-27T10:00:01+00:00",
            "testCommand": ["pnpm", "test"],
        }
        helper.validate_evidence_metadata(metadata, expected_run_id="run-1")
        with self.assertRaisesRegex(ValueError, "run ID mismatch"):
            helper.validate_evidence_metadata(metadata, expected_run_id="run-2")
        incomplete = dict(metadata)
        incomplete.pop("binary")
        with self.assertRaisesRegex(ValueError, "missing fields"):
            helper.validate_evidence_metadata(incomplete)


if __name__ == "__main__":
    unittest.main()
