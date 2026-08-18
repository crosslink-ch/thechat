#!/usr/bin/env python3
"""Collision-safe E2E run allocation and self-binding evidence helpers."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import socket
import stat
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Sequence

OWNER_FILE = ".thechat-e2e-owner.json"
EVIDENCE_SCHEMA_VERSION = 1
_RUN_ID_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$")
_allocated_ports: set[int] = set()
_port_lock = threading.Lock()


def generate_run_id(prefix: str) -> str:
    safe_prefix = re.sub(r"[^a-zA-Z0-9_.-]+", "-", prefix).strip("-.") or "run"
    return f"{safe_prefix}-{os.getpid()}-{time.time_ns()}-{secrets.token_hex(4)}"


def validate_run_id(run_id: str) -> str:
    if not _RUN_ID_PATTERN.fullmatch(run_id):
        raise ValueError(f"Invalid E2E run ID: {run_id!r}")
    return run_id


def allocate_loopback_port() -> int:
    """Allocate a unique default port within this process.

    The socket is intentionally released because Docker/WebDriver must bind it
    later. Call ``refuse_port_collision`` immediately before starting the
    owning resource to close the remaining cross-process collision window.
    """

    with _port_lock:
        for _attempt in range(100):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
                candidate.bind(("127.0.0.1", 0))
                port = int(candidate.getsockname()[1])
            if port not in _allocated_ports:
                _allocated_ports.add(port)
                return port
    raise RuntimeError("Could not allocate a unique loopback E2E port")


def refuse_port_collision(port: int, label: str) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError as exc:
            raise RuntimeError(
                f"Refusing E2E {label} collision on 127.0.0.1:{port}"
            ) from exc


def ownership_record(run_id: str, kind: str) -> dict[str, str]:
    return {
        "owner": "thechat-e2e",
        "runId": validate_run_id(run_id),
        "kind": kind,
    }


def acquire_owned_directory(path: Path, run_id: str, kind: str) -> Path:
    resolved = path.resolve()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    try:
        resolved.mkdir()
    except FileExistsError as exc:
        raise RuntimeError(f"Refusing E2E directory collision: {resolved}") from exc
    marker = resolved / OWNER_FILE
    marker.write_text(
        json.dumps(ownership_record(run_id, kind), sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return resolved


def assert_owned_directory(path: Path, run_id: str, kind: str | None = None) -> None:
    marker = path.resolve() / OWNER_FILE
    try:
        actual = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Missing or invalid E2E ownership marker: {marker}") from exc
    expected = ownership_record(run_id, kind or str(actual.get("kind", "")))
    if actual != expected or (kind is not None and actual.get("kind") != kind):
        raise RuntimeError(
            f"Refusing cleanup for unowned E2E directory {path}: "
            f"expected {expected}, found {actual}"
        )


def remove_owned_directory(path: Path, run_id: str, kind: str | None = None) -> None:
    assert_owned_directory(path, run_id, kind)
    shutil.rmtree(path)


def docker_ownership_labels(run_id: str, kind: str) -> dict[str, str]:
    record = ownership_record(run_id, kind)
    return {
        "com.thechat.e2e.owner": record["owner"],
        "com.thechat.e2e.run-id": record["runId"],
        "com.thechat.e2e.kind": record["kind"],
    }


def ownership_labels_match(
    labels: Mapping[str, str] | None, run_id: str, kind: str
) -> bool:
    if labels is None:
        return False
    return all(
        labels.get(key) == value
        for key, value in docker_ownership_labels(run_id, kind).items()
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git_output(root: Path, args: Sequence[str]) -> bytes:
    return subprocess.check_output(["git", *args], cwd=root)


def capture_source_identity(root: Path) -> dict[str, Any]:
    root = root.resolve()
    commit = _git_output(root, ["rev-parse", "HEAD"]).decode().strip()
    tree = _git_output(root, ["rev-parse", "HEAD^{tree}"]).decode().strip()
    status = _git_output(
        root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]
    )
    listed = _git_output(
        root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]
    )
    paths = sorted(
        {
            Path(raw.decode("utf-8", errors="surrogateescape"))
            for raw in listed.split(b"\0")
            if raw
        },
        key=lambda item: os.fsencode(item.as_posix()),
    )
    manifest = hashlib.sha256()
    for relative in paths:
        absolute = root / relative
        relative_bytes = os.fsencode(relative.as_posix())
        manifest.update(len(relative_bytes).to_bytes(8, "big"))
        manifest.update(relative_bytes)
        if not absolute.exists() and not absolute.is_symlink():
            manifest.update((0).to_bytes(4, "big"))
            manifest.update(b"missing")
            manifest.update((0).to_bytes(8, "big"))
            continue
        metadata = absolute.lstat()
        manifest.update(stat.S_IMODE(metadata.st_mode).to_bytes(4, "big"))
        if absolute.is_symlink():
            payload = os.fsencode(os.readlink(absolute))
            kind = b"symlink"
        elif absolute.is_dir():
            # Git submodules appear as tracked directory entries. The parent
            # index/tree binds their commit; record the entry without walking
            # another repository or its ignored build outputs.
            payload = b""
            kind = b"gitlink"
        else:
            payload = absolute.read_bytes()
            kind = b"file"
        manifest.update(kind)
        manifest.update(len(payload).to_bytes(8, "big"))
        manifest.update(payload)
    return {
        "commit": commit,
        "tree": tree,
        "dirty": bool(status),
        "statusSha256": hashlib.sha256(status).hexdigest(),
        "sourceManifestSha256": manifest.hexdigest(),
        "manifestFileCount": len(paths),
    }


def assert_source_unchanged(root: Path, expected: Mapping[str, Any]) -> dict[str, Any]:
    actual = capture_source_identity(root)
    compared_keys = (
        "commit",
        "tree",
        "dirty",
        "statusSha256",
        "sourceManifestSha256",
        "manifestFileCount",
    )
    mismatches = {
        key: {"expected": expected.get(key), "actual": actual.get(key)}
        for key in compared_keys
        if expected.get(key) != actual.get(key)
    }
    if mismatches:
        raise RuntimeError(f"E2E source drift detected: {mismatches}")
    return actual


def assert_binary_unchanged(path: Path, expected_sha256: str) -> str:
    actual = sha256_file(path)
    if actual != expected_sha256:
        raise RuntimeError(
            f"E2E binary drift detected for {path}: "
            f"expected {expected_sha256}, found {actual}"
        )
    return actual


def validate_evidence_metadata(
    metadata: Mapping[str, Any], *, expected_run_id: str | None = None
) -> None:
    required = {
        "schemaVersion",
        "runId",
        "git",
        "binary",
        "resources",
        "startedAt",
        "endedAt",
        "testCommand",
    }
    missing = sorted(required - metadata.keys())
    if missing:
        raise ValueError(f"Evidence metadata is missing fields: {missing}")
    if metadata["schemaVersion"] != EVIDENCE_SCHEMA_VERSION:
        raise ValueError("Unsupported evidence schema version")
    run_id = validate_run_id(str(metadata["runId"]))
    if expected_run_id is not None and run_id != expected_run_id:
        raise ValueError(
            f"Evidence run ID mismatch: expected {expected_run_id}, found {run_id}"
        )
    git = metadata["git"]
    if not isinstance(git, Mapping):
        raise ValueError("Evidence git identity must be an object")
    for key in (
        "commit",
        "tree",
        "dirty",
        "statusSha256",
        "sourceManifestSha256",
        "manifestFileCount",
    ):
        if key not in git:
            raise ValueError(f"Evidence git identity is missing {key}")
    for key in ("commit", "tree"):
        if not re.fullmatch(r"[0-9a-f]{40,64}", str(git[key])):
            raise ValueError(f"Evidence Git {key} is invalid")
    for key in ("statusSha256", "sourceManifestSha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", str(git[key])):
            raise ValueError(f"Evidence Git {key} is invalid")
    binary = metadata["binary"]
    if (
        not isinstance(binary, Mapping)
        or not binary.get("path")
        or not re.fullmatch(r"[0-9a-f]{64}", str(binary.get("sha256", "")))
    ):
        raise ValueError("Evidence binary identity is incomplete")
    if not isinstance(metadata["resources"], Mapping) or not metadata["resources"]:
        raise ValueError("Evidence resource identities must be a non-empty object")
    command = metadata["testCommand"]
    if (
        not isinstance(command, list)
        or not command
        or not all(isinstance(part, str) and part for part in command)
    ):
        raise ValueError("Evidence test command must be a non-empty string array")
    try:
        started = datetime.fromisoformat(str(metadata["startedAt"]).replace("Z", "+00:00"))
        ended = datetime.fromisoformat(str(metadata["endedAt"]).replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Evidence timestamps must be ISO-8601") from exc
    if started.tzinfo is None or ended.tzinfo is None:
        raise ValueError("Evidence timestamps must include a timezone")
    if ended < started:
        raise ValueError("Evidence end timestamp precedes its start timestamp")


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    source = subparsers.add_parser("source")
    source.add_argument("--root", type=Path, required=True)
    binary = subparsers.add_parser("binary")
    binary.add_argument("--path", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "source":
        value: Any = capture_source_identity(args.root)
    else:
        value = {"path": str(args.path.resolve()), "sha256": sha256_file(args.path)}
    print(json.dumps(value, sort_keys=True))


if __name__ == "__main__":
    main()
