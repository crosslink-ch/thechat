#!/usr/bin/env python3
"""End-to-end smoke test for TheChat's native Hermes bot flow.

Default mode uses a Dockerized mock Hermes runtime that implements the Hermes
API endpoints TheChat calls. Set HERMES_E2E_MODE=real to run the Nous Hermes
Agent Docker image instead (requires a configured model/provider in the Hermes
container data dir or forwarded provider env vars).
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUN = os.environ.get("BUN", str(Path.home() / ".bun/bin/bun"))
PNPM = os.environ.get("PNPM", "pnpm")
API_PORT = int(os.environ.get("THECHAT_E2E_API_PORT", "3337"))
POSTGRES_PORT = int(os.environ.get("THECHAT_E2E_POSTGRES_PORT", "15543"))
HERMES_PORT = int(os.environ.get("THECHAT_E2E_HERMES_PORT", "18642"))
MODE = os.environ.get("HERMES_E2E_MODE", "mock")
KEEP = os.environ.get("HERMES_E2E_KEEP") == "1"
PG_CONTAINER = os.environ.get("THECHAT_E2E_PG_CONTAINER", "thechat-hermes-e2e-postgres")
HERMES_CONTAINER = os.environ.get("THECHAT_E2E_HERMES_CONTAINER", f"thechat-hermes-e2e-{MODE}")
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    f"postgres://thechat:thechat@localhost:{POSTGRES_PORT}/thechat",
)
HERMES_API_KEY = os.environ.get("HERMES_E2E_API_KEY", "thechat-hermes-e2e-key")


def run(cmd: list[str], *, check: bool = True, env: dict[str, str] | None = None, cwd: Path = ROOT) -> subprocess.CompletedProcess:
    print("$", " ".join(cmd), flush=True)
    return subprocess.run(cmd, cwd=cwd, env=env, text=True, check=check)


def output(cmd: list[str], *, env: dict[str, str] | None = None, cwd: Path = ROOT) -> str:
    print("$", " ".join(cmd), flush=True)
    return subprocess.check_output(cmd, cwd=cwd, env=env, text=True).strip()


def wait_for(predicate, timeout=60, label="condition"):
    start = time.time()
    last_error = None
    while time.time() - start < timeout:
        try:
            value = predicate()
            if value:
                return value
        except Exception as exc:  # noqa: BLE001 - printed for diagnostics
            last_error = exc
        time.sleep(1)
    raise RuntimeError(f"Timed out waiting for {label}. Last error: {last_error}")


def http_json(method: str, url: str, body=None, token: str | None = None):
    data = None if body is None else json.dumps(body).encode()
    headers = {}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            text = resp.read().decode()
            return resp.status, json.loads(text) if text else None
    except urllib.error.HTTPError as exc:
        text = exc.read().decode()
        try:
            parsed = json.loads(text)
        except Exception:
            parsed = text
        return exc.code, parsed


def start_postgres():
    run(["docker", "rm", "-f", PG_CONTAINER], check=False)
    run([
        "docker",
        "run",
        "-d",
        "--name",
        PG_CONTAINER,
        "-e",
        "POSTGRES_USER=thechat",
        "-e",
        "POSTGRES_PASSWORD=thechat",
        "-e",
        "POSTGRES_DB=thechat",
        "-p",
        f"127.0.0.1:{POSTGRES_PORT}:5432",
        "postgres:16-alpine",
    ])
    wait_for(
        lambda: run(["docker", "exec", PG_CONTAINER, "pg_isready", "-U", "thechat", "-d", "thechat"], check=False).returncode == 0,
        timeout=45,
        label="Postgres readiness",
    )


def start_mock_hermes(tmpdir: Path):
    server = tmpdir / "mock_hermes_server.py"
    server.write_text(
        """
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def _json(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        if self.path == '/health':
            return self._json({'status': 'ok'})
        if self.path == '/v1/capabilities':
            return self._json({'capabilities': ['runs', 'responses']})
        if self.path == '/v1/runs/e2e-run-1/events':
            body = b'event: run_started\\ndata: {"run_id":"e2e-run-1"}\\n\\nevent: done\\ndata: {"final_output":"Hermes E2E response from Docker mock"}\\n\\n'
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._json({'error': 'not found'}, 404)

    def do_POST(self):
        length = int(self.headers.get('content-length') or '0')
        _ = self.rfile.read(length) if length else b''
        if self.path == '/v1/runs':
            return self._json({'run_id': 'e2e-run-1', 'status': 'queued'})
        if self.path == '/v1/runs/e2e-run-1/stop':
            return self._json({'status': 'cancelled'})
        self._json({'error': 'not found'}, 404)

ThreadingHTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
""".strip()
    )
    run(["docker", "rm", "-f", HERMES_CONTAINER], check=False)
    run([
        "docker",
        "run",
        "-d",
        "--name",
        HERMES_CONTAINER,
        "-p",
        f"127.0.0.1:{HERMES_PORT}:8000",
        "-v",
        f"{server}:/app/mock_hermes_server.py:ro",
        "python:3.12-alpine",
        "python",
        "/app/mock_hermes_server.py",
    ])
    wait_for(lambda: http_json("GET", f"http://localhost:{HERMES_PORT}/health")[0] == 200, label="mock Hermes")


def start_real_hermes():
    data_dir = Path(os.environ.get("HERMES_E2E_DATA_DIR", str(Path.home() / ".hermes-thechat-e2e"))).expanduser()
    data_dir.mkdir(parents=True, exist_ok=True)
    image = os.environ.get("HERMES_E2E_IMAGE", "nousresearch/hermes-agent:latest")
    run(["docker", "rm", "-f", HERMES_CONTAINER], check=False)
    cmd = [
        "docker", "run", "-d", "--name", HERMES_CONTAINER,
        "-p", f"127.0.0.1:{HERMES_PORT}:8642",
        "-v", f"{data_dir}:/opt/data",
        "-e", "API_SERVER_ENABLED=true",
        "-e", "API_SERVER_HOST=0.0.0.0",
        "-e", "API_SERVER_PORT=8642",
        "-e", f"API_SERVER_KEY={HERMES_API_KEY}",
        "-e", "API_SERVER_CORS_ORIGINS=*",
    ]
    for key in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "NOUS_API_KEY"]:
        if os.environ.get(key):
            cmd.extend(["-e", key])
    cmd.extend([image, "gateway", "run"])
    run(cmd)
    wait_for(lambda: http_json("GET", f"http://localhost:{HERMES_PORT}/health")[0] == 200, timeout=120, label="real Hermes")


def start_api(env: dict[str, str]) -> subprocess.Popen:
    api_env = env | {
        "DATABASE_URL": DATABASE_URL,
        "JWT_SECRET": "thechat-hermes-e2e-jwt-secret",
        "THECHAT_SECRET_KEY": "thechat-hermes-e2e-secret-key",
        "THECHAT_BACKEND_PORT": str(API_PORT),
        "LOG_LEVEL": "error",
    }
    proc = subprocess.Popen([BUN, "run", "packages/api/src/index.ts"], cwd=ROOT, env=api_env)
    wait_for(lambda: http_json("GET", f"http://localhost:{API_PORT}/health")[0] == 200, timeout=60, label="TheChat API")
    return proc


def main():
    env = os.environ.copy()
    env["PATH"] = f"{Path(BUN).parent}:{env.get('PATH', '')}"
    env["DATABASE_URL"] = DATABASE_URL

    tmp = ROOT / ".hermes" / "tmp" / "hermes-e2e-mock"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
    api_proc: subprocess.Popen | None = None
    try:
        start_postgres()
        if MODE == "real":
            start_real_hermes()
        else:
            start_mock_hermes(tmp)

        run([PNPM, "--filter", "@thechat/api", "db:migrate"], env=env)
        api_proc = start_api(env)

        base = f"http://localhost:{API_PORT}"
        email = f"hermes-e2e-{int(time.time())}@example.com"
        status, register = http_json("POST", f"{base}/auth/register", {"name": "Hermes E2E", "email": email, "password": "password123"})
        assert status == 200, (status, register)
        token = register["accessToken"]

        status, workspace = http_json("POST", f"{base}/workspaces/create", {"name": "Hermes E2E Workspace"}, token)
        assert status == 200, (status, workspace)
        workspace_id = workspace["id"]

        status, bot = http_json(
            "POST",
            f"{base}/bots/create",
            {
                "kind": "hermes",
                "workspaceId": workspace_id,
                "name": "Hermes",
            },
            token,
        )
        assert status == 200, (status, bot)
        assert bot["kind"] == "hermes"
        assert "apiKey" not in bot

        status, config = http_json(
            "PATCH",
            f"{base}/bots/{bot['id']}/hermes",
            {
                "baseUrl": f"http://localhost:{HERMES_PORT}",
                "apiKey": HERMES_API_KEY,
                "defaultInstructions": "Reply with a short E2E confirmation.",
            },
            token,
        )
        assert status == 200, (status, config)
        assert "apiKey" not in config

        status, detail = http_json("GET", f"{base}/workspaces/{workspace_id}", token=token)
        assert status == 200, (status, detail)
        channel_id = detail["channels"][0]["id"]

        status, sent = http_json("POST", f"{base}/messages/{channel_id}", {"content": "@Hermes please answer the E2E smoke"}, token)
        assert status == 200, (status, sent)

        def final_message():
            status, messages = http_json("GET", f"{base}/messages/{channel_id}", token=token)
            if status != 200:
                return None
            for message in messages:
                if message.get("senderName") == "Hermes" and "Hermes" in message.get("content", ""):
                    return message
            return None

        final = wait_for(final_message, timeout=90, label="Hermes bot response")
        print(json.dumps({"ok": True, "workspaceId": workspace_id, "channelId": channel_id, "finalMessage": final}, indent=2))
    finally:
        if api_proc:
            api_proc.send_signal(signal.SIGTERM)
            try:
                api_proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                api_proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)
        if not KEEP:
            run(["docker", "rm", "-f", HERMES_CONTAINER], check=False)
            run(["docker", "rm", "-f", PG_CONTAINER], check=False)
        else:
            print("Keeping Docker containers because HERMES_E2E_KEEP=1")


if __name__ == "__main__":
    main()
