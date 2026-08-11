#!/usr/bin/env python3
"""Opt-in real-process E2E for TheChat -> upstream Hermes JSON-RPC.

Uses the pinned upstream checkout (override with HERMES_RPC_UPSTREAM_PATH), an
isolated uv environment/HERMES_HOME, disposable Postgres + Redis containers,
and a loopback-only deterministic inference fixture.
"""

from __future__ import annotations

import importlib.util
import json
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = Path(
    os.environ.get(
        "HERMES_RPC_UPSTREAM_PATH",
        "/workspace/thechat-hermes-rpc/src/hermes-upstream",
    )
).resolve()
EXPECTED_UPSTREAM_SHA = "c0106e50e7ecedb3ce34e785d949725dc4e0e457"
RUN_ID = f"{os.getpid()}-{time.time_ns()}"
TEMP_ROOT = Path(tempfile.mkdtemp(prefix=f"thechat-hermes-rpc-e2e-{RUN_ID}-"))
PORTS = {name: 0 for name in ("api", "postgres", "redis", "hermes", "model")}


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


for _name in PORTS:
    PORTS[_name] = free_port()

os.environ.update(
    {
        "THECHAT_E2E_API_PORT": str(PORTS["api"]),
        "THECHAT_E2E_POSTGRES_PORT": str(PORTS["postgres"]),
        "THECHAT_E2E_REDIS_PORT": str(PORTS["redis"]),
        "THECHAT_E2E_DATABASE_URL": f"postgres://thechat:thechat@127.0.0.1:{PORTS['postgres']}/thechat",
        "THECHAT_E2E_REDIS_URL": f"redis://127.0.0.1:{PORTS['redis']}",
        "THECHAT_E2E_PG_CONTAINER": f"thechat-hermes-rpc-e2e-pg-{RUN_ID}",
        "THECHAT_E2E_REDIS_CONTAINER": f"thechat-hermes-rpc-e2e-redis-{RUN_ID}",
        "THECHAT_E2E_CONTAINER_LABEL": f"thechat.e2e.run={RUN_ID}",
        "HERMES_E2E_SOURCE_DIR": str(UPSTREAM),
        "HERMES_E2E_HOME": str(TEMP_ROOT / "unused-legacy-home"),
        "HERMES_E2E_LOG_DIR": str(TEMP_ROOT / "logs"),
        "HERMES_E2E_PROVIDER": "custom",
        "HERMES_E2E_MODEL": "hermes-rpc-e2e",
    }
)

_helper_spec = importlib.util.spec_from_file_location(
    "thechat_hermes_e2e_helpers",
    ROOT / "scripts/e2e/hermes-bot-flow.py",
)
if _helper_spec is None or _helper_spec.loader is None:
    raise RuntimeError("Could not load TheChat E2E helpers")
harness = importlib.util.module_from_spec(_helper_spec)
_helper_spec.loader.exec_module(harness)


def safe_env() -> dict[str, str]:
    allowed = {
        "HOME",
        "LANG",
        "LC_ALL",
        "LD_LIBRARY_PATH",
        "LOGNAME",
        "PATH",
        "SHELL",
        "TERM",
        "TMPDIR",
        "USER",
        "UV_CACHE_DIR",
    }
    env = {key: value for key, value in os.environ.items() if key in allowed}
    env.update(
        {
            "PATH": f"{Path(harness.BUN).parent}:{env.get('PATH', '')}",
            "DATABASE_URL": harness.DATABASE_URL,
            "NO_PROXY": "127.0.0.1,localhost,::1",
            "no_proxy": "127.0.0.1,localhost,::1",
        }
    )
    return env


def start_logged(
    command: list[str],
    log_path: Path,
    *,
    env: dict[str, str],
    cwd: Path = ROOT,
) -> subprocess.Popen[Any]:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log = log_path.open("w", encoding="utf-8")
    try:
        return subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
    finally:
        log.close()


def process_alive(proc: subprocess.Popen[Any], log_path: Path, label: str) -> bool:
    if proc.poll() is None:
        return True
    tail = log_path.read_text(encoding="utf-8", errors="replace")[-4_000:]
    raise RuntimeError(f"{label} exited with {proc.returncode}:\n{tail}")


def tcp_ready(proc: subprocess.Popen[Any], log_path: Path, port: int, label: str) -> bool:
    process_alive(proc, log_path, label)
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def wait_process_port(
    proc: subprocess.Popen[Any], log_path: Path, port: int, label: str, timeout: int
) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if tcp_ready(proc, log_path, port, label):
            return
        time.sleep(0.5)
    raise RuntimeError(f"Timed out waiting for {label} on an isolated port")


def start_model(env: dict[str, str]) -> tuple[subprocess.Popen[Any], Path]:
    log_path = TEMP_ROOT / "model.log"
    proc = start_logged(
        [
            "python3",
            str(ROOT / "scripts/e2e/fake-openai-hermes-rpc-server.py"),
            "--port",
            str(PORTS["model"]),
        ],
        log_path,
        env=env,
    )
    harness.wait_for(
        lambda: harness.http_json("GET", f"http://127.0.0.1:{PORTS['model']}/health")[0] == 200,
        timeout=30,
        label="deterministic local inference server",
    )
    return proc, log_path


def start_upstream(env: dict[str, str], gateway_token: str) -> tuple[subprocess.Popen[Any], Path]:
    actual_sha = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=UPSTREAM, text=True
    ).strip()
    if actual_sha != EXPECTED_UPSTREAM_SHA:
        raise RuntimeError(f"Pinned upstream mismatch: expected {EXPECTED_UPSTREAM_SHA}, got {actual_sha}")

    hermes_home = TEMP_ROOT / "hermes-home"
    hermes_home.mkdir(mode=0o700)
    (hermes_home / "config.yaml").write_text(
        "\n".join(
            [
                "model:",
                "  provider: custom",
                "  default: hermes-rpc-e2e",
                "  api_mode: chat_completions",
                f"  base_url: http://127.0.0.1:{PORTS['model']}/v1",
                "streaming:",
                "  enabled: true",
                "approvals:",
                "  mode: off",
                "terminal:",
                "  backend: local",
                "security:",
                "  tirith_enabled: false",
                "auxiliary:",
                "  title_generation:",
                "    enabled: false",
                "agent:",
                "  environment_probe: false",
                "",
            ]
        ),
        encoding="utf-8",
    )
    uv_env = env | {
        "HERMES_HOME": str(hermes_home),
        "UV_PROJECT_ENVIRONMENT": str(TEMP_ROOT / "upstream-venv"),
        "UV_PYTHON": shutil.which("python3") or "python3",
        "UV_NO_MANAGED_PYTHON": "1",
    }
    # Hydrate the immutable lockfile without installing the source project.
    # The actual serve process below is then `--no-sync` and egress-isolated.
    sync_command = [harness.UV, "sync", "--frozen", "--no-install-project"]
    print("$", harness.format_command(sync_command), flush=True)
    subprocess.run(
        sync_command,
        env=uv_env,
        cwd=UPSTREAM,
        check=True,
        timeout=300,
    )
    upstream_env = uv_env | {
        "HERMES_DASHBOARD_SESSION_TOKEN": gateway_token,
        "HERMES_INFERENCE_PROVIDER": "custom",
        "HERMES_INFERENCE_MODEL": "hermes-rpc-e2e",
        "OPENROUTER_API_KEY": "local-e2e-only",
        "OPENAI_API_KEY": "local-e2e-only",
        "OPENAI_BASE_URL": f"http://127.0.0.1:{PORTS['model']}/v1",
        "CUSTOM_BASE_URL": f"http://127.0.0.1:{PORTS['model']}/v1",
        "TERMINAL_ENV": "local",
        "HERMES_YOLO_MODE": "1",
        "TIRITH_ENABLED": "0",
        "ALL_PROXY": "http://127.0.0.1:9",
        "HTTP_PROXY": "http://127.0.0.1:9",
        "HTTPS_PROXY": "http://127.0.0.1:9",
        "LOG_LEVEL": "info",
    }
    log_path = TEMP_ROOT / "upstream-hermes.log"
    proc = start_logged(
        [
            harness.UV,
            "run",
            "--no-sync",
            "python",
            "-u",
            str(UPSTREAM / "hermes"),
            "serve",
            "--isolated",
            "--host",
            "127.0.0.1",
            "--port",
            str(PORTS["hermes"]),
        ],
        log_path,
        env=upstream_env,
        cwd=UPSTREAM,
    )
    wait_process_port(
        proc,
        log_path,
        PORTS["hermes"],
        "pinned upstream hermes serve",
        timeout=120,
    )
    return proc, log_path


def start_realtime_observer(
    env: dict[str, str], base: str, token: str
) -> tuple[subprocess.Popen[Any], Path]:
    log_path = TEMP_ROOT / "thechat-realtime.jsonl"
    script = r"""
const base = process.env.E2E_BASE;
const token = process.env.E2E_TOKEN;
const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
ws.onmessage = (message) => {
  const event = JSON.parse(String(message.data));
  if (event.type === "auth_ok") console.log(JSON.stringify({ type: "auth_ok" }));
  if (event.type === "bot_invocation_progress") console.log(JSON.stringify({ type: event.type, eventType: event.event?.type, invocationId: event.invocationId }));
  if (event.type === "bot_invocation_updated") console.log(JSON.stringify({ type: event.type, status: event.invocation?.status, invocationId: event.invocation?.id }));
  if (event.type === "new_message") console.log(JSON.stringify({ type: event.type, senderName: event.message?.senderName, content: event.message?.content }));
};
setInterval(() => {}, 1000);
"""
    proc = start_logged(
        [harness.BUN, "-e", script],
        log_path,
        env=env | {"E2E_BASE": base, "E2E_TOKEN": token},
    )
    harness.wait_for(
        lambda: any(event.get("type") == "auth_ok" for event in read_json_lines(log_path)),
        timeout=20,
        label="authenticated TheChat realtime observer",
    )
    return proc, log_path


def read_json_lines(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    parsed: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            parsed.append(value)
    return parsed


def wait_for_bot_messages(base: str, token: str, conversation_id: str, count: int):
    def predicate():
        status, messages = harness.http_json(
            "GET", f"{base}/messages/{conversation_id}", token=token
        )
        if status != 200:
            return None
        matches = [
            message
            for message in messages
            if message.get("senderName") == "Hermes RPC E2E"
            and "Hermes RPC real E2E completed" in message.get("content", "")
        ]
        return matches if len(matches) >= count else None

    return harness.wait_for(predicate, timeout=180, label=f"{count} final Hermes RPC messages")


def main() -> None:
    env = safe_env()
    api_proc = worker_proc = model_proc = upstream_proc = observer_proc = None
    gateway_token = secrets.token_urlsafe(32)
    completed = False
    try:
        harness.start_postgres(env=env)
        harness.start_redis(env=env)
        harness.run(
            [harness.PNPM, "--dir", "packages/api", "exec", "drizzle-kit", "migrate"],
            env=env,
        )
        api_proc = harness.start_api(env)
        worker_proc = harness.start_worker(env)
        model_proc, _ = start_model(env)
        upstream_proc, upstream_log = start_upstream(env, gateway_token)

        base = f"http://127.0.0.1:{PORTS['api']}"
        status, registration = harness.http_json(
            "POST",
            f"{base}/auth/register",
            {
                "name": "Hermes RPC E2E Owner",
                "email": f"hermes-rpc-e2e-{RUN_ID}@example.com",
                "password": "password123",
            },
        )
        assert status == 200, (status, registration)
        token = registration["accessToken"]
        status, workspace = harness.http_json(
            "POST", f"{base}/workspaces/create", {"name": f"Hermes RPC E2E {RUN_ID}"}, token
        )
        assert status == 200, (status, workspace)
        status, bot = harness.http_json(
            "POST",
            f"{base}/bots/create",
            {
                "kind": "hermes-rpc",
                "workspaceId": workspace["id"],
                "name": "Hermes RPC E2E",
                "hermesRpc": {
                    "endpoint": f"http://127.0.0.1:{PORTS['hermes']}",
                    "gatewayToken": gateway_token,
                },
            },
            token,
        )
        assert status == 200, (status, bot)
        assert bot["kind"] == "hermes-rpc", bot
        assert "apiKey" not in bot and "webhookSecret" not in bot, bot
        assert gateway_token not in json.dumps(bot), bot

        status, dm = harness.http_json(
            "POST",
            f"{base}/conversations/dm",
            {"workspaceId": workspace["id"], "otherUserId": bot["userId"]},
            token,
        )
        assert status == 200, (status, dm)
        conversation_id = dm["id"]
        observer_proc, observer_log = start_realtime_observer(env, base, token)

        status, connection = harness.http_json(
            "POST", f"{base}/bots/{bot['id']}/hermes-rpc/test", {}, token
        )
        assert status == 200, (status, connection)
        assert connection["gatewayReady"] is True, connection
        assert connection["sessionListAvailable"] is True, connection
        assert connection["gatewayTokenConfigured"] is True, connection
        assert gateway_token not in json.dumps(connection), connection

        status, initial_sessions = harness.http_json(
            "GET",
            f"{base}/bots/{bot['id']}/hermes-rpc/sessions?conversationId={conversation_id}",
            token=token,
        )
        assert status == 200, (status, initial_sessions)

        status, sent = harness.http_json(
            "POST",
            f"{base}/messages/{conversation_id}",
            {"content": "HERMES_RPC_REAL_E2E run the deterministic terminal check"},
            token,
        )
        assert status == 200, (status, sent)
        first_messages = wait_for_bot_messages(base, token, conversation_id, 1)

        required_progress = {"message.started", "tool.started", "tool.completed", "message.completed"}

        def progress_evidence():
            event_types = {
                event.get("eventType")
                for event in read_json_lines(observer_log)
                if event.get("type") == "bot_invocation_progress"
            }
            return event_types if required_progress.issubset(event_types) else None

        observed_progress = harness.wait_for(
            progress_evidence,
            timeout=60,
            label="TheChat realtime message/tool lifecycle fanout",
        )

        def listed_session():
            session_status, body = harness.http_json(
                "GET",
                f"{base}/bots/{bot['id']}/hermes-rpc/sessions?conversationId={conversation_id}",
                token=token,
            )
            return body["sessions"][0] if session_status == 200 and body.get("sessions") else None

        session = harness.wait_for(listed_session, timeout=60, label="created upstream session.list row")
        assert session["linked"] is True and session["threadId"] is None, session
        selections = []
        for _ in range(2):
            status, selected = harness.http_json(
                "POST",
                f"{base}/bots/{bot['id']}/hermes-rpc/sessions/select",
                {"conversationId": conversation_id, "upstreamSessionId": session["id"]},
                token,
            )
            assert status == 200, (status, selected)
            selections.append(selected)
        assert selections[0]["session"]["id"] == selections[1]["session"]["id"] == session["id"]
        assert selections[0]["thread"] is None and selections[1]["thread"] is None

        participant_email = f"hermes-rpc-e2e-participant-{RUN_ID}@example.com"
        status, participant_registration = harness.http_json(
            "POST",
            f"{base}/auth/register",
            {
                "name": "Hermes RPC E2E Participant",
                "email": participant_email,
                "password": "password123",
            },
        )
        assert status == 200, (status, participant_registration)
        participant_token = participant_registration["accessToken"]
        status, invite = harness.http_json(
            "POST",
            f"{base}/invites/create",
            {"workspaceId": workspace["id"], "email": participant_email},
            token,
        )
        assert status == 200, (status, invite)
        status, accepted = harness.http_json(
            "POST",
            f"{base}/invites/accept",
            {"inviteId": invite["id"]},
            participant_token,
        )
        assert status == 200 and accepted["success"] is True, (status, accepted)
        status, participant_dm = harness.http_json(
            "POST",
            f"{base}/conversations/dm",
            {"workspaceId": workspace["id"], "otherUserId": bot["userId"]},
            participant_token,
        )
        assert status == 200, (status, participant_dm)
        participant_conversation_id = participant_dm["id"]
        assert participant_conversation_id != conversation_id

        status, empty_participant_catalog = harness.http_json(
            "GET",
            f"{base}/bots/{bot['id']}/hermes-rpc/sessions?conversationId={participant_conversation_id}",
            token=participant_token,
        )
        assert status == 200 and empty_participant_catalog["sessions"] == [], (
            status,
            empty_participant_catalog,
        )
        status, concealed_owner_session = harness.http_json(
            "POST",
            f"{base}/bots/{bot['id']}/hermes-rpc/sessions/select",
            {
                "conversationId": participant_conversation_id,
                "upstreamSessionId": session["id"],
            },
            participant_token,
        )
        assert status == 404, (status, concealed_owner_session)

        status, participant_sent = harness.http_json(
            "POST",
            f"{base}/messages/{participant_conversation_id}",
            {
                "content": (
                    "HERMES_RPC_REAL_E2E create my isolated durable Hermes RPC session"
                )
            },
            participant_token,
        )
        assert status == 200, (status, participant_sent)
        wait_for_bot_messages(
            base,
            participant_token,
            participant_conversation_id,
            1,
        )

        def participant_session_visible():
            session_status, body = harness.http_json(
                "GET",
                f"{base}/bots/{bot['id']}/hermes-rpc/sessions?conversationId={participant_conversation_id}",
                token=participant_token,
            )
            visible = body.get("sessions", []) if session_status == 200 else []
            return visible if len(visible) == 1 and visible[0].get("linked") else None

        participant_sessions = harness.wait_for(
            participant_session_visible,
            timeout=60,
            label="participant-scoped linked session",
        )
        participant_session = participant_sessions[0]
        assert participant_session["id"] != session["id"], participant_sessions
        assert participant_session["threadId"] is None, participant_session

        status, still_concealed = harness.http_json(
            "POST",
            f"{base}/bots/{bot['id']}/hermes-rpc/sessions/select",
            {
                "conversationId": participant_conversation_id,
                "upstreamSessionId": session["id"],
            },
            participant_token,
        )
        assert status == 404, (status, still_concealed)

        status, followup = harness.http_json(
            "POST",
            f"{base}/messages/{conversation_id}",
            {"content": "Continue in the selected stored upstream session."},
            token,
        )
        assert status == 200, (status, followup)
        final_messages = wait_for_bot_messages(base, token, conversation_id, 2)

        link_count = harness.db_json(
            f"select count(*) from hermes_rpc_session_links where bot_id = {harness.sql_literal(bot['id'])}"
        )
        assert int(link_count) == 2, link_count
        per_conversation_links = harness.db_json(
            """
            select jsonb_object_agg(conversation_id::text, link_count)
            from (
              select conversation_id, count(*) as link_count
              from hermes_rpc_session_links
              where bot_id = {bot_id}
              group by conversation_id
            ) links
            """.format(bot_id=harness.sql_literal(bot["id"]))
        )
        assert per_conversation_links == {
            conversation_id: 1,
            participant_conversation_id: 1,
        }, per_conversation_links
        invocation_rows = harness.db_json(
            """
            select coalesce(jsonb_agg(jsonb_build_object(
              'status', status,
              'adapterKind', adapter_kind,
              'externalRunId', external_run_id,
              'responseJson', response_json
            ) order by created_at), '[]'::jsonb)
            from bot_invocations
            where conversation_id = {conversation_id}
            """.format(conversation_id=harness.sql_literal(conversation_id))
        )
        assert len(invocation_rows) == 2, invocation_rows
        assert all(row["status"] == "completed" for row in invocation_rows), invocation_rows
        assert all(row["adapterKind"] == "hermes-rpc" for row in invocation_rows), invocation_rows
        assert all(row["externalRunId"] for row in invocation_rows), invocation_rows
        assert all(
            (row["responseJson"] or {}).get("upstreamSessionId") == session["id"]
            for row in invocation_rows
        ), invocation_rows

        model_status, model_state = harness.http_json(
            "GET", f"http://127.0.0.1:{PORTS['model']}/state"
        )
        assert model_status == 200, (model_status, model_state)
        assert model_state["toolCalls"] == 2, model_state
        assert model_state["finals"] >= 3, model_state

        realtime = read_json_lines(observer_log)
        assert any(
            event.get("type") == "new_message"
            and event.get("senderName") == "Hermes RPC E2E"
            and "Hermes RPC real E2E completed" in event.get("content", "")
            for event in realtime
        ), realtime

        print(
            json.dumps(
                {
                    "ok": True,
                    "realUpstream": True,
                    "upstreamSha": EXPECTED_UPSTREAM_SHA,
                    "gatewayReadyViaTheChat": connection["gatewayReady"],
                    "sessionListViaTheChat": True,
                    "createdSelectedResumedSessionId": session["id"],
                    "isolatedLinkCount": int(link_count),
                    "crossDmOwnerSessionDenied": True,
                    "participantLinkedSessionId": participant_session["id"],
                    "realtimeProgressTypes": sorted(observed_progress),
                    "finalBotMessages": [message["content"] for message in final_messages],
                    "modelState": model_state,
                    "isolatedPorts": PORTS,
                    "upstreamLog": str(upstream_log),
                },
                indent=2,
            )
        )
        completed = True
    finally:
        for proc in (observer_proc, upstream_proc, model_proc, worker_proc, api_proc):
            harness.terminate_process(proc, timeout=15)
        harness.run(["docker", "rm", "-f", harness.REDIS_CONTAINER], check=False, env=env)
        harness.run(["docker", "rm", "-f", harness.PG_CONTAINER], check=False, env=env)
        keep = os.environ.get("HERMES_RPC_E2E_KEEP") == "1"
        if not keep:
            shutil.rmtree(TEMP_ROOT, ignore_errors=True)
        elif not completed:
            print(f"Retained failed E2E diagnostics at {TEMP_ROOT}")


if __name__ == "__main__":
    main()
