#!/usr/bin/env python3
"""Real Tauri attachment lifecycle E2E using only local disposable services."""

from __future__ import annotations

import fcntl
import hashlib
import http.client
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
os.environ.setdefault("ATTACHMENT_E2E_S3_ORIGIN_PORT", "19001")
os.environ.setdefault("ATTACHMENT_E2E_OTEL_HTTP_PORT", "14328")
os.environ.setdefault("ATTACHMENT_E2E_TEMPO_PORT", "13200")
os.environ.setdefault("ATTACHMENT_E2E_GRAFANA_PORT", "13310")
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
CONTAINER_LABEL = "thechat.e2e.suite=attachment-ui"
os.environ["THECHAT_E2E_CONTAINER_LABEL"] = CONTAINER_LABEL

API_PORT = int(os.environ["THECHAT_E2E_API_PORT"])
S3_PORT = int(os.environ["ATTACHMENT_E2E_S3_PORT"])
S3_ORIGIN_PORT = int(os.environ["ATTACHMENT_E2E_S3_ORIGIN_PORT"])
OTEL_HTTP_PORT = int(os.environ["ATTACHMENT_E2E_OTEL_HTTP_PORT"])
TEMPO_PORT = int(os.environ["ATTACHMENT_E2E_TEMPO_PORT"])
GRAFANA_PORT = int(os.environ["ATTACHMENT_E2E_GRAFANA_PORT"])
S3_CONTAINER = f"thechat-attachment-e2e-s3-{RUN_ID}"
OTEL_CONTAINER = f"thechat-attachment-e2e-otel-{RUN_ID}"
S3_IMAGE = os.environ.get(
    "ATTACHMENT_E2E_S3_IMAGE",
    "localstack/localstack:4.4.0",
)
OTEL_IMAGE = os.environ.get(
    "ATTACHMENT_E2E_OTEL_IMAGE",
    "grafana/otel-lgtm@sha256:af7242c1a9608faf6d26e6f235392fd0c32b67258228f9a3cfc96e724974930c",
)
BUCKET = f"thechat-attachment-e2e-{RUN_ID}".replace("_", "-").lower()
KEEP = os.environ.get("ATTACHMENT_E2E_KEEP") == "1"
FIXTURE_DIR = TMP / "attachment-ui-e2e-fixtures" / RUN_ID
SCREENSHOT = TMP / f"attachment-ui-e2e-{RUN_ID}.png"
SUCCESS_SCREENSHOT = TMP / f"attachment-ui-e2e-success-{RUN_ID}.png"
OPAQUE_SCREENSHOT = TMP / f"attachment-ui-e2e-opaque-{RUN_ID}.png"
FAILURE_SCREENSHOT = TMP / f"attachment-ui-e2e-failure-{RUN_ID}.png"
RESULT_JSON = TMP / f"attachment-ui-e2e-{RUN_ID}.json"
TRACE_EXPORTER = ROOT / "scripts/e2e/export_attachment_tempo_evidence.py"


def _resolve_evidence_dir(
    source: dict[str, str] | None = None,
    *,
    run_id: str = RUN_ID,
    home: Path | None = None,
) -> Path:
    """Return the mandatory durable destination for verified E2E evidence."""
    env = os.environ if source is None else source
    if env.get("ATTACHMENT_E2E_REQUIRE_EVIDENCE", "1") != "1":
        raise RuntimeError("Attachment E2E evidence verification cannot be disabled")

    configured = env.get("ATTACHMENT_E2E_EVIDENCE_DIR")
    if configured is not None:
        if not configured.strip():
            raise RuntimeError("ATTACHMENT_E2E_EVIDENCE_DIR must not be empty")
        return Path(configured).expanduser().resolve()

    cache_value = env.get("XDG_CACHE_HOME")
    if cache_value is not None and not cache_value.strip():
        raise RuntimeError("XDG_CACHE_HOME must not be empty")
    cache_root = (
        Path(cache_value).expanduser()
        if cache_value
        else (home if home is not None else Path.home()) / ".cache"
    )
    return (cache_root / "thechat" / "e2e" / "attachments" / run_id / "tempo").resolve()


TRACE_EVIDENCE_DIR = _resolve_evidence_dir()
ARTIFACT_ROOT = TRACE_EVIDENCE_DIR.parent
DOWNLOAD_DIR = ARTIFACT_ROOT / "downloads"
OPENER_MARKER = ARTIFACT_ROOT / "native-opener-handoff.txt"
RUNTIME_ROOT = TMP / "attachment-ui-e2e-runtime" / RUN_ID
TRACE_LOG_PATH = (
    Path(os.environ["ATTACHMENT_E2E_LOG_PATH"]).expanduser().resolve()
    if os.environ.get("ATTACHMENT_E2E_LOG_PATH")
    else None
)
NATIVE_DESKTOP_E2E_LOCK = "native-desktop-e2e.lock"
SLOW_UPLOAD_MIN_BYTES = 1024 * 1024
SLOW_UPLOAD_CHUNK_BYTES = 64 * 1024
SLOW_UPLOAD_CHUNK_DELAY_SECONDS = 0.05
_s3_proxy: ThreadingHTTPServer | None = None
_s3_proxy_thread: threading.Thread | None = None

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


def _local_docker_env(source: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if source is None else source)
    for key in (
        "DOCKER_HOST",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
        "DOCKER_CONFIG",
    ):
        env.pop(key, None)
    env["DOCKER_CONTEXT"] = "default"
    return env


DOCKER_ENV = _local_docker_env()


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
    lock_path = TMP / NATIVE_DESKTOP_E2E_LOCK
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


def _source_resource_attributes(source_identity: dict[str, Any]) -> str:
    return ",".join(
        (
            "deployment.environment=e2e",
            f"thechat.e2e.run_id={RUN_ID}",
            f"service.version={source_identity['sourceCommit']}",
            f"thechat.source.tree={source_identity['sourceTree']}",
            f"thechat.source.diff_sha256={source_identity['sourceDiffSha256']}",
        )
    )


def _safe_child_env(source_identity: dict[str, Any]) -> dict[str, str]:
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
            "THECHAT_BACKEND_HOST": "127.0.0.1",
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
            "THECHAT_OTEL_ENABLED": "true",
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": (
                f"http://127.0.0.1:{OTEL_HTTP_PORT}/v1/traces"
            ),
            "OTEL_RESOURCE_ATTRIBUTES": _source_resource_attributes(source_identity),
            "NO_PROXY": "127.0.0.1,localhost,::1",
            "no_proxy": "127.0.0.1,localhost,::1",
        }
    )
    return env


def _require_local_docker() -> str:
    result = subprocess.run(
        [
            "docker",
            "context",
            "inspect",
            "default",
            "--format",
            "{{.Endpoints.docker.Host}}",
        ],
        cwd=ROOT,
        env=DOCKER_ENV,
        capture_output=True,
        text=True,
    )
    endpoint = result.stdout.strip()
    if result.returncode != 0 or not endpoint.startswith("unix://"):
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(
            "Attachment E2E requires the local Docker Unix socket; "
            f"default context resolved to {endpoint or detail or 'unknown'}"
        )
    return endpoint


def _reap_stale_containers() -> None:
    result = subprocess.run(
        ["docker", "ps", "-aq", "--filter", f"label={CONTAINER_LABEL}"],
        cwd=ROOT,
        env=DOCKER_ENV,
        capture_output=True,
        text=True,
        check=True,
    )
    container_ids = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if container_ids:
        harness.run(
            ["docker", "rm", "-f", *container_ids],
            env=DOCKER_ENV,
        )


def _container_running(name: str) -> bool:
    result = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", name],
        cwd=ROOT,
        env=DOCKER_ENV,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0 and result.stdout.strip() == "true"


def _source_identity() -> dict[str, Any]:
    TMP.mkdir(parents=True, exist_ok=True)
    index_path = TMP / f"attachment-source-index-{RUN_ID}"
    index_path.unlink(missing_ok=True)
    env = os.environ.copy()
    env["GIT_INDEX_FILE"] = str(index_path)

    def git(*args: str, binary: bool = False) -> str | bytes:
        result = subprocess.run(
            ["git", *args],
            cwd=ROOT,
            env=env,
            check=True,
            capture_output=True,
            text=not binary,
        )
        return result.stdout

    try:
        git("read-tree", "HEAD")
        git("add", "-A")
        source_tree_output = git("write-tree")
        assert isinstance(source_tree_output, str)
        source_tree = source_tree_output.strip()
        source_diff = git("diff", "--binary", "HEAD", source_tree, binary=True)
        assert isinstance(source_diff, bytes)
        status_output = git("status", "--porcelain=v1", "--untracked-files=all")
        assert isinstance(status_output, str)
        status = status_output
        source_commit_output = git("rev-parse", "HEAD")
        assert isinstance(source_commit_output, str)
        return {
            "runId": RUN_ID,
            "sourceCommit": source_commit_output.strip(),
            "sourceTree": source_tree,
            "sourceDiffSha256": hashlib.sha256(source_diff).hexdigest(),
            "sourceStatusLineCount": len([line for line in status.splitlines() if line]),
        }
    finally:
        index_path.unlink(missing_ok=True)


def _assert_source_identity_unchanged(
    before: dict[str, Any], after: dict[str, Any]
) -> None:
    identity_keys = (
        "sourceCommit",
        "sourceTree",
        "sourceDiffSha256",
        "sourceStatusLineCount",
    )
    changed = [key for key in identity_keys if before.get(key) != after.get(key)]
    if changed:
        raise RuntimeError(
            "Attachment E2E source changed during build/run: " + ", ".join(changed)
        )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _start_otel() -> None:
    harness.run(
        ["docker", "rm", "-f", OTEL_CONTAINER], check=False, env=DOCKER_ENV
    )
    harness.run(
        [
            "docker",
            "run",
            "-d",
            "--name",
            OTEL_CONTAINER,
            "--label",
            CONTAINER_LABEL,
            "-p",
            f"127.0.0.1:{GRAFANA_PORT}:3000",
            "-p",
            f"127.0.0.1:{OTEL_HTTP_PORT}:4318",
            "-p",
            f"127.0.0.1:{TEMPO_PORT}:3200",
            "-v",
            f"{ROOT / 'deployment/local/otelcol-config.yaml'}:/otel-lgtm/otelcol-config.yaml:ro",
            OTEL_IMAGE,
        ],
        env=DOCKER_ENV,
    )

    def ready() -> bool:
        if not _container_running(OTEL_CONTAINER):
            raise RuntimeError("Grafana OTEL-LGTM exited before becoming ready")
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{GRAFANA_PORT}/api/health", timeout=2
            ) as response:
                grafana = json.loads(response.read())
            with urllib.request.urlopen(
                f"http://127.0.0.1:{TEMPO_PORT}/ready", timeout=2
            ) as response:
                tempo_ready = response.read().decode().strip() == "ready"
            return grafana.get("database") == "ok" and tempo_ready
        except (OSError, ValueError):
            return False

    _wait_for(ready, timeout=120, label="Grafana OTEL-LGTM readiness")


def _wait_for(predicate: Callable[[], Any], *, timeout: float, label: str):
    return harness.wait_for(predicate, timeout=timeout, label=label)


def _should_throttle_upload(method: str, content_length: int) -> bool:
    return method == "PUT" and content_length >= SLOW_UPLOAD_MIN_BYTES


class _S3ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: Any) -> None:
        # Request paths contain presigned capability query strings.
        return

    def do_DELETE(self) -> None:
        self._proxy()

    def do_GET(self) -> None:
        self._proxy()

    def do_HEAD(self) -> None:
        self._proxy()

    def do_OPTIONS(self) -> None:
        self._proxy()

    def do_POST(self) -> None:
        self._proxy()

    def do_PUT(self) -> None:
        self._proxy()

    def _proxy(self) -> None:
        upstream = http.client.HTTPConnection(
            "127.0.0.1", S3_ORIGIN_PORT, timeout=180
        )
        try:
            upstream.putrequest(
                self.command,
                self.path,
                skip_host=True,
                skip_accept_encoding=True,
            )
            for name, value in self.headers.items():
                if name.lower() in {"connection", "proxy-connection"}:
                    continue
                upstream.putheader(name, value)
            upstream.endheaders()

            content_length = int(self.headers.get("Content-Length", "0") or "0")
            remaining = content_length
            throttled = _should_throttle_upload(self.command, content_length)
            while remaining > 0:
                chunk = self.rfile.read(min(SLOW_UPLOAD_CHUNK_BYTES, remaining))
                if not chunk:
                    raise ConnectionError("client closed the upload before completion")
                upstream.send(chunk)
                remaining -= len(chunk)
                if throttled:
                    time.sleep(SLOW_UPLOAD_CHUNK_DELAY_SECONDS)

            response = upstream.getresponse()
            body = b"" if self.command == "HEAD" else response.read()
            self.send_response(response.status, response.reason)
            for name, value in response.getheaders():
                lowered = name.lower()
                if lowered in {
                    "connection",
                    "proxy-connection",
                    "transfer-encoding",
                }:
                    continue
                if lowered == "content-length" and self.command != "HEAD":
                    continue
                self.send_header(name, value)
            if self.command != "HEAD":
                self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionError, OSError, http.client.HTTPException):
            try:
                self.send_error(502, "S3 proxy request did not complete")
            except (BrokenPipeError, ConnectionError, OSError):
                pass
        finally:
            upstream.close()
            self.close_connection = True


def _start_s3_proxy() -> None:
    global _s3_proxy, _s3_proxy_thread
    if S3_PORT == S3_ORIGIN_PORT:
        raise RuntimeError("S3 proxy and origin ports must differ")
    server = ThreadingHTTPServer(("127.0.0.1", S3_PORT), _S3ProxyHandler)
    server.daemon_threads = True
    thread = threading.Thread(
        target=server.serve_forever,
        name=f"attachment-s3-proxy-{RUN_ID}",
        daemon=True,
    )
    thread.start()
    _s3_proxy = server
    _s3_proxy_thread = thread


def _stop_s3_proxy() -> None:
    global _s3_proxy, _s3_proxy_thread
    server = _s3_proxy
    thread = _s3_proxy_thread
    _s3_proxy = None
    _s3_proxy_thread = None
    if server is not None:
        server.shutdown()
        server.server_close()
    if thread is not None:
        thread.join(timeout=5)


def _start_s3(env: dict[str, str]) -> None:
    harness.run(
        ["docker", "rm", "-f", S3_CONTAINER], check=False, env=DOCKER_ENV
    )
    harness.run(
        [
            "docker",
            "run",
            "-d",
            "--name",
            S3_CONTAINER,
            "--label",
            CONTAINER_LABEL,
            "-e",
            "SERVICES=s3",
            "-e",
            "PERSISTENCE=0",
            "-e",
            "LS_LOG=warn",
            "-p",
            f"127.0.0.1:{S3_ORIGIN_PORT}:4566",
            S3_IMAGE,
        ],
        env=DOCKER_ENV,
    )

    def ready() -> bool:
        if not _container_running(S3_CONTAINER):
            raise RuntimeError("LocalStack S3 exited before becoming ready")
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{S3_ORIGIN_PORT}/_localstack/health", timeout=2
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
        env=env
        | {"ATTACHMENT_S3_ENDPOINT": f"http://127.0.0.1:{S3_ORIGIN_PORT}"},
        cwd=ROOT / "packages/api",
    )
    _start_s3_proxy()


def _write_fixtures() -> dict[str, Path]:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    valid = FIXTURE_DIR / f"valid-{RUN_ID}.eml"
    opaque = FIXTURE_DIR / f"opaque-{RUN_ID}.html"
    cancel = FIXTURE_DIR / f"cancel-{RUN_ID}.txt"
    valid.write_text(
        f"From: sender@example.com\nTo: recipient@example.com\nSubject: TheChat {RUN_ID}\n\nAttachment payload\n",
        encoding="utf-8",
    )
    opaque.write_text(
        "<!doctype html><script>alert('attachment')</script>",
        encoding="utf-8",
    )
    cancel.write_bytes(b"C" * (20 * 1024 * 1024))
    return {"valid": valid, "opaque": opaque, "cancel": cancel}


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
    print("$", harness.format_command(cmd), flush=True)
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
    SUCCESS_SCREENSHOT.unlink(missing_ok=True)
    OPAQUE_SCREENSHOT.unlink(missing_ok=True)
    FAILURE_SCREENSHOT.unlink(missing_ok=True)
    OPENER_MARKER.unlink(missing_ok=True)
    shutil.rmtree(DOWNLOAD_DIR, ignore_errors=True)
    shutil.rmtree(RUNTIME_ROOT, ignore_errors=True)
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=False)
    runtime_tmp = RUNTIME_ROOT / "tmp"
    xdg_runtime = RUNTIME_ROOT / "xdg"
    runtime_tmp.mkdir(parents=True, exist_ok=True)
    xdg_runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    desktop_env = env | {
        "THECHAT_BACKEND_URL": f"http://127.0.0.1:{API_PORT}",
        "THECHAT_E2E_DISABLE_DOTENV": "1",
        "TAURI_E2E": "1",
        "ATTACHMENT_E2E_EMAIL": fixture["email"],
        "ATTACHMENT_E2E_PASSWORD": fixture["password"],
        "ATTACHMENT_E2E_TOKEN": fixture["token"],
        "ATTACHMENT_E2E_CONVERSATION_ID": fixture["conversationId"],
        "ATTACHMENT_E2E_VALID_FIXTURE": str(files["valid"]),
        "ATTACHMENT_E2E_OPAQUE_FIXTURE": str(files["opaque"]),
        "ATTACHMENT_E2E_CANCEL_FIXTURE": str(files["cancel"]),
        "ATTACHMENT_E2E_SCREENSHOT": str(SCREENSHOT),
        "ATTACHMENT_E2E_SUCCESS_SCREENSHOT": str(SUCCESS_SCREENSHOT),
        "ATTACHMENT_E2E_OPAQUE_SCREENSHOT": str(OPAQUE_SCREENSHOT),
        "ATTACHMENT_E2E_FAILURE_SCREENSHOT": str(FAILURE_SCREENSHOT),
        "ATTACHMENT_E2E_DOWNLOAD_DIR": str(DOWNLOAD_DIR),
        "ATTACHMENT_E2E_OPENER_MARKER": str(OPENER_MARKER),
        "THECHAT_ATTACHMENT_DOWNLOAD_DIR": str(DOWNLOAD_DIR),
        "THECHAT_E2E_RUNTIME_ROOT": str(RUNTIME_ROOT),
        "TMPDIR": str(runtime_tmp),
        "XDG_RUNTIME_DIR": str(xdg_runtime),
        "VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": (
            f"http://127.0.0.1:{OTEL_HTTP_PORT}/v1/traces"
        ),
        "VITE_OTEL_SERVICE_NAME": "thechat-desktop",
        "VITE_OTEL_RESOURCE_ATTRIBUTES": env["OTEL_RESOURCE_ATTRIBUTES"],
        "VITE_OTEL_E2E_FORCE_FLUSH": "true",
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
    downloaded_path = DOWNLOAD_DIR / files["valid"].name
    if not downloaded_path.is_file():
        raise AssertionError("Compiled Tauri download did not save the verified file")
    if OPENER_MARKER.exists():
        raise AssertionError("Compiled Tauri download invoked a native file opener")


def _attachment_statuses(file_names: list[str]) -> dict[str, str]:
    literals = ", ".join(harness.sql_literal(name) for name in file_names)
    return harness.db_json(
        "select coalesce(jsonb_object_agg(file_name, status::text), '{}'::jsonb) "
        f"from attachments where file_name in ({literals});",
        env=DOCKER_ENV,
    )


def _attachment_cleanup_rows(file_names: list[str]) -> list[dict[str, Any]]:
    literals = ", ".join(harness.sql_literal(name) for name in file_names)
    return harness.db_json(
        "select coalesce(jsonb_agg(jsonb_build_object("
        "'fileName', file_name, 'status', status::text, 'deletedAt', deleted_at, "
        "'quarantineKey', quarantine_key, 'quarantineVersionId', quarantine_version_id, "
        "'cleanKey', clean_key, 'cleanVersionId', clean_version_id"
        ") order by file_name), '[]'::jsonb) from attachments "
        f"where file_name in ({literals});",
        env=DOCKER_ENV,
    )


def _s3_residual_versions(keys: list[str], env: dict[str, str]) -> dict[str, Any]:
    script = """
import { ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
const expected = new Set(JSON.parse(process.env.ATTACHMENT_E2E_VERIFY_KEYS));
const client = new S3Client({
  region: process.env.AWS_REGION,
  endpoint: process.env.ATTACHMENT_S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const versions = [];
const deleteMarkers = [];
let keyMarker;
let versionIdMarker;
do {
  const page = await client.send(new ListObjectVersionsCommand({
    Bucket: process.env.ATTACHMENT_S3_BUCKET,
    KeyMarker: keyMarker,
    VersionIdMarker: versionIdMarker,
  }));
  for (const item of page.Versions ?? []) {
    if (expected.has(item.Key)) versions.push({ key: item.Key, versionId: item.VersionId });
  }
  for (const item of page.DeleteMarkers ?? []) {
    if (expected.has(item.Key)) deleteMarkers.push({ key: item.Key, versionId: item.VersionId });
  }
  keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
  versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
} while (keyMarker);
console.log(JSON.stringify({ versions, deleteMarkers }));
"""
    result = subprocess.run(
        [harness.BUN, "-e", script],
        cwd=ROOT / "packages/api",
        env=env
        | {
            "ATTACHMENT_S3_ENDPOINT": f"http://127.0.0.1:{S3_ORIGIN_PORT}",
            "ATTACHMENT_E2E_VERIFY_KEYS": json.dumps(keys),
        },
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError("Failed to inspect attachment object versions")
    try:
        return json.loads(result.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as error:
        raise RuntimeError("Attachment object-version probe returned invalid output") from error


def _verify_backend(
    base: str,
    fixture: dict[str, str],
    files: dict[str, Path],
    env: dict[str, str],
) -> dict[str, Any]:
    names = {key: path.name for key, path in files.items()}
    status, messages = harness.http_json(
        "GET",
        f"{base}/messages/{fixture['conversationId']}",
        token=fixture["token"],
    )
    assert status == 200, (status, messages)
    matching = {
        name: [
            message
            for message in messages
            if any(
                attachment.get("fileName") == name
                for attachment in message.get("attachments") or []
            )
        ]
        for name in (names["valid"], names["opaque"])
    }
    for name, matched_messages in matching.items():
        assert len(matched_messages) == 1, (name, matched_messages)
        assert matched_messages[0].get("content") == "", matched_messages[0]
        assert len(matched_messages[0].get("attachments") or []) == 1, matched_messages[0]

    def terminal_statuses():
        statuses = _attachment_statuses(list(names.values()))
        if (
            statuses.get(names["valid"]) == "attached"
            and statuses.get(names["opaque"]) == "attached"
            and statuses.get(names["cancel"]) == "deleted"
        ):
            return statuses
        return None

    statuses = _wait_for(
        terminal_statuses,
        timeout=120,
        label="valid/opaque attached and cancelled attachment deleted",
    )
    cleanup_rows = _attachment_cleanup_rows([names["cancel"]])
    if len(cleanup_rows) != 1:
        raise AssertionError(f"Expected one cleanup row, found {len(cleanup_rows)}")
    for row in cleanup_rows:
        if (
            row.get("status") != "deleted"
            or not row.get("deletedAt")
            or row.get("quarantineVersionId") is not None
            or row.get("cleanVersionId") is not None
        ):
            raise AssertionError(f"Attachment cleanup row is not truthful: {row}")
    cleanup_keys = sorted(
        {
            key
            for row in cleanup_rows
            for key in (row.get("quarantineKey"), row.get("cleanKey"))
            if key
        }
    )
    object_cleanup = _s3_residual_versions(cleanup_keys, env)
    if object_cleanup.get("versions"):
        raise AssertionError("Deleted attachments retain private object versions")
    downloaded_path = (DOWNLOAD_DIR / names["valid"]).resolve()
    if OPENER_MARKER.exists():
        raise AssertionError("Native attachment download unexpectedly invoked an opener")
    return {
        "statuses": {
            "valid": statuses[names["valid"]],
            "opaque": statuses[names["opaque"]],
            "cancelled": statuses[names["cancel"]],
        },
        "objectCleanup": {
            "verifiedKeyCount": len(cleanup_keys),
            "residualVersionCount": 0,
            "deleteMarkerCount": len(object_cleanup.get("deleteMarkers", [])),
        },
        "lateCapabilityBoundary": {
            "activeUploadAndBrowserAbortObserved": True,
            "revocationClaimed": False,
            "issuedCapabilityExpiresBy": "signed_upload_ttl",
            "postExpiryCleanupBackstop": "private_bucket_lifecycle",
        },
        "nativeDownload": {
            "fileName": downloaded_path.name,
            "bytes": downloaded_path.stat().st_size,
            "sha256": _sha256(downloaded_path),
            "openerHandoff": False,
        },
        "screenshot": str(SCREENSHOT),
    }


def _container_log_tail(name: str) -> str:
    result = subprocess.run(
        ["docker", "logs", "--tail", "80", name],
        cwd=ROOT,
        env=DOCKER_ENV,
        capture_output=True,
        text=True,
    )
    return (result.stdout + result.stderr)[-8000:]


def _export_tempo_evidence(
    source_identity: dict[str, Any], env: dict[str, str]
) -> dict[str, Any]:
    if TRACE_EVIDENCE_DIR is None:
        # Defensive fail-closed guard for tests or future refactors. Normal
        # entrypoints always resolve a durable destination during module load.
        raise RuntimeError("Attachment E2E evidence destination is required")
    if not TRACE_EXPORTER.is_file():
        raise RuntimeError(f"Tempo evidence exporter is missing: {TRACE_EXPORTER}")
    source_scan_files = [
        SUCCESS_SCREENSHOT,
        OPAQUE_SCREENSHOT,
        SCREENSHOT,
        *sorted(path for path in DOWNLOAD_DIR.iterdir() if path.is_file()),
    ]
    if TRACE_LOG_PATH is not None:
        source_scan_files.append(TRACE_LOG_PATH)
    missing = [str(path) for path in source_scan_files if not path.is_file()]
    if missing:
        raise RuntimeError("Evidence scan inputs are missing: " + ", ".join(missing))

    scan_input_dir = TRACE_EVIDENCE_DIR.parent / "evidence-scan-inputs"
    scan_input_dir.mkdir(parents=True, exist_ok=False)
    scan_files: list[Path] = []
    for source in source_scan_files:
        destination = scan_input_dir / source.name
        shutil.copy2(source, destination)
        scan_files.append(destination)

    command = [
        sys.executable,
        str(TRACE_EXPORTER),
        "--tempo",
        f"http://127.0.0.1:{TEMPO_PORT}",
        "--lookback-seconds",
        "3600",
        "--run-id",
        RUN_ID,
        "--output",
        str(TRACE_EVIDENCE_DIR),
        "--source-commit",
        str(source_identity["sourceCommit"]),
        "--source-tree",
        str(source_identity["sourceTree"]),
        "--source-diff-sha256",
        str(source_identity["sourceDiffSha256"]),
    ]
    for path in scan_files:
        command.extend(("--scan-file", str(path)))
    harness.run(command, env=env)

    manifest_path = TRACE_EVIDENCE_DIR / "tempo-evidence-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("run_id") != RUN_ID:
        raise RuntimeError("Tempo evidence manifest run ID does not match the E2E run")
    if manifest.get("source_tree") != source_identity["sourceTree"]:
        raise RuntimeError("Tempo evidence manifest source tree does not match the E2E run")
    return {
        "directory": str(TRACE_EVIDENCE_DIR),
        "manifest": str(manifest_path),
        "readme": str(TRACE_EVIDENCE_DIR / "README.md"),
        "manifestSha256": _sha256(manifest_path),
        "traceCount": manifest.get("trace_count"),
        "spanCount": manifest.get("span_count"),
        "secretFindingCount": manifest.get("secret_scan", {}).get(
            "forbidden_finding_count"
        ),
        "scanInputDirectory": str(scan_input_dir),
        "scanInputs": [
            {
                "path": str(path),
                "bytes": path.stat().st_size,
                "sha256": _sha256(path),
            }
            for path in scan_files
        ],
    }


def _cleanup() -> None:
    _stop_s3_proxy()
    shutil.rmtree(RUNTIME_ROOT, ignore_errors=True)
    if KEEP:
        print(
            "Keeping attachment E2E resources:",
            OTEL_CONTAINER,
            S3_CONTAINER,
            harness.PG_CONTAINER,
            harness.REDIS_CONTAINER,
            flush=True,
        )
        return
    for name in (
        OTEL_CONTAINER,
        S3_CONTAINER,
        harness.PG_CONTAINER,
        harness.REDIS_CONTAINER,
    ):
        harness.run(["docker", "rm", "-f", name], check=False, env=DOCKER_ENV)
    shutil.rmtree(FIXTURE_DIR, ignore_errors=True)


def _run() -> None:
    source_identity = _source_identity()
    env = _safe_child_env(source_identity)
    api_proc: subprocess.Popen[Any] | None = None
    worker_proc: subprocess.Popen[Any] | None = None
    completed = False
    files: dict[str, Path] = {}
    try:
        docker_endpoint = _require_local_docker()
        print(f"Using local Docker endpoint: {docker_endpoint}", flush=True)
        _reap_stale_containers()
        _start_otel()
        _start_s3(env)
        harness.start_postgres(env=DOCKER_ENV)
        harness.start_redis(env=DOCKER_ENV)
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
        evidence = _verify_backend(base, fixture, files, env)
        _assert_source_identity_unchanged(source_identity, _source_identity())

        # Graceful shutdown flushes API/worker batch processors before the
        # mandatory self-verifying Tempo export. Containers remain up until
        # cleanup, and no normal entrypoint can pass without this verifier.
        harness.terminate_process(worker_proc, timeout=15)
        worker_proc = None
        harness.terminate_process(api_proc, timeout=15)
        api_proc = None
        time.sleep(2)
        tempo_evidence = _export_tempo_evidence(source_identity, env)
        _assert_source_identity_unchanged(source_identity, _source_identity())

        screenshots = [SCREENSHOT, SUCCESS_SCREENSHOT, OPAQUE_SCREENSHOT]
        result = {
            **source_identity,
            "completedUnix": int(time.time()),
            "screenshots": [
                {"path": str(path), "sha256": _sha256(path)}
                for path in screenshots
            ],
            "backend": evidence,
            "tempoEvidence": tempo_evidence,
        }
        artifact_root = TRACE_EVIDENCE_DIR.parent
        screenshot_dir = artifact_root / "screenshots"
        screenshot_dir.mkdir(parents=True, exist_ok=True)
        durable_screenshots = []
        for source, name in (
            (SUCCESS_SCREENSHOT, "attachment-success.png"),
            (OPAQUE_SCREENSHOT, "attachment-opaque.png"),
            (SCREENSHOT, "attachment-cancellation.png"),
        ):
            destination = screenshot_dir / name
            shutil.copy2(source, destination)
            durable_screenshots.append(
                {"path": str(destination), "sha256": _sha256(destination)}
            )
        durable_metadata_path = artifact_root / "run-metadata.json"
        result["durableArtifacts"] = {
            "root": str(artifact_root),
            "runMetadata": str(durable_metadata_path),
            "readme": str(TRACE_EVIDENCE_DIR / "README.md"),
            "screenshots": durable_screenshots,
        }
        serialized_result = json.dumps(result, indent=2, sort_keys=True) + "\n"
        RESULT_JSON.write_text(serialized_result, encoding="utf-8")
        durable_metadata_path.write_text(serialized_result, encoding="utf-8")
        print(json.dumps(result, indent=2, sort_keys=True), flush=True)
        completed = True
    finally:
        harness.terminate_process(worker_proc, timeout=15)
        harness.terminate_process(api_proc, timeout=15)
        if not completed:
            for name in (OTEL_CONTAINER, S3_CONTAINER):
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
