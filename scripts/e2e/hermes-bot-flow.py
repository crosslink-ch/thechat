#!/usr/bin/env python3
"""End-to-end smoke test for TheChat's native Hermes bot flow.

This uses the real Nous Hermes Agent Docker image. It requires a provider key
for the configured model, normally OPENROUTER_API_KEY from the repo root .env.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENV_BEFORE_DOTENV = set(os.environ)


def load_dotenv(path: Path = ROOT / ".env") -> None:
    """Load simple KEY=VALUE entries from .env without overriding existing env vars."""
    if not path.exists():
        return
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[key] = value


load_dotenv()


def explicit_env_or_default(key: str, default: str) -> str:
    value = os.environ.get(key, "")
    if key in ENV_BEFORE_DOTENV and value:
        return value
    return default

BUN = os.environ.get("BUN", str(Path.home() / ".bun/bin/bun"))
PNPM = os.environ.get("PNPM", "pnpm")
API_PORT = int(explicit_env_or_default("THECHAT_E2E_API_PORT", "3338"))
POSTGRES_PORT = int(explicit_env_or_default("THECHAT_E2E_POSTGRES_PORT", "15544"))
HERMES_PORT = int(explicit_env_or_default("THECHAT_E2E_HERMES_PORT", "18643"))
HERMES_DASHBOARD_PORT = int(explicit_env_or_default("THECHAT_E2E_HERMES_DASHBOARD_PORT", "19120"))
KEEP = os.environ.get("HERMES_E2E_KEEP") == "1"
PG_CONTAINER = os.environ.get("THECHAT_E2E_PG_CONTAINER", "thechat-hermes-e2e-postgres")
HERMES_CONTAINER = os.environ.get("THECHAT_E2E_HERMES_CONTAINER", "thechat-hermes-e2e")
DATABASE_URL = explicit_env_or_default(
    "THECHAT_E2E_DATABASE_URL",
    f"postgres://thechat:thechat@localhost:{POSTGRES_PORT}/thechat",
)
HERMES_API_KEY = (
    os.environ.get("HERMES_E2E_API_KEY")
    or os.environ.get("HERMES_API_KEY")
    or "thechat-hermes-e2e-key"
)
HERMES_PROVIDER = os.environ.get("HERMES_E2E_PROVIDER") or os.environ.get("HERMES_PROVIDER") or "openrouter"
HERMES_MODEL = os.environ.get("HERMES_E2E_MODEL") or os.environ.get("HERMES_MODEL") or "deepseek/deepseek-v4-pro"


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


def start_hermes():
    script = ROOT / "scripts" / "start-hermes-docker.sh"
    env = os.environ.copy()
    env.update({
        "HERMES_CONTAINER": HERMES_CONTAINER,
        "HERMES_PORT": str(HERMES_PORT),
        "HERMES_DASHBOARD_PORT": str(HERMES_DASHBOARD_PORT),
        "HERMES_API_KEY": HERMES_API_KEY,
        "HERMES_PROVIDER": HERMES_PROVIDER,
        "HERMES_MODEL": HERMES_MODEL,
        "HERMES_DATA_DIR": os.environ.get("HERMES_E2E_DATA_DIR", str(Path.home() / ".hermes-thechat-e2e")),
        "THECHAT_ENV_FILE": str(ROOT / ".env"),
    })
    if os.environ.get("HERMES_E2E_IMAGE"):
        env["HERMES_IMAGE"] = os.environ["HERMES_E2E_IMAGE"]
    run([str(script)], env=env)


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


def create_hermes_bot(base: str, token: str, workspace_id: str, name: str, instructions: str):
    status, bot = http_json(
        "POST",
        f"{base}/bots/create",
        {
            "kind": "hermes",
            "workspaceId": workspace_id,
            "name": name,
        },
        token,
    )
    assert status == 200, (status, bot)
    assert bot["kind"] == "hermes"
    assert bot["name"] == name
    assert "apiKey" not in bot

    status, config = http_json(
        "PATCH",
        f"{base}/bots/{bot['id']}/hermes",
        {
            "baseUrl": f"http://localhost:{HERMES_PORT}",
            "apiKey": HERMES_API_KEY,
            "defaultInstructions": instructions,
        },
        token,
    )
    assert status == 200, (status, config)
    assert "apiKey" not in config
    return bot


def wait_for_bot_message(base: str, token: str, conversation_id: str, sender_name: str, *, timeout: int = 180):
    def find_message():
        status, messages = http_json("GET", f"{base}/messages/{conversation_id}", token=token)
        if status != 200:
            return None
        for message in messages:
            if message.get("senderName") != sender_name:
                continue
            content = message.get("content", "").strip()
            if content and not content.startswith("Hermes run failed:"):
                return message
        return None

    return wait_for(find_message, timeout=timeout, label=f"{sender_name} bot response")


def main():
    env = os.environ.copy()
    env["PATH"] = f"{Path(BUN).parent}:{env.get('PATH', '')}"
    env["DATABASE_URL"] = DATABASE_URL

    api_proc: subprocess.Popen | None = None
    try:
        start_postgres()
        start_hermes()

        run([PNPM, "--dir", "packages/api", "exec", "drizzle-kit", "migrate"], env=env)
        api_proc = start_api(env)

        base = f"http://localhost:{API_PORT}"
        email = f"hermes-e2e-{int(time.time())}@example.com"
        status, register = http_json("POST", f"{base}/auth/register", {"name": "Hermes E2E", "email": email, "password": "password123"})
        assert status == 200, (status, register)
        token = register["accessToken"]

        status, workspace = http_json("POST", f"{base}/workspaces/create", {"name": "Hermes E2E Workspace"}, token)
        assert status == 200, (status, workspace)
        workspace_id = workspace["id"]

        koda = create_hermes_bot(
            base,
            token,
            workspace_id,
            "Koda E2E",
            "You are Koda E2E. Reply in one short sentence.",
        )
        nova = create_hermes_bot(
            base,
            token,
            workspace_id,
            "Nova E2E",
            "You are Nova E2E. Reply in one short sentence.",
        )

        status, detail = http_json("GET", f"{base}/workspaces/{workspace_id}", token=token)
        assert status == 200, (status, detail)
        channel_id = detail["channels"][0]["id"]
        bot_names = {m["user"]["name"] for m in detail["members"] if m["user"]["type"] == "bot"}
        assert {"Koda E2E", "Nova E2E"}.issubset(bot_names), bot_names

        status, sent = http_json("POST", f"{base}/messages/{channel_id}", {"content": "@Koda E2E answer this channel smoke test"}, token)
        assert status == 200, (status, sent)
        koda_channel = wait_for_bot_message(base, token, channel_id, "Koda E2E")

        status, sent = http_json("POST", f"{base}/messages/{channel_id}", {"content": "@Nova E2E answer this second channel smoke test"}, token)
        assert status == 200, (status, sent)
        nova_channel = wait_for_bot_message(base, token, channel_id, "Nova E2E")

        status, dm = http_json(
            "POST",
            f"{base}/conversations/dm",
            {"workspaceId": workspace_id, "otherUserId": koda["userId"]},
            token,
        )
        assert status == 200, (status, dm)
        dm_id = dm["id"]

        status, sent = http_json("POST", f"{base}/messages/{dm_id}", {"content": "Answer this direct message smoke test without an at mention"}, token)
        assert status == 200, (status, sent)
        koda_dm = wait_for_bot_message(base, token, dm_id, "Koda E2E")
        time.sleep(3)
        status, dm_messages = http_json("GET", f"{base}/messages/{dm_id}", token=token)
        assert status == 200, (status, dm_messages)
        assert not any(m.get("senderName") == "Nova E2E" for m in dm_messages), dm_messages

        print(json.dumps({
            "ok": True,
            "workspaceId": workspace_id,
            "channelId": channel_id,
            "dmId": dm_id,
            "bots": [koda["name"], nova["name"]],
            "channelMessages": [koda_channel, nova_channel],
            "directMessage": koda_dm,
        }, indent=2))
    finally:
        if api_proc:
            api_proc.send_signal(signal.SIGTERM)
            try:
                api_proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                api_proc.kill()
        if not KEEP:
            run(["docker", "rm", "-f", HERMES_CONTAINER], check=False)
            run(["docker", "rm", "-f", PG_CONTAINER], check=False)
        else:
            print("Keeping Docker containers because HERMES_E2E_KEEP=1")


if __name__ == "__main__":
    main()
