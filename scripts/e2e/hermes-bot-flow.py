#!/usr/bin/env python3
"""End-to-end smoke test for TheChat's native Hermes platform flow.

This starts Hermes Gateway from a source checkout and enables the TheChat
messaging platform adapter. It requires OPENROUTER_API_KEY from the repo root
.env unless a different Hermes provider is configured through env vars.
"""

from __future__ import annotations

import json
import os
import signal
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

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

BUN = os.environ.get("BUN") or shutil.which("bun") or str(Path.home() / ".bun/bin/bun")
PNPM = os.environ.get("PNPM") or shutil.which("pnpm") or "pnpm"
API_PORT = int(explicit_env_or_default("THECHAT_E2E_API_PORT", "3338"))
POSTGRES_PORT = int(explicit_env_or_default("THECHAT_E2E_POSTGRES_PORT", "15544"))
REDIS_PORT = int(explicit_env_or_default("THECHAT_E2E_REDIS_PORT", "16381"))
KEEP = os.environ.get("HERMES_E2E_KEEP") == "1"
PG_CONTAINER = os.environ.get("THECHAT_E2E_PG_CONTAINER", "thechat-hermes-e2e-postgres")
REDIS_CONTAINER = os.environ.get("THECHAT_E2E_REDIS_CONTAINER", "thechat-hermes-e2e-redis")
HERMES_SOURCE_DIR = Path(os.environ.get("HERMES_E2E_SOURCE_DIR", "/home/bruno/projects/hermes2"))
HERMES_HOME_ROOT = Path(os.environ.get("HERMES_E2E_HOME", str(ROOT / ".tmp" / "hermes-e2e-home")))
HERMES_LOG_ROOT = Path(os.environ.get("HERMES_E2E_LOG_DIR", str(ROOT / ".tmp")))
HERMES_GATEWAY_RUNTIME = ROOT / "scripts" / "e2e" / "run-hermes-gateway-runtime.py"
UV = os.environ.get("UV") or shutil.which("uv") or "uv"
DATABASE_URL = explicit_env_or_default(
    "THECHAT_E2E_DATABASE_URL",
    f"postgres://thechat:thechat@localhost:{POSTGRES_PORT}/thechat",
)
REDIS_URL = explicit_env_or_default("THECHAT_E2E_REDIS_URL", f"redis://localhost:{REDIS_PORT}")
HERMES_PROVIDER = os.environ.get("HERMES_E2E_PROVIDER") or os.environ.get("HERMES_PROVIDER") or "openrouter"
HERMES_MODEL = os.environ.get("HERMES_E2E_MODEL") or os.environ.get("HERMES_MODEL") or "deepseek/deepseek-v4-pro"


def run(cmd: list[str], *, check: bool = True, env: dict[str, str] | None = None, cwd: Path = ROOT) -> subprocess.CompletedProcess:
    print("$", " ".join(cmd), flush=True)
    return subprocess.run(cmd, cwd=cwd, env=env, text=True, check=check)


def output(cmd: list[str], *, env: dict[str, str] | None = None, cwd: Path = ROOT) -> str:
    print("$", " ".join(cmd), flush=True)
    return subprocess.check_output(cmd, cwd=cwd, env=env, text=True).strip()


def terminate_process(proc: subprocess.Popen | None, timeout: int = 15) -> None:
    """Terminate a tracked process and its dedicated process group."""
    if proc is None:
        return
    was_running = proc.poll() is None

    def send(sig: signal.Signals) -> None:
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            if proc.poll() is None:
                try:
                    proc.send_signal(sig)
                except ProcessLookupError:
                    pass

    send(signal.SIGTERM)
    if not was_running:
        return
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        send(signal.SIGKILL)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


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


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def db_json(sql: str):
    text = subprocess.check_output([
        "docker",
        "exec",
        PG_CONTAINER,
        "psql",
        "-U",
        "thechat",
        "-d",
        "thechat",
        "-t",
        "-A",
        "-c",
        sql,
    ], cwd=ROOT, text=True).strip()
    return json.loads(text or "null")


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


def start_redis():
    run(["docker", "rm", "-f", REDIS_CONTAINER], check=False)
    run([
        "docker",
        "run",
        "-d",
        "--name",
        REDIS_CONTAINER,
        "-p",
        f"127.0.0.1:{REDIS_PORT}:6379",
        "redis:7-alpine",
    ])
    wait_for(
        lambda: run(["docker", "exec", REDIS_CONTAINER, "redis-cli", "ping"], check=False).returncode == 0,
        timeout=30,
        label="Redis readiness",
    )


def slug(value: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-") or "bot"


def start_hermes_gateway(
    env: dict[str, str],
    base: str,
    bot_token: str,
    bot_name: str,
    *,
    approval_mode: str | None = None,
    approval_timeout: int | None = None,
    model_api_mode: str | None = None,
    model_base_url: str | None = None,
    additional_config: str | None = None,
    require_loopback_model: bool = False,
    isolate_runtime_environment: bool = False,
) -> subprocess.Popen:
    if not HERMES_SOURCE_DIR.exists():
        raise RuntimeError(f"Hermes source checkout not found: {HERMES_SOURCE_DIR}")
    if HERMES_PROVIDER == "openrouter" and not env.get("OPENROUTER_API_KEY", "").strip():
        raise RuntimeError("OPENROUTER_API_KEY is required for the Hermes e2e provider openrouter")
    if approval_mode not in {None, "manual", "smart", "off"}:
        raise ValueError(f"Unsupported approval mode: {approval_mode}")
    if require_loopback_model:
        parsed_model_url = urlparse(model_base_url or "")
        if (
            parsed_model_url.scheme not in {"http", "https"}
            or parsed_model_url.hostname not in {"127.0.0.1", "localhost", "::1"}
        ):
            raise ValueError(
                f"Hermes E2E model endpoint must be loopback: {model_base_url!r}"
            )
    if isolate_runtime_environment and not require_loopback_model:
        raise ValueError(
            "Hermes E2E runtime environment isolation requires loopback enforcement"
        )

    bot_slug = slug(bot_name)
    hermes_home = HERMES_HOME_ROOT / bot_slug
    hermes_log = HERMES_LOG_ROOT / f"hermes-e2e-gateway-{bot_slug}.log"
    if not KEEP and hermes_home.exists():
        shutil.rmtree(hermes_home)
    hermes_home.mkdir(parents=True, exist_ok=True)
    hermes_log.parent.mkdir(parents=True, exist_ok=True)
    provider_evidence = hermes_home / "e2e-provider-evidence.json"
    disabled_managed_dir = hermes_home / ".managed-scope-disabled"
    if isolate_runtime_environment and disabled_managed_dir.exists():
        raise RuntimeError(
            f"Hermes E2E disabled managed-scope path unexpectedly exists: {disabled_managed_dir}"
        )

    config_lines = [
        "model:",
        f"  provider: {HERMES_PROVIDER}",
        f"  default: {HERMES_MODEL}",
    ]
    if model_api_mode:
        config_lines.append(f"  api_mode: {model_api_mode}")
    if model_base_url:
        config_lines.append(f"  base_url: {model_base_url}")
    config_lines.extend([
        "streaming:",
        "  enabled: false",
    ])
    if approval_mode:
        config_lines.extend([
            "approvals:",
            f"  mode: {approval_mode}",
        ])
        if approval_timeout is not None:
            config_lines.append(f"  timeout: {approval_timeout}")
    if additional_config:
        config_lines.extend(additional_config.strip().splitlines())
    config_lines.append("")
    (hermes_home / "config.yaml").write_text("\n".join(config_lines))

    hermes_env = env | {
        "HERMES_HOME": str(hermes_home),
        "HERMES_INFERENCE_PROVIDER": HERMES_PROVIDER,
        "HERMES_INFERENCE_MODEL": HERMES_MODEL,
        "THECHAT_BASE_URL": base,
        "THECHAT_BOT_TOKEN": bot_token,
        "THECHAT_ALLOW_ALL_USERS": "true",
        "THECHAT_POLL_INTERVAL": "0.25",
        # The E2E harness exercises polling. Do not inherit a developer's live
        # webhook listener settings (commonly port 8765) into the isolated bot.
        "THECHAT_WEBHOOK_URL": "",
        "LOG_LEVEL": "info",
    }
    if isolate_runtime_environment:
        assert model_base_url is not None
        hermes_env.update(
            {
                "HERMES_E2E_DISABLE_RUNTIME_ENV": "1",
                "HERMES_E2E_EXPECTED_MODEL_BASE_URL": model_base_url,
                "HERMES_E2E_PROVIDER_EVIDENCE_PATH": str(provider_evidence),
                "HERMES_MANAGED_DIR": str(disabled_managed_dir),
                "CUSTOM_BASE_URL": model_base_url,
                "OPENAI_BASE_URL": model_base_url,
            }
        )
    log = hermes_log.open("w")
    try:
        proc = subprocess.Popen(
            [
                UV,
                "run",
                "--no-env-file",
                "--frozen",
                "python",
                "-u",
                str(HERMES_GATEWAY_RUNTIME),
            ],
            cwd=HERMES_SOURCE_DIR,
            env=hermes_env,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
    finally:
        log.close()

    def still_running():
        if proc.poll() is not None:
            try:
                tail = hermes_log.read_text(errors="replace")[-4000:]
            except Exception:
                tail = ""
            raise RuntimeError(f"Hermes gateway for {bot_name} exited with {proc.returncode}\n{tail}")
        return True

    def isolation_ready() -> bool:
        still_running()
        if not provider_evidence.exists():
            return False
        try:
            evidence = json.loads(provider_evidence.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Invalid Hermes E2E provider evidence: {exc}") from exc
        expected = {
            "provider": HERMES_PROVIDER,
            "baseUrl": (model_base_url or "").rstrip("/"),
            "requestedProvider": HERMES_PROVIDER,
            "model": HERMES_MODEL,
            "dotenvDisabled": True,
            "managedScope": False,
            "proxyKeys": ["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY"],
            "credentialKeys": ["OPENAI_API_KEY", "THECHAT_BOT_TOKEN"],
        }
        mismatches = {
            key: {"expected": value, "actual": evidence.get(key)}
            for key, value in expected.items()
            if evidence.get(key) != value
        }
        if mismatches:
            raise RuntimeError(f"Hermes E2E provider isolation mismatch: {mismatches}")
        return True

    try:
        if isolate_runtime_environment:
            wait_for(isolation_ready, timeout=20, label="Hermes provider isolation")
        else:
            time.sleep(3)
            still_running()
    except BaseException:
        terminate_process(proc)
        raise
    return proc


def start_api(env: dict[str, str]) -> subprocess.Popen:
    api_env = env | {
        "DATABASE_URL": DATABASE_URL,
        "REDIS_URL": REDIS_URL,
        "REALTIME_DRIVER": "redis",
        "REDIS_KEY_PREFIX": "thechat-hermes-e2e",
        "JWT_SECRET": "thechat-hermes-e2e-jwt-secret",
        "THECHAT_SECRET_KEY": "thechat-hermes-e2e-secret-key",
        "THECHAT_BACKEND_PORT": str(API_PORT),
        "LOG_LEVEL": "error",
    }
    proc = subprocess.Popen(
        [BUN, "run", "packages/api/src/index.ts"],
        cwd=ROOT,
        env=api_env,
        start_new_session=True,
    )
    try:
        wait_for(
            lambda: http_json("GET", f"http://localhost:{API_PORT}/health")[0]
            == 200,
            timeout=60,
            label="TheChat API",
        )
    except BaseException:
        terminate_process(proc, timeout=10)
        raise
    return proc


def start_worker(env: dict[str, str]) -> subprocess.Popen:
    """Start the bot worker and durable PostgreSQL event relay for E2E."""
    worker_env = env | {
        "DATABASE_URL": DATABASE_URL,
        "REDIS_URL": REDIS_URL,
        "REALTIME_DRIVER": "redis",
        "REDIS_KEY_PREFIX": "thechat-hermes-e2e",
        "JWT_SECRET": "thechat-hermes-e2e-jwt-secret",
        "THECHAT_SECRET_KEY": "thechat-hermes-e2e-secret-key",
        "LOG_LEVEL": "error",
    }
    proc = subprocess.Popen(
        [BUN, "run", "packages/api/src/scripts/worker.ts"],
        cwd=ROOT,
        env=worker_env,
        start_new_session=True,
    )
    try:
        time.sleep(1)
        if proc.poll() is not None:
            raise RuntimeError(f"TheChat worker exited early with {proc.returncode}")
    except BaseException:
        terminate_process(proc, timeout=10)
        raise
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
    assert bot["apiKey"].startswith("bot_"), bot
    assert "webhookSecret" not in bot

    status, config = http_json(
        "PATCH",
        f"{base}/bots/{bot['id']}/hermes",
        {
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
            if (
                content
                and not content.startswith("Hermes run failed:")
                and not content.startswith("⚠️")
                and not content.startswith("❌")
            ):
                return message
        return None

    return wait_for(find_message, timeout=timeout, label=f"{sender_name} bot response")


def wait_for_runtime_invocations(base: str, token: str, conversation_id: str, bot_name: str, count: int, *, timeout: int = 180):
    def find_snapshot():
        status, snapshot = http_json("GET", f"{base}/bot-runtime/conversations/{conversation_id}", token=token)
        if status != 200:
            return None
        invocations = [i for i in snapshot.get("invocations", []) if i.get("botName") == bot_name]
        if len(invocations) < count:
            return None
        if not all(i.get("status") in {"queued", "running", "claimed", "completed", "failed"} for i in invocations):
            return None
        return snapshot

    return wait_for(find_snapshot, timeout=timeout, label=f"{bot_name} runtime invocations")


def invocation_snapshot(conversation_id: str, bot_name: str, statuses: set[str] | None = None):
    status_clause = ""
    if statuses:
        status_values = ", ".join(sql_literal(status) for status in sorted(statuses))
        status_clause = f" and bi.status in ({status_values})"
    rows = db_json(
        """
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'id', bi.id,
              'botName', u.name,
              'conversationId', bi.conversation_id,
              'threadId', bi.thread_id,
              'triggerMessageId', bi.trigger_message_id,
              'responseMessageId', bi.response_message_id,
              'status', bi.status,
              'externalRunId', bi.external_run_id,
              'requestJson', bi.request_json,
              'responseJson', bi.response_json,
              'startedAt', bi.started_at,
              'completedAt', bi.completed_at,
              'createdAt', bi.created_at,
              'updatedAt', bi.updated_at
            )
            order by bi.created_at
          ),
          '[]'::jsonb
        )
        from bot_invocations bi
        inner join bots b on bi.bot_id = b.id
        inner join users u on b.user_id = u.id
        where bi.conversation_id = {conversation_id}
          and u.name = {bot_name}
          {status_clause}
        """.format(
            conversation_id=sql_literal(conversation_id),
            bot_name=sql_literal(bot_name),
            status_clause=status_clause,
        )
    )
    return {"invocations": rows}


def wait_for_invocations(conversation_id: str, bot_name: str, count: int, *, statuses: set[str] | None = None, require_external_run: bool = False, timeout: int = 180, label: str | None = None):
    def find_snapshot():
        snapshot = invocation_snapshot(conversation_id, bot_name, statuses)
        matches = snapshot.get("invocations", [])
        if require_external_run:
            matches = [i for i in matches if i.get("externalRunId")]
        return snapshot if len(matches) >= count else None

    return wait_for(find_snapshot, timeout=timeout, label=label or f"{bot_name} invocations")


def wait_for_completed_invocations(conversation_id: str, bot_name: str, count: int, *, timeout: int = 180):
    def find_snapshot():
        snapshot = invocation_snapshot(conversation_id, bot_name, {"claimed"})
        completed = []
        for invocation in snapshot.get("invocations", []):
            response = invocation.get("responseJson") or {}
            completion = response.get("completion") or {}
            if invocation.get("externalRunId") and (
                completion.get("type") in {"message", "silent", "failed", "cancelled"}
                or response.get("silent") is True
            ):
                completed.append(invocation)
        return snapshot if len(completed) >= count else None

    return wait_for(
        find_snapshot,
        timeout=timeout,
        label=f"{bot_name} claimed invocations with terminal execution metadata",
    )


def main():
    env = os.environ.copy()
    env["PATH"] = f"{Path(BUN).parent}:{env.get('PATH', '')}"
    env["DATABASE_URL"] = DATABASE_URL

    api_proc: subprocess.Popen | None = None
    worker_proc: subprocess.Popen | None = None
    hermes_procs: list[subprocess.Popen] = []
    try:
        start_postgres()
        start_redis()

        run([PNPM, "--dir", "packages/api", "exec", "drizzle-kit", "migrate"], env=env)
        api_proc = start_api(env)
        worker_proc = start_worker(env)

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
        hermes_procs.append(start_hermes_gateway(env, base, koda["apiKey"], koda["name"]))
        hermes_procs.append(start_hermes_gateway(env, base, nova["apiKey"], nova["name"]))

        status, detail = http_json("GET", f"{base}/workspaces/{workspace_id}", token=token)
        assert status == 200, (status, detail)
        channel_id = detail["channels"][0]["id"]
        bot_names = {m["user"]["name"] for m in detail["members"] if m["user"]["type"] == "bot"}
        assert {"Koda E2E", "Nova E2E"}.issubset(bot_names), bot_names
        bot_kinds = {m["user"]["name"]: m.get("bot", {}).get("kind") for m in detail["members"] if m["user"]["type"] == "bot"}
        assert bot_kinds["Koda E2E"] == "hermes", bot_kinds
        assert bot_kinds["Nova E2E"] == "hermes", bot_kinds

        status, sent = http_json("POST", f"{base}/messages/{channel_id}", {"content": "@Koda E2E answer this channel smoke test"}, token)
        assert status == 200, (status, sent)
        koda_channel = wait_for_bot_message(base, token, channel_id, "Koda E2E")
        koda_channel_runtime = wait_for_completed_invocations(channel_id, "Koda E2E", 1)

        status, sent = http_json("POST", f"{base}/messages/{channel_id}", {"content": "@Nova E2E answer this second channel smoke test"}, token)
        assert status == 200, (status, sent)
        nova_channel = wait_for_bot_message(base, token, channel_id, "Nova E2E")
        nova_channel_runtime = wait_for_completed_invocations(channel_id, "Nova E2E", 1)

        status, dm = http_json(
            "POST",
            f"{base}/conversations/dm",
            {"workspaceId": workspace_id, "otherUserId": koda["userId"]},
            token,
        )
        assert status == 200, (status, dm)
        dm_id = dm["id"]

        # The gateway registers its slash commands at connect (Telegram
        # setMyCommands-style); the DM detail exposes them for the client menu.
        status, dm_detail = http_json("GET", f"{base}/conversations/detail/{dm_id}", token=token)
        assert status == 200, (status, dm_detail)
        koda_bot = next(
            (p.get("bot") or {})
            for p in dm_detail["participants"]
            if (p.get("bot") or {}).get("kind") == "hermes"
        )
        registered_commands = {c["command"]: c for c in (koda_bot.get("commands") or [])}
        assert "help" in registered_commands, sorted(registered_commands)
        assert "new" in registered_commands, sorted(registered_commands)
        assert registered_commands["new"].get("aliases") == ["reset"], registered_commands["new"]
        assert registered_commands["new"].get("argsHint") == "[name]", registered_commands["new"]
        assert "start" not in registered_commands, sorted(registered_commands)

        status, sent = http_json("POST", f"{base}/messages/{dm_id}", {"content": "Answer this direct message smoke test without an at mention"}, token)
        assert status == 200, (status, sent)
        koda_dm_runtime_started = wait_for_invocations(dm_id, "Koda E2E", 1, statuses={"queued", "running", "claimed"})
        koda_dm = wait_for_bot_message(base, token, dm_id, "Koda E2E")
        koda_dm_runtime = wait_for_completed_invocations(dm_id, "Koda E2E", 1)
        koda_completed = [i for i in koda_dm_runtime.get("invocations", []) if i.get("status") == "claimed"]
        assert any(i.get("externalRunId") for i in koda_completed), koda_dm_runtime
        koda_request = koda_completed[0].get("requestJson") or {}
        assert koda_request.get("platform") == "thechat", koda_dm_runtime
        assert koda_request.get("conversationId") == dm_id, koda_dm_runtime

        status, sent = http_json("POST", f"{base}/messages/{dm_id}", {"content": "Answer this follow-up using the same session"}, token)
        assert status == 200, (status, sent)
        wait_for_invocations(dm_id, "Koda E2E", 2, statuses={"queued", "running", "claimed"})
        koda_dm_runtime_followup = wait_for_completed_invocations(dm_id, "Koda E2E", 2)
        koda_completed = [i for i in koda_dm_runtime_followup.get("invocations", []) if i.get("botName") == "Koda E2E" and i.get("status") == "claimed"]
        assert len(koda_completed) >= 2, koda_dm_runtime_followup
        assert all(
            (invocation.get("requestJson") or {}).get("conversationId") == dm_id
            for invocation in koda_completed
        ), koda_dm_runtime_followup

        time.sleep(3)
        status, dm_messages = http_json("GET", f"{base}/messages/{dm_id}", token=token)
        assert status == 200, (status, dm_messages)
        assert not any(m.get("senderName") == "Nova E2E" for m in dm_messages), dm_messages

        status, nova_dm = http_json(
            "POST",
            f"{base}/conversations/dm",
            {"workspaceId": workspace_id, "otherUserId": nova["userId"]},
            token,
        )
        assert status == 200, (status, nova_dm)
        assert nova_dm["id"] != dm_id, (dm_id, nova_dm)

        status, sent = http_json("POST", f"{base}/messages/{nova_dm['id']}", {"content": "Answer this Nova direct message smoke test"}, token)
        assert status == 200, (status, sent)
        nova_dm_message = wait_for_bot_message(base, token, nova_dm["id"], "Nova E2E")
        nova_dm_runtime = wait_for_completed_invocations(nova_dm["id"], "Nova E2E", 1)
        status, nova_dm_messages = http_json("GET", f"{base}/messages/{nova_dm['id']}", token=token)
        assert status == 200, (status, nova_dm_messages)
        assert any(m.get("senderName") == "Nova E2E" for m in nova_dm_messages), nova_dm_messages
        assert not any(m.get("senderName") == "Koda E2E" for m in nova_dm_messages), nova_dm_messages

        print(json.dumps({
            "ok": True,
            "workspaceId": workspace_id,
            "channelId": channel_id,
            "dmId": dm_id,
            "novaDmId": nova_dm["id"],
            "bots": [koda["name"], nova["name"]],
            "channelMessages": [koda_channel, nova_channel],
            "directMessages": [koda_dm, nova_dm_message],
            "runtime": {
                "kodaChannel": koda_channel_runtime,
                "novaChannel": nova_channel_runtime,
                "kodaDmStarted": koda_dm_runtime_started,
                "kodaDm": koda_dm_runtime_followup,
                "novaDm": nova_dm_runtime,
            },
        }, indent=2))
    finally:
        for hermes_proc in hermes_procs:
            terminate_process(hermes_proc)
        terminate_process(worker_proc, timeout=10)
        terminate_process(api_proc, timeout=10)
        if not KEEP:
            run(["docker", "rm", "-f", REDIS_CONTAINER], check=False)
            run(["docker", "rm", "-f", PG_CONTAINER], check=False)
        else:
            print(f"Keeping e2e resources because HERMES_E2E_KEEP=1; Hermes home root: {HERMES_HOME_ROOT}")


if __name__ == "__main__":
    main()
