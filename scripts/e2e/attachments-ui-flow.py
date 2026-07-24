#!/usr/bin/env python3
"""Real Tauri attachment lifecycle E2E using only local disposable services."""

from __future__ import annotations

import fcntl
import importlib.util
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[2]
TMP = ROOT / ".tmp"
RUN_ID = f"{os.getpid()}-{time.time_ns()}"

os.environ.setdefault("THECHAT_E2E_API_PORT", "3340")
os.environ.setdefault("THECHAT_E2E_POSTGRES_PORT", "15546")
os.environ.setdefault("THECHAT_E2E_REDIS_PORT", "16383")
os.environ.setdefault("ATTACHMENT_E2E_S3_PORT", "19000")
os.environ.setdefault("ATTACHMENT_E2E_CLAMAV_PORT", "13310")
os.environ.setdefault(
    "THECHAT_E2E_DATABASE_URL",
    "postgres://thechat:thechat@localhost:"
    f"{os.environ['THECHAT_E2E_POSTGRES_PORT']}/thechat",
)
os.environ.setdefault(
    "THECHAT_E2E_REDIS_URL",
    f"redis://localhost:{os.environ['THECHAT_E2E_REDIS_PORT']}",
)
os.environ["THECHAT_E2E_PG_CONTAINER"] = f"thechat-attachment-e2e-postgres-{RUN_ID}"
os.environ["THECHAT_E2E_REDIS_CONTAINER"] = f"thechat-attachment-e2e-redis-{RUN_ID}"

API_PORT = int(os.environ["THECHAT_E2E_API_PORT"])
S3_PORT = int(os.environ["ATTACHMENT_E2E_S3_PORT"])
CLAMAV_PORT = int(os.environ["ATTACHMENT_E2E_CLAMAV_PORT"])
S3_CONTAINER = f"thechat-attachment-e2e-s3-{RUN_ID}"
CLAMAV_CONTAINER = f"thechat-attachment-e2e-clamav-{RUN_ID}"
S3_IMAGE = os.environ.get(
    "ATTACHMENT_E2E_S3_IMAGE",
    "localstack/localstack:4.4.0",
)
CLAMAV_IMAGE = os.environ.get("ATTACHMENT_E2E_CLAMAV_IMAGE", "clamav/clamav:1.4")
BUCKET = f"thechat-attachment-e2e-{RUN_ID}".replace("_", "-").lower()
KEEP = os.environ.get("ATTACHMENT_E2E_KEEP") == "1"
FIXTURE_DIR = TMP / "attachment-ui-e2e-fixtures" / RUN_ID
SCREENSHOT = TMP / f"attachment-ui-e2e-{RUN_ID}.png"
FAILURE_SCREENSHOT = TMP / f"attachment-ui-e2e-failure-{RUN_ID}.png"

_SAFE_ENV_KEYS = {
    "CARGO_HOME",
    "CI",
    "HOME",
    "LANG",
    "LC_ALL",
    "LD_LIBRARY_PATH",
    "LOGNAME",
    "PATH",
    "RUSTUP_HOME",
    "SHELL",
    "TERM",
    "TMPDIR",
    "USER",
    "UV_CACHE_DIR",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
}


def _load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load E2E helper: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


harness = _load_module(
    "thechat_attachment_e2e_harness", ROOT / "scripts/e2e/hermes-bot-flow.py"
)


@contextmanager
def _exclusive_run_lock():
    TMP.mkdir(parents=True, exist_ok=True)
    lock_path = TMP / "attachment-ui-e2e.lock"
    lock_file = lock_path.open("a+", encoding="utf-8")
    try:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError(
                f"Another attachment UI E2E run owns {lock_path}"
            ) from exc
        lock_file.seek(0)
        lock_file.truncate()
        lock_file.write(f"{RUN_ID}\n")
        lock_file.flush()
        yield
    finally:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        finally:
            lock_file.close()


@contextmanager
def _interruptible_cleanup():
    previous_handlers = {
        sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)
    }
    interrupted = False

    def handle_signal(signum, _frame):
        nonlocal interrupted
        if interrupted:
            return
        interrupted = True
        raise KeyboardInterrupt(f"Received signal {signum}; cleaning up E2E resources")

    for sig in previous_handlers:
        signal.signal(sig, handle_signal)
    try:
        yield
    finally:
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)


def _safe_child_env() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key in _SAFE_ENV_KEYS}
    env["PATH"] = f"{Path(harness.BUN).parent}:{env.get('PATH', '')}"
    env.update(
        {
            "DATABASE_URL": harness.DATABASE_URL,
            "REDIS_URL": harness.REDIS_URL,
            "REALTIME_DRIVER": "redis",
            "REDIS_KEY_PREFIX": f"thechat-attachment-e2e-{RUN_ID}",
            "JWT_SECRET": "thechat-attachment-e2e-jwt-secret",
            "THECHAT_SECRET_KEY": "thechat-attachment-e2e-local-secret-key",
            "THECHAT_BACKEND_PORT": str(API_PORT),
            "LOG_LEVEL": "error",
            "AWS_ACCESS_KEY_ID": "test",
            "AWS_SECRET_ACCESS_KEY": "test",
            "AWS_REGION": "us-east-1",
            "AWS_EC2_METADATA_DISABLED": "true",
            "ATTACHMENT_S3_BUCKET": BUCKET,
            "ATTACHMENT_S3_REGION": "us-east-1",
            "ATTACHMENT_S3_ENDPOINT": f"http://127.0.0.1:{S3_PORT}",
            "ATTACHMENT_S3_FORCE_PATH_STYLE": "true",
            "CLAMAV_HOST": "127.0.0.1",
            "CLAMAV_PORT": str(CLAMAV_PORT),
            "CLAMAV_TIMEOUT_MS": "120000",
            "NO_PROXY": "127.0.0.1,localhost,::1",
            "no_proxy": "127.0.0.1,localhost,::1",
        }
    )
    return env


def _container_running(name: str) -> bool:
    result = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", name],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0 and result.stdout.strip() == "true"


def _wait_for(predicate: Callable[[], Any], *, timeout: float, label: str):
    return harness.wait_for(predicate, timeout=timeout, label=label)


def _start_s3(env: dict[str, str]) -> None:
    harness.run(["docker", "rm", "-f", S3_CONTAINER], check=False)
    harness.run(
        [
            "docker",
            "run",
            "-d",
            "--name",
            S3_CONTAINER,
            "-e",
            "SERVICES=s3",
            "-e",
            "PERSISTENCE=0",
            "-e",
            "LS_LOG=warn",
            "-p",
            f"127.0.0.1:{S3_PORT}:4566",
            S3_IMAGE,
        ]
    )

    def ready() -> bool:
        if not _container_running(S3_CONTAINER):
            raise RuntimeError("LocalStack S3 exited before becoming ready")
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{S3_PORT}/_localstack/health", timeout=2
            ) as response:
                health = json.loads(response.read())
                return health.get("services", {}).get("s3") in {
                    "available",
                    "running",
                }
        except (OSError, ValueError):
            return False

    _wait_for(ready, timeout=120, label="LocalStack S3 readiness")
    provision = """
import {
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const client = new S3Client({
  region: process.env.AWS_REGION,
  endpoint: process.env.ATTACHMENT_S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const Bucket = process.env.ATTACHMENT_S3_BUCKET;
await client.send(new CreateBucketCommand({ Bucket }));
await client.send(new PutBucketVersioningCommand({
  Bucket,
  VersioningConfiguration: { Status: "Enabled" },
}));
await client.send(new PutBucketCorsCommand({
  Bucket,
  CORSConfiguration: {
    CORSRules: [{
      AllowedOrigins: ["*"],
      AllowedMethods: ["GET", "PUT", "HEAD"],
      AllowedHeaders: ["*"],
      ExposeHeaders: [
        "ETag",
        "x-amz-version-id",
        "x-amz-checksum-sha256",
      ],
    }],
  },
}));
"""
    harness.run(
        [harness.BUN, "-e", provision],
        env=env,
        cwd=ROOT / "packages/api",
    )


def _start_clamav() -> None:
    harness.run(["docker", "rm", "-f", CLAMAV_CONTAINER], check=False)
    harness.run(
        [
            "docker",
            "run",
            "-d",
            "--name",
            CLAMAV_CONTAINER,
            "-p",
            f"127.0.0.1:{CLAMAV_PORT}:3310",
            CLAMAV_IMAGE,
        ]
    )

    def ready() -> bool:
        if not _container_running(CLAMAV_CONTAINER):
            raise RuntimeError("ClamAV exited before becoming ready")
        try:
            with socket.create_connection(("127.0.0.1", CLAMAV_PORT), timeout=2) as sock:
                sock.sendall(b"zPING\0")
                return b"PONG" in sock.recv(64)
        except OSError:
            return False

    _wait_for(ready, timeout=300, label="ClamAV readiness")


def _write_fixtures() -> dict[str, Path]:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    valid = FIXTURE_DIR / f"valid-{RUN_ID}.txt"
    rejected = FIXTURE_DIR / f"rejected-{RUN_ID}.txt"
    cancel = FIXTURE_DIR / f"cancel-{RUN_ID}.txt"
    valid.write_bytes(f"TheChat attachment E2E payload {RUN_ID}\n".encode())
    rejected.write_text(
        "X5O!P%@AP[4\\PZX54(P^)7CC)7}$"
        "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
        encoding="ascii",
    )
    cancel.write_bytes(f"TheChat attachment cancellation {RUN_ID}\n".encode())
    return {"valid": valid, "rejected": rejected, "cancel": cancel}


def _register_fixture_workspace(base: str) -> dict[str, str]:
    stamp = time.time_ns()
    email = f"attachment-e2e-{stamp}@example.com"
    password = "attachment-e2e-password"
    status, registered = harness.http_json(
        "POST",
        f"{base}/auth/register",
        {"name": "Attachment E2E", "email": email, "password": password},
    )
    assert status == 200, (status, registered)
    token = registered["accessToken"]
    status, workspace = harness.http_json(
        "POST",
        f"{base}/workspaces/create",
        {"name": f"Attachment E2E {stamp}"},
        token,
    )
    assert status == 200, (status, workspace)
    status, workspace_detail = harness.http_json(
        "GET",
        f"{base}/workspaces/{workspace['id']}",
        token=token,
    )
    assert status == 200, (status, workspace_detail)
    channels = workspace_detail.get("channels") or []
    if not channels or not channels[0].get("id"):
        raise AssertionError(f"Workspace has no channel: {workspace_detail}")
    return {
        "email": email,
        "password": password,
        "token": token,
        "workspaceId": workspace["id"],
        "conversationId": channels[0]["id"],
    }


def _run_bounded(cmd: list[str], *, env: dict[str, str], timeout: int) -> None:
    print("$", " ".join(cmd), flush=True)
    proc = subprocess.Popen(
        cmd,
        cwd=ROOT,
        env=env,
        text=True,
        start_new_session=True,
    )
    try:
        return_code = proc.wait(timeout=timeout)
    except BaseException:
        harness.terminate_process(proc, timeout=15)
        raise
    if return_code != 0:
        raise subprocess.CalledProcessError(return_code, cmd)


def _run_desktop_e2e(
    env: dict[str, str], fixture: dict[str, str], files: dict[str, Path]
) -> None:
    SCREENSHOT.unlink(missing_ok=True)
    FAILURE_SCREENSHOT.unlink(missing_ok=True)
    desktop_env = env | {
        "THECHAT_BACKEND_URL": f"http://127.0.0.1:{API_PORT}",
        "THECHAT_E2E_DISABLE_DOTENV": "1",
        "TAURI_E2E": "1",
        "ATTACHMENT_E2E_EMAIL": fixture["email"],
        "ATTACHMENT_E2E_PASSWORD": fixture["password"],
        "ATTACHMENT_E2E_TOKEN": fixture["token"],
        "ATTACHMENT_E2E_CONVERSATION_ID": fixture["conversationId"],
        "ATTACHMENT_E2E_VALID_FIXTURE": str(files["valid"]),
        "ATTACHMENT_E2E_REJECTED_FIXTURE": str(files["rejected"]),
        "ATTACHMENT_E2E_CANCEL_FIXTURE": str(files["cancel"]),
        "ATTACHMENT_E2E_SCREENSHOT": str(SCREENSHOT),
        "ATTACHMENT_E2E_FAILURE_SCREENSHOT": str(FAILURE_SCREENSHOT),
        "WDIO_MOCHA_TIMEOUT": "480000",
        "GDK_BACKEND": "x11",
    }
    desktop_env.pop("SKIP_BUILD", None)
    desktop_env.pop("WAYLAND_DISPLAY", None)
    _run_bounded(
        [
            "xvfb-run",
            "-a",
            harness.PNPM,
            "--filter",
            "@thechat/desktop",
            "exec",
            "wdio",
            "run",
            "e2e/wdio.conf.js",
            "--spec",
            "e2e/opt-in/attachments.e2e.js",
        ],
        env=desktop_env,
        timeout=900,
    )
    if not SCREENSHOT.exists() or SCREENSHOT.stat().st_size == 0:
        raise AssertionError(f"Attachment UI screenshot was not produced: {SCREENSHOT}")


def _attachment_statuses(file_names: list[str]) -> dict[str, str]:
    literals = ", ".join(harness.sql_literal(name) for name in file_names)
    return harness.db_json(
        "select coalesce(jsonb_object_agg(file_name, status::text), '{}'::jsonb) "
        f"from attachments where file_name in ({literals});"
    )


def _verify_backend(
    base: str,
    fixture: dict[str, str],
    files: dict[str, Path],
) -> dict[str, Any]:
    names = {key: path.name for key, path in files.items()}
    status, messages = harness.http_json(
        "GET",
        f"{base}/messages/{fixture['conversationId']}",
        token=fixture["token"],
    )
    assert status == 200, (status, messages)
    matching = [
        message
        for message in messages
        if any(
            attachment.get("fileName") == names["valid"]
            for attachment in message.get("attachments") or []
        )
    ]
    assert len(matching) == 1, matching
    assert matching[0].get("content") == "", matching[0]
    assert len(matching[0].get("attachments") or []) == 1, matching[0]

    def terminal_statuses():
        statuses = _attachment_statuses(list(names.values()))
        # The WebDriver assertion proves the rejected state while the app is
        # alive. Session shutdown may then run InputBar's unsent-draft cleanup,
        # so either the observed rejection or its completed deletion is valid.
        if (
            statuses.get(names["valid"]) == "attached"
            and statuses.get(names["rejected"]) in {"rejected", "deleted"}
            and statuses.get(names["cancel"]) == "deleted"
        ):
            return statuses
        return None

    statuses = _wait_for(
        terminal_statuses,
        timeout=120,
        label="attached/rejected-cleaned/cancelled attachment states",
    )
    return {
        "messageId": matching[0]["id"],
        "attachmentId": matching[0]["attachments"][0]["id"],
        "statuses": statuses,
        "screenshot": str(SCREENSHOT),
    }


def _container_log_tail(name: str) -> str:
    result = subprocess.run(
        ["docker", "logs", "--tail", "80", name],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return (result.stdout + result.stderr)[-8000:]


def _cleanup() -> None:
    if KEEP:
        print(
            "Keeping attachment E2E resources:",
            S3_CONTAINER,
            CLAMAV_CONTAINER,
            harness.PG_CONTAINER,
            harness.REDIS_CONTAINER,
            flush=True,
        )
        return
    for name in (
        S3_CONTAINER,
        CLAMAV_CONTAINER,
        harness.PG_CONTAINER,
        harness.REDIS_CONTAINER,
    ):
        harness.run(["docker", "rm", "-f", name], check=False)
    shutil.rmtree(FIXTURE_DIR, ignore_errors=True)


def _run() -> None:
    env = _safe_child_env()
    api_proc: subprocess.Popen[Any] | None = None
    worker_proc: subprocess.Popen[Any] | None = None
    completed = False
    files: dict[str, Path] = {}
    try:
        _start_s3(env)
        _start_clamav()
        harness.start_postgres()
        harness.start_redis()
        harness.run(
            [
                harness.PNPM,
                "--dir",
                "packages/api",
                "exec",
                "drizzle-kit",
                "migrate",
            ],
            env=env,
        )
        api_proc = harness.start_api(env)
        worker_proc = harness.start_worker(env)
        base = f"http://127.0.0.1:{API_PORT}"
        fixture = _register_fixture_workspace(base)
        files = _write_fixtures()
        _run_desktop_e2e(env, fixture, files)
        evidence = _verify_backend(base, fixture, files)
        print(json.dumps(evidence, indent=2, sort_keys=True), flush=True)
        completed = True
    finally:
        harness.terminate_process(worker_proc, timeout=15)
        harness.terminate_process(api_proc, timeout=15)
        if not completed:
            for name in (S3_CONTAINER, CLAMAV_CONTAINER):
                if _container_running(name):
                    tail = _container_log_tail(name)
                    if tail:
                        print(f"--- {name} logs ---\n{tail}", file=sys.stderr)
            if FAILURE_SCREENSHOT.exists():
                print(f"Failure screenshot: {FAILURE_SCREENSHOT}", file=sys.stderr)
        _cleanup()


def main() -> int:
    with _exclusive_run_lock(), _interruptible_cleanup():
        _run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
