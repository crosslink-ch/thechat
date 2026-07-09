#!/usr/bin/env python3
"""Run the local TheChat backend development stack in one terminal."""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LOG_DIR = ROOT / ".tmp" / "dev"

DEV_DEFAULTS = {
    "DATABASE_URL": "postgresql://thechat:thechat@localhost:15543/thechat",
    "REDIS_URL": "redis://localhost:16380",
    "REDIS_KEY_PREFIX": "thechat",
    "REALTIME_DRIVER": "redis",
    "ASYNC_WORKER_CONCURRENCY": "4",
    "DOMAIN_EVENTS_DRIVER": "kafka",
    "KAFKA_BROKERS": "localhost:19092",
    "KAFKA_AUTO_CREATE_TOPICS": "true",
    "KAFKA_TOPIC_PARTITIONS": "3",
    "KAFKA_FROM_BEGINNING": "true",
    "REQUIRE_EMAIL_VERIFICATION": "false",
    "JWT_SECRET": "change-me-local-thechat-jwt-secret",
    "THECHAT_SECRET_KEY": "change-me-local-thechat-secret-key",
    "EMAIL_PROVIDER": "smtp",
    "EMAIL_FROM": "noreply@thechat.app",
    "SMTP_HOST": "localhost",
    "SMTP_PORT": "587",
    "SMTP_USER": "",
    "SMTP_PASS": "",
    "POSTMARK_API_TOKEN": "",
    "THECHAT_BACKEND_PORT": "3000",
    "THECHAT_BACKEND_URL": "http://localhost:3000",
    "LOG_LEVEL": "info",
}


@dataclass
class DevProcess:
    name: str
    command: list[str]
    log_path: Path
    env: dict[str, str]
    process: subprocess.Popen[bytes] | None = None
    log_file: object | None = None

    def start(self) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.log_file = self.log_path.open("ab")
        self.log_file.write(f"\n\n--- {self.name}: {' '.join(self.command)} ---\n".encode())
        self.log_file.flush()
        self.process = subprocess.Popen(
            self.command,
            cwd=ROOT,
            env=self.env,
            stdin=subprocess.DEVNULL,
            stdout=self.log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    def poll(self) -> int | None:
        return None if self.process is None else self.process.poll()

    def stop(self) -> None:
        if self.process is None or self.process.poll() is not None:
            self.close_log()
            return

        try:
            os.killpg(self.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            self.close_log()
            return

        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(timeout=10)
        finally:
            self.close_log()

    def close_log(self) -> None:
        if self.log_file is not None:
            self.log_file.close()
            self.log_file = None

    def tail(self, lines: int = 60) -> str:
        if not self.log_path.exists():
            return ""
        content = self.log_path.read_text(errors="replace").splitlines()
        return "\n".join(content[-lines:])


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Docker Compose services, API, and bot worker for local development")
    parser.add_argument("--skip-compose", action="store_true", help="Do not start local postgres/redis/Kafka/observability with Docker Compose")
    parser.add_argument("--skip-migrate", action="store_true", help="Do not run Drizzle migrations before starting services")
    parser.add_argument("--no-worker", action="store_true", help="Do not start the bot worker")
    parser.add_argument("--logs-dir", default=str(DEFAULT_LOG_DIR), help="Directory for per-service logs")
    parser.add_argument("--check", action="store_true", help="Run preflight checks and exit without starting services")
    raw_args = sys.argv[1:]
    if raw_args[:1] == ["--"]:
        raw_args = raw_args[1:]
    args = parser.parse_args(raw_args)

    env = load_env()
    logs_dir = Path(args.logs_dir).resolve()
    env["THECHAT_DEV_LOGS_DIR"] = str(logs_dir)
    api_port = int(env["THECHAT_BACKEND_PORT"])

    preflight(env, args, api_port)
    if args.check:
        print("dev preflight passed")
        return 0

    logs_dir.mkdir(parents=True, exist_ok=True)

    if not args.skip_compose:
        run(["docker", "compose", "up", "-d", "postgres", "redis", "kafka", "otel-lgtm", "promtail"], env)
        wait_for_service_port(env["DATABASE_URL"], "postgres")
        wait_for_service_port(env["REDIS_URL"], "redis")
        kafka_broker = env["KAFKA_BROKERS"].split(",", 1)[0].strip()
        wait_for_service_port(f"kafka://{kafka_broker}", "kafka")
        wait_for_compose_kafka(env)

    if not args.skip_migrate and env.get("DATABASE_URL"):
        run(["pnpm", "db:migrate"], env)

    processes = build_processes(env, logs_dir, no_worker=args.no_worker)
    for process in processes:
        process.start()
        print(f"started {process.name}; logs: {relative(process.log_path)}")

    try:
        wait_for_http(f"http://127.0.0.1:{api_port}/health", "api", processes, timeout=60)

        print("")
        print(f"API: http://127.0.0.1:{api_port}")
        if not args.no_worker:
            print("Worker: running")
        if not args.skip_compose:
            print(f"Grafana: http://127.0.0.1:{env.get('GRAFANA_PORT', '13300')}")
        print(f"Logs: {relative(logs_dir)}")
        print("Press Ctrl+C to stop API and worker. Docker Compose services stay running.")

        return monitor(processes)
    except KeyboardInterrupt:
        print("\nstopping services...")
        return 0
    finally:
        for process in reversed(processes):
            process.stop()


def load_env() -> dict[str, str]:
    return {
        **DEV_DEFAULTS,
        **load_dotenv(ROOT / ".env"),
        **os.environ,
    }


def load_dotenv(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.is_file():
        return env

    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        key, _, raw_value = line.partition("=")
        key = key.strip()
        if key:
            env[key] = parse_env_value(raw_value.strip())
    return env


def parse_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        value = value[1:-1]
    return value


def preflight(env: dict[str, str], args: argparse.Namespace, api_port: int) -> None:
    for command in ("pnpm", "bun"):
        require_tool(command)

    if not args.skip_compose:
        require_tool("docker")

    if port_open("127.0.0.1", api_port):
        raise SystemExit(f"Port {api_port} is already in use. Stop the existing API or set THECHAT_BACKEND_PORT.")


def build_processes(env: dict[str, str], logs_dir: Path, *, no_worker: bool) -> list[DevProcess]:
    processes = [
        DevProcess("api", ["pnpm", "dev:api"], logs_dir / "api.log", env),
    ]

    if not no_worker:
        processes.append(
            DevProcess("worker", ["pnpm", "dev:worker"], logs_dir / "worker.log", env),
        )

    return processes


def monitor(processes: list[DevProcess]) -> int:
    while True:
        for process in processes:
            code = process.poll()
            if code is not None:
                print(f"\n{process.name} exited with {code}. Recent log output:")
                print(process.tail())
                return code or 1
        time.sleep(0.5)


def wait_for_http(url: str, name: str, processes: list[DevProcess], *, timeout: int) -> None:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        for process in processes:
            code = process.poll()
            if code is not None:
                raise RuntimeError(f"{process.name} exited with {code}\n{process.tail()}")
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                if 200 <= response.status < 500:
                    return
        except urllib.error.HTTPError as error:
            if 200 <= error.code < 500:
                return
            last_error = error
        except Exception as error:
            last_error = error
        time.sleep(1)

    raise RuntimeError(f"Timed out waiting for {name} at {url}: {last_error}")


def wait_for_service_port(url: str, name: str, *, timeout: int = 60) -> None:
    parsed = urlparse(url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or default_port(parsed.scheme)
    if port is None:
        raise SystemExit(f"Could not determine {name} port from {url}")

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if port_open(host, port):
            return
        time.sleep(0.5)

    raise SystemExit(f"Timed out waiting for {name} at {host}:{port}")


def wait_for_compose_kafka(env: dict[str, str], *, timeout: int = 90) -> None:
    deadline = time.monotonic() + timeout
    command = [
        "docker",
        "compose",
        "exec",
        "-T",
        "kafka",
        "/opt/kafka/bin/kafka-topics.sh",
        "--bootstrap-server",
        "localhost:9092",
        "--list",
    ]
    while time.monotonic() < deadline:
        result = subprocess.run(
            command,
            cwd=ROOT,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode == 0:
            return
        time.sleep(1)

    raise SystemExit("Timed out waiting for the Docker Compose Kafka broker")


def default_port(scheme: str) -> int | None:
    if scheme in ("postgres", "postgresql"):
        return 5432
    if scheme == "redis":
        return 6379
    if scheme == "kafka":
        return 9092
    return None


def run(command: list[str], env: dict[str, str], *, quiet: bool = False) -> str:
    if not quiet:
        print("+ " + " ".join(command))
    result = subprocess.run(command, cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode != 0:
        raise SystemExit(f"{' '.join(command)} failed with {result.returncode}\n{result.stdout}")
    if result.stdout.strip() and not quiet:
        print(result.stdout.strip())
    return result.stdout


def require_tool(command: str) -> None:
    if shutil.which(command) is None:
        raise SystemExit(f"Required command not found on PATH: {command}")


def port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def relative(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


if __name__ == "__main__":
    raise SystemExit(main())
