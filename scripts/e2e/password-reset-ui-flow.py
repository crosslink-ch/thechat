#!/usr/bin/env python3
"""Run password-reset tests against isolated, loopback-only disposable services."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TMP = ROOT / ".tmp"
RUN_ID = f"{os.getpid()}-{time.time_ns()}"
LABEL = "thechat.e2e.suite=password-reset-ui"
RUN_LABEL = f"thechat.e2e.run={RUN_ID}"
NETWORK = f"thechat-password-reset-{RUN_ID}"
API_LOG = TMP / f"password-reset-api-{RUN_ID}.log"
PASSTHROUGH_ENV = (
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "PNPM_HOME",
    "NPM_CONFIG_USERCONFIG",
)


def configured_port(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        port = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if not 1024 <= port <= 65535:
        raise RuntimeError(f"{name} must be between 1024 and 65535")
    return port


API_PORT = configured_port("PASSWORD_RESET_E2E_API_PORT", 3341)
POSTGRES_PORT = configured_port("PASSWORD_RESET_E2E_POSTGRES_PORT", 15547)
REDIS_PORT = configured_port("PASSWORD_RESET_E2E_REDIS_PORT", 16384)
SMTP_PORT = configured_port("PASSWORD_RESET_E2E_SMTP_PORT", 1026)
MAILPIT_PORT = configured_port("PASSWORD_RESET_E2E_MAILPIT_PORT", 8026)
TAURI_DRIVER_PORT = 4444
PORTS = (API_PORT, POSTGRES_PORT, REDIS_PORT, SMTP_PORT, MAILPIT_PORT, TAURI_DRIVER_PORT)
if len(set(PORTS)) != len(PORTS):
    raise RuntimeError("Password-reset E2E ports must be distinct")

CONTAINERS = {
    "postgres": f"thechat-password-reset-postgres-{RUN_ID}",
    "redis": f"thechat-password-reset-redis-{RUN_ID}",
    "mailpit": f"thechat-password-reset-mailpit-{RUN_ID}",
}


def base_env() -> dict[str, str]:
    return {key: os.environ[key] for key in PASSTHROUGH_ENV if key in os.environ}


def run(
    command: list[str],
    *,
    env: dict[str, str] | None = None,
    cwd: Path = ROOT,
) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


def docker_env() -> dict[str, str]:
    env = base_env()
    env["DOCKER_CONTEXT"] = "default"
    return env


@contextmanager
def exclusive_lock():
    TMP.mkdir(parents=True, exist_ok=True)
    lock_path = TMP / "password-reset-ui-e2e.lock"
    with lock_path.open("a+", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("Another password-reset E2E run is active") from exc
        yield


def assert_ports_available() -> None:
    for port in PORTS:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.2)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                raise RuntimeError(
                    f"Refusing to reuse occupied loopback port {port}"
                )


def require_loopback_http_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise RuntimeError(f"Refusing non-loopback HTTP endpoint: {url}")


def wait_http(url: str, timeout: float = 30) -> None:
    require_loopback_http_url(url)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status < 500:
                    return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"Timed out waiting for {url}")


def wait_owned_api(api: subprocess.Popen[bytes], url: str, timeout: float = 30) -> None:
    require_loopback_http_url(url)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if api.poll() is not None:
            raise RuntimeError(f"API process exited with status {api.returncode}")
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                body = json.loads(response.read())
                if response.status == 200 and body.get("e2eRunId") == RUN_ID:
                    return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("Timed out waiting for the owned API process")


def wait_container(command: list[str], expected: str, timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = subprocess.run(
            command,
            cwd=ROOT,
            env=docker_env(),
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and expected in result.stdout:
            return
        time.sleep(0.5)
    raise RuntimeError(f"Container readiness command failed: {' '.join(command)}")


def local_env() -> dict[str, str]:
    env = base_env()
    env.update(
        {
            "NODE_ENV": "test",
            "DATABASE_URL": (
                f"postgres://thechat:thechat@127.0.0.1:{POSTGRES_PORT}/"
                "thechat_password_reset_e2e"
            ),
            "REDIS_URL": f"redis://127.0.0.1:{REDIS_PORT}",
            "REALTIME_DRIVER": "redis",
            "JWT_SECRET": secrets.token_urlsafe(48),
            "BETTER_AUTH_SECRET": secrets.token_urlsafe(48),
            "BETTER_AUTH_OTP_PEPPER": secrets.token_urlsafe(48),
            "THECHAT_SECRET_KEY": secrets.token_urlsafe(48),
            "THECHAT_BACKEND_HOST": "127.0.0.1",
            "THECHAT_BACKEND_PORT": str(API_PORT),
            "THECHAT_BACKEND_URL": f"http://127.0.0.1:{API_PORT}",
            "BETTER_AUTH_URL": f"http://127.0.0.1:{API_PORT}",
            "ALLOWED_ORIGINS": "tauri://localhost,http://tauri.localhost",
            "AUTH_TRUST_PROXY": "false",
            "REQUIRE_EMAIL_VERIFICATION": "false",
            "EMAIL_PROVIDER": "smtp",
            "EMAIL_FROM": "noreply@password-reset-e2e.invalid",
            "SMTP_HOST": "127.0.0.1",
            "SMTP_PORT": str(SMTP_PORT),
            "SMTP_USER": "",
            "SMTP_PASS": "",
            "SMTP_SECURE": "false",
            "AUTH_CODE_DELIVERY_TIMEOUT_MS": "500",
            "PASSWORD_RESET_E2E": "1",
            "PASSWORD_RESET_E2E_API_URL": f"http://127.0.0.1:{API_PORT}",
            "PASSWORD_RESET_E2E_MAILPIT_URL": f"http://127.0.0.1:{MAILPIT_PORT}",
            "THECHAT_PASSWORD_RESET_TEST_DISPOSABLE": "1",
            "THECHAT_E2E_TEST_MODE": "1",
            "THECHAT_E2E_DISABLE_DOTENV": "1",
            "THECHAT_E2E_LOOPBACK_ONLY": "1",
            "THECHAT_E2E_RUN_ID": RUN_ID,
            "THECHAT_OTEL_ENABLED": "false",
            "OTEL_SDK_DISABLED": "true",
            "SKIP_BUILD": "0",
            "CARGO_NET_OFFLINE": "true",
            "PNPM_CONFIG_OFFLINE": "true",
            "NPM_CONFIG_OFFLINE": "true",
            "LOG_LEVEL": "error",
            "NO_PROXY": "127.0.0.1,localhost,::1",
            "no_proxy": "127.0.0.1,localhost,::1",
        }
    )

    screenshot = os.environ.get("PASSWORD_RESET_E2E_SCREENSHOT")
    if screenshot:
        screenshot_path = Path(screenshot).resolve()
        if not screenshot_path.is_relative_to(TMP.resolve()):
            raise RuntimeError("E2E screenshots must stay under the repository .tmp directory")
        env["PASSWORD_RESET_E2E_SCREENSHOT"] = str(screenshot_path)
    return env


def start_containers() -> None:
    env = docker_env()
    run(
        [
            "docker",
            "network",
            "create",
            "--driver",
            "bridge",
            "--opt",
            "com.docker.network.bridge.enable_ip_masquerade=false",
            "--label",
            LABEL,
            "--label",
            RUN_LABEL,
            NETWORK,
        ],
        env=env,
    )
    common = ["--pull=never", "--network", NETWORK, "--label", LABEL, "--label", RUN_LABEL]
    run(
        [
            "docker",
            "run",
            "-d",
            *common,
            "--name",
            CONTAINERS["postgres"],
            "-e",
            "POSTGRES_USER=thechat",
            "-e",
            "POSTGRES_PASSWORD=thechat",
            "-e",
            "POSTGRES_DB=thechat_password_reset_e2e",
            "-p",
            f"127.0.0.1:{POSTGRES_PORT}:5432",
            "postgres:17-alpine",
        ],
        env=env,
    )
    run(
        [
            "docker",
            "run",
            "-d",
            *common,
            "--name",
            CONTAINERS["redis"],
            "-p",
            f"127.0.0.1:{REDIS_PORT}:6379",
            "redis:7-alpine",
        ],
        env=env,
    )
    run(
        [
            "docker",
            "run",
            "-d",
            *common,
            "--name",
            CONTAINERS["mailpit"],
            "-p",
            f"127.0.0.1:{SMTP_PORT}:1025",
            "-p",
            f"127.0.0.1:{MAILPIT_PORT}:8025",
            "axllent/mailpit:v1.27",
        ],
        env=env,
    )
    wait_container(
        ["docker", "exec", CONTAINERS["postgres"], "pg_isready", "-U", "thechat"],
        "accepting connections",
    )
    wait_container(
        ["docker", "exec", CONTAINERS["redis"], "redis-cli", "ping"],
        "PONG",
    )
    wait_http(f"http://127.0.0.1:{MAILPIT_PORT}/api/v1/messages")


def run_focused_api_tests(
    env: dict[str, str],
    all_api_tests: bool,
    selected_test_files: list[str],
    skipped_test_files: list[str],
) -> None:
    api_dir = ROOT / "packages/api"
    test_files = selected_test_files or [
        "src/auth/password-reset.test.ts",
        "src/auth/rate-limit.test.ts",
    ]
    for test_file in test_files:
        candidate = (api_dir / test_file).resolve()
        if (
            api_dir.resolve() not in candidate.parents
            or not candidate.name.endswith(".test.ts")
            or not candidate.is_file()
        ):
            raise RuntimeError(f"Unsafe or missing API test path: {test_file}")
        run(
            ["bun", "--no-env-file", "test", "--timeout", "60000", test_file],
            env=env,
            cwd=api_dir,
        )
    if all_api_tests:
        skipped: set[str] = set()
        for test_file in skipped_test_files:
            candidate = (api_dir / test_file).resolve()
            if (
                api_dir.resolve() not in candidate.parents
                or not candidate.name.endswith(".test.ts")
                or not candidate.is_file()
            ):
                raise RuntimeError(f"Unsafe or missing API test path: {test_file}")
            skipped.add(candidate.relative_to(api_dir).as_posix())
        already_run = set(test_files)
        for candidate in sorted((api_dir / "src").rglob("*.test.ts")):
            relative = candidate.relative_to(api_dir).as_posix()
            if relative in already_run or relative in skipped:
                continue
            run(
                [
                    "bun",
                    "--no-env-file",
                    "test",
                    "--timeout",
                    "60000",
                    relative,
                ],
                cwd=api_dir,
                env=env,
            )


def cleanup(api: subprocess.Popen[bytes] | None) -> None:
    if api is not None and api.poll() is None:
        api.send_signal(signal.SIGTERM)
        try:
            api.wait(timeout=10)
        except subprocess.TimeoutExpired:
            api.kill()
            api.wait(timeout=5)
    subprocess.run(
        ["docker", "rm", "-f", *CONTAINERS.values()],
        cwd=ROOT,
        env=docker_env(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["docker", "network", "rm", NETWORK],
        cwd=ROOT,
        env=docker_env(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--api-only",
        action="store_true",
        help="run focused API tests and skip the compiled desktop flow",
    )
    parser.add_argument(
        "--all-api-tests",
        action="store_true",
        help="also run the complete API test suite against the disposable database",
    )
    parser.add_argument(
        "--api-test-file",
        action="append",
        default=[],
        help="run only this API .test.ts path (repeatable; implies --api-only)",
    )
    parser.add_argument(
        "--skip-api-test-file",
        action="append",
        default=[],
        help="skip this file only when --all-api-tests is enabled",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    env = local_env()
    api: subprocess.Popen[bytes] | None = None
    succeeded = False
    with exclusive_lock():
        try:
            assert_ports_available()
            start_containers()
            run(
                ["pnpm", "--filter", "@thechat/api", "exec", "drizzle-kit", "push"],
                env=env,
            )
            run_focused_api_tests(
                env,
                args.all_api_tests,
                args.api_test_file,
                args.skip_api_test_file,
            )
            if args.api_only or args.api_test_file:
                succeeded = True
                print("Password-reset API tests passed", flush=True)
                return 0

            with API_LOG.open("wb") as log:
                api = subprocess.Popen(
                    ["bun", "--no-env-file", "run", "src/index.ts"],
                    cwd=ROOT / "packages/api",
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
            wait_owned_api(api, f"http://127.0.0.1:{API_PORT}/health")
            run(
                [
                    "xvfb-run",
                    "-a",
                    "pnpm",
                    "--filter",
                    "@thechat/desktop",
                    "exec",
                    "wdio",
                    "run",
                    "e2e/wdio.conf.js",
                    "--spec",
                    "e2e/opt-in/password-reset.e2e.js",
                ],
                env=env,
            )
            succeeded = True
            print("Password-reset native UI E2E passed", flush=True)
            return 0
        finally:
            cleanup(api)
            if succeeded:
                API_LOG.unlink(missing_ok=True)
            elif API_LOG.exists():
                print(f"API log retained at {API_LOG}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
