#!/usr/bin/env python3
"""Real Hermes -> TheChat bot requests end-to-end test (API level).

Everything is real except the model: a source checkout of the Hermes Gateway,
TheChat API and worker, PostgreSQL and Redis. The deterministic fake model asks
for one dangerous terminal command and one multi-select clarify.

Scenario 1, webhook mode: the approval and the question appear as open bot
requests in the person's Inbox. Answering "Always allow" and the question
through the human API wakes Hermes (answers are pushed through the outbox),
Hermes acknowledges both as applied, persists the permanent allowlist entry and
finishes the run.

Scenario 2, polling mode: Hermes is killed while its approval is open. A new
gateway process with the same bot token cancels the stale request on startup
("Hermes restarted. Ask again."), so no answerable dead card is left.
"""

from __future__ import annotations

import importlib.util
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from types import ModuleType
from typing import Any

E2E_HELPER_DIR = Path(__file__).resolve().parent
if str(E2E_HELPER_DIR) not in sys.path:
    sys.path.insert(0, str(E2E_HELPER_DIR))

from e2e_run import (  # noqa: E402
    acquire_owned_directory,
    allocate_loopback_port,
    generate_run_id,
    refuse_port_collision,
    validate_run_id,
)

ROOT = Path(__file__).resolve().parents[2]
RUN_ID = validate_run_id(os.environ.get("THECHAT_E2E_RUN_ID") or generate_run_id("requests"))
os.environ["THECHAT_E2E_RUN_ID"] = RUN_ID
TMP = Path(
    os.environ.get(
        "HERMES_REQUESTS_E2E_ROOT",
        str(Path.home() / ".cache" / "thechat-e2e" / "hermes-bot-requests" / RUN_ID),
    )
).resolve()

os.environ.setdefault("THECHAT_E2E_API_PORT", str(allocate_loopback_port()))
os.environ.setdefault("THECHAT_E2E_POSTGRES_PORT", str(allocate_loopback_port()))
os.environ.setdefault("THECHAT_E2E_REDIS_PORT", str(allocate_loopback_port()))
os.environ.setdefault(
    "THECHAT_E2E_DATABASE_URL",
    f"postgres://thechat:thechat@localhost:{os.environ['THECHAT_E2E_POSTGRES_PORT']}/thechat",
)
os.environ.setdefault("THECHAT_E2E_REDIS_URL", f"redis://localhost:{os.environ['THECHAT_E2E_REDIS_PORT']}")
os.environ["THECHAT_E2E_PG_CONTAINER"] = f"thechat-hermes-requests-e2e-postgres-{RUN_ID}"
os.environ["THECHAT_E2E_REDIS_CONTAINER"] = f"thechat-hermes-requests-e2e-redis-{RUN_ID}"
os.environ.setdefault("HERMES_E2E_PROVIDER", "custom")
os.environ.setdefault("HERMES_E2E_MODEL", "hermes-approval-e2e")
os.environ["HERMES_E2E_HOME"] = str(TMP / "hermes-home")
os.environ["HERMES_E2E_LOG_DIR"] = str(TMP / "hermes-logs")
_sibling_hermes = ROOT.parent / "hermes-agent"
if _sibling_hermes.exists():
    os.environ.setdefault("HERMES_E2E_SOURCE_DIR", str(_sibling_hermes))

MODEL_PORT = int(os.environ.get("HERMES_REQUESTS_E2E_MODEL_PORT", str(allocate_loopback_port())))
WEBHOOK_PORT = int(os.environ.get("HERMES_REQUESTS_E2E_WEBHOOK_PORT", str(allocate_loopback_port())))
WEBHOOK_URL = f"http://127.0.0.1:{WEBHOOK_PORT}/thechat/webhook"
KEEP = os.environ.get("HERMES_E2E_KEEP") == "1"


def _load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load E2E helper: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


harness = _load_module("thechat_hermes_bot_flow", ROOT / "scripts/e2e/hermes-bot-flow.py")
fake_model = _load_module(
    "thechat_fake_openai_approval_server", ROOT / "scripts/e2e/fake-openai-approval-server.py")
TRIGGER_MESSAGE = f"{fake_model.TRIGGER_MARKER}: run the deterministic terminal check now"
_SAFE_ENV_KEYS = {"HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "USER", "UV_CACHE_DIR"}


def _safe_child_env() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key in _SAFE_ENV_KEYS}
    env["PATH"] = f"{Path(harness.BUN).parent}:{env.get('PATH', '')}"
    env["DATABASE_URL"] = harness.DATABASE_URL
    env["OPENAI_API_KEY"] = "thechat-hermes-approval-e2e-local-only"
    env["OPENAI_BASE_URL"] = f"http://127.0.0.1:{MODEL_PORT}/v1"
    env["NO_PROXY"] = "127.0.0.1,localhost,::1"
    env["no_proxy"] = env["NO_PROXY"]
    return env


def _start_fake_model(env: dict[str, str]) -> subprocess.Popen[Any]:
    refuse_port_collision(MODEL_PORT, "requests model port")
    TMP.mkdir(parents=True, exist_ok=True)
    log_path = TMP / "fake-model.log"
    with log_path.open("w") as log:
        proc = subprocess.Popen(
            [sys.executable, "-u", str(ROOT / "scripts/e2e/fake-openai-approval-server.py"), "--port", str(MODEL_PORT),
             *(["--execution-target", NAMED_TARGET] if NAMED_TARGET else [])],
            cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, text=True, start_new_session=True,
        )

    def ready() -> bool:
        if proc.poll() is not None:
            raise RuntimeError(f"Fake model exited with {proc.returncode}\n{log_path.read_text(errors='replace')[-4000:]}")
        return harness.http_json("GET", f"http://127.0.0.1:{MODEL_PORT}/health")[0] == 200

    try:
        harness.wait_for(ready, timeout=30, label="deterministic model")
    except BaseException:
        harness.terminate_process(proc)
        raise
    return proc


def _model_state() -> dict[str, int]:
    status, state = harness.http_json("GET", f"http://127.0.0.1:{MODEL_PORT}/state")
    assert status == 200, (status, state)
    return state


def _wait_for_webhook_registration(base: str, token: str, bot_id: str) -> None:
    def registered() -> bool:
        health_status, health = harness.http_json("GET", f"http://127.0.0.1:{WEBHOOK_PORT}/health")
        if health_status != 200 or health.get("platform") != "thechat":
            return False
        status, detail = harness.http_json("GET", f"{base}/bots/{bot_id}", token=token)
        return status == 200 and detail.get("webhookUrl") == WEBHOOK_URL

    harness.wait_for(registered, timeout=90, label="Hermes gateway webhook registration")


# Optional: run the approved command on a named SSH execution target (Hermes builds with
# named targets). Point it at any SSH host the runner can reach with a key.
NAMED_TARGET = os.environ.get("HERMES_REQUESTS_E2E_NAMED_TARGET", "").strip()


def _terminal_config() -> str:
    if not NAMED_TARGET:
        return "terminal:\n  backend: local\n"
    ssh = {key: os.environ[f"HERMES_REQUESTS_E2E_SSH_{key.upper()}"] for key in ("host", "user", "port", "key", "cwd")}
    return (
        "terminal:\n"
        "  default_target: local\n"
        "  targets:\n"
        "    local:\n"
        "      backend: local\n"
        f"    {NAMED_TARGET}:\n"
        "      backend: ssh\n"
        f"      ssh_host: {ssh['host']}\n"
        f"      ssh_user: {ssh['user']}\n"
        f"      ssh_port: {ssh['port']}\n"
        f"      ssh_key: {ssh['key']}\n"
        f"      cwd: {ssh['cwd']}\n"
    )


GATEWAY_CONFIG = """
platform_toolsets:
  thechat:
    - terminal
    - clarify
    - no_mcp
""" + _terminal_config() + """security:
  tirith_enabled: false
auxiliary:
  title_generation:
    enabled: false
agent:
  environment_probe: false
"""


def _gateway_env(env: dict[str, str]) -> dict[str, str]:
    return env | {
        "HERMES_YOLO_MODE": "0",
        "TERMINAL_ENV": "local",
        "TIRITH_ENABLED": "0",
        # Fail closed if anything tries external egress.
        "ALL_PROXY": "http://127.0.0.1:9",
        "HTTP_PROXY": "http://127.0.0.1:9",
        "HTTPS_PROXY": "http://127.0.0.1:9",
    }


def _start_gateway(env: dict[str, str], base: str, bot: dict[str, Any], home_name: str, *, webhook: bool):
    return harness.start_hermes_gateway(
        _gateway_env(env),
        base,
        bot["apiKey"],
        home_name,
        approval_mode="manual",
        approval_timeout=300,
        model_api_mode="chat_completions",
        model_base_url=f"http://127.0.0.1:{MODEL_PORT}/v1",
        require_loopback_model=True,
        isolate_runtime_environment=True,
        webhook_url=WEBHOOK_URL if webhook else None,
        additional_config=GATEWAY_CONFIG,
    )


def _wait_for_commands(base: str, token: str, conversation_id: str) -> None:
    def registered() -> bool:
        status, detail = harness.http_json("GET", f"{base}/conversations/detail/{conversation_id}", token=token)
        return status == 200 and any(
            (p.get("bot") or {}).get("kind") == "hermes" and (p.get("bot") or {}).get("commands")
            for p in detail.get("participants") or []
        )

    harness.wait_for(registered, timeout=90, label="Hermes gateway command registration")


def _inbox(base: str, token: str) -> dict[str, Any]:
    status, inbox = harness.http_json("GET", f"{base}/inbox", token=token)
    assert status == 200, (status, inbox)
    return inbox


def _wait_for_open_request(base: str, token: str, conversation_id: str, kind: str, *, exclude: set[str] = frozenset()):
    def find():
        for request in _inbox(base, token).get("open") or []:
            if (
                request.get("conversationId") == conversation_id
                and request.get("kind") == kind
                and request["id"] not in exclude
            ):
                return request
        return None

    try:
        return harness.wait_for(find, timeout=180, label=f"open {kind} request in the Inbox")
    except RuntimeError:
        # Say what the conversation shows instead: a text fallback, an error, or nothing.
        status, messages = harness.http_json("GET", f"{base}/messages/{conversation_id}", token=token)
        print("Conversation at timeout:", status, json.dumps(messages, indent=2)[-4000:], flush=True)
        print("Inbox at timeout:", json.dumps(_inbox(base, token), indent=2)[-4000:], flush=True)
        raise


def _get_request(base: str, token: str, request_id: str) -> dict[str, Any]:
    status, body = harness.http_json("GET", f"{base}/bot-requests/{request_id}", token=token)
    assert status == 200, (status, body)
    return body["request"]


def _wait_for_status(base: str, token: str, request_id: str, statuses: set[str], label: str):
    def check():
        request = _get_request(base, token, request_id)
        return request if request.get("status") in statuses else None

    return harness.wait_for(check, timeout=120, label=label)


def _answer(base: str, token: str, request_id: str, answer: dict[str, Any]) -> dict[str, Any]:
    status, body = harness.http_json("POST", f"{base}/bot-requests/{request_id}/answer", answer, token)
    assert status == 200, (status, body)
    assert body["request"]["status"] in {"answered", "delivered"}, body
    return body["request"]


def _register(base: str, label: str) -> tuple[str, dict[str, Any]]:
    stamp = time.time_ns()
    status, registered = harness.http_json(
        "POST",
        f"{base}/auth/register",
        {"name": label, "email": f"hermes-requests-e2e-{stamp}@example.com", "password": "password123"},
    )
    assert status == 200, (status, registered)
    return registered["accessToken"], registered["user"]


def _scenario_inbox_answers(env: dict[str, str], base: str, token: str, workspace_id: str, procs: list) -> dict[str, Any]:
    bot = harness.create_hermes_bot(base, token, workspace_id, "Hermes Requests E2E")
    refuse_port_collision(WEBHOOK_PORT, "requests webhook port")
    procs.append(_start_gateway(env, base, bot, "Hermes Requests E2E", webhook=True))
    status, dm = harness.http_json(
        "POST", f"{base}/conversations/dm", {"workspaceId": workspace_id, "otherUserId": bot["userId"]}, token)
    assert status == 200, (status, dm)
    dm_id = dm["id"]
    _wait_for_webhook_registration(base, token, bot["id"])
    _wait_for_commands(base, token, dm_id)

    status, sent = harness.http_json("POST", f"{base}/messages/{dm_id}", {"content": TRIGGER_MESSAGE}, token)
    assert status == 200, (status, sent)

    approval = _wait_for_open_request(base, token, dm_id, "approval")
    assert approval["details"]["command"] == fake_model.APPROVAL_COMMAND, approval
    assert fake_model.APPROVAL_REASON_MARKER in (approval.get("body") or ""), approval
    if NAMED_TARGET:
        # The person can see where the command will run before allowing it.
        assert f"execution target: '{NAMED_TARGET}'; backend: ssh" in (approval.get("body") or ""), approval
    # TheChat offers what Hermes offers: "Always allow" included, nothing narrowed.
    assert approval["response"]["choices"] == ["once", "session", "always", "deny"], approval
    assert approval["invocationId"], approval
    _answer(base, token, approval["id"], {"choice": "always"})
    approval = _wait_for_status(base, token, approval["id"], {"delivered"}, "approval acknowledged by Hermes")
    assert approval["deliveryApplied"] is True, approval

    question = _wait_for_open_request(base, token, dm_id, "question")
    assert question["title"] == fake_model.CLARIFY_QUESTION, question
    assert question["response"]["choices"] == fake_model.CLARIFY_CHOICES, question
    # Hermes marks its first choice as recommended; that is a display label, not the answer.
    assert question["response"]["labels"] == {
        fake_model.CLARIFY_CHOICES[0]: f"{fake_model.CLARIFY_CHOICES[0]} (Recommended)"
    }, question
    assert question["response"]["multiple"] is True, question
    _answer(base, token, question["id"], {"choices": fake_model.CLARIFY_RESPONSE})
    question = _wait_for_status(base, token, question["id"], {"delivered"}, "question acknowledged by Hermes")
    assert question["deliveryApplied"] is True, question

    final = harness.wait_for_bot_message(base, token, dm_id, bot["name"], timeout=180)
    assert final.get("senderType") == "bot", final
    assert final.get("content") == fake_model.FINAL_MESSAGE, final

    status, messages = harness.http_json("GET", f"{base}/messages/{dm_id}", token=token)
    assert status == 200, (status, messages)
    assert not any("/approve" in (m.get("content") or "") for m in messages), messages
    assert [m.get("content") for m in messages if m.get("senderType") == "human"] == [TRIGGER_MESSAGE], messages

    config = (harness.HERMES_HOME_ROOT / harness.slug("Hermes Requests E2E") / "config.yaml").read_text()
    assert "command_allowlist" in config, "Always allow from TheChat was not persisted by Hermes"
    if NAMED_TARGET:
        # Always allow on a named target covers only that target.
        assert "target:" in config.split("command_allowlist", 1)[1], config

    assert not (_inbox(base, token).get("open") or []), "requests left open after the run"
    model_state = _model_state()
    assert model_state.get("terminalToolCallResponses") == 1, model_state
    assert model_state.get("clarifyToolCallResponses") == 1, model_state
    assert model_state.get("successfulFinalResponses") == 1, model_state
    return {
        "approval": {"id": approval["id"], "answer": approval["answer"], "deliveryApplied": approval["deliveryApplied"]},
        "question": {"id": question["id"], "answer": question["answer"], "deliveryApplied": question["deliveryApplied"]},
        "finalMessage": final.get("content"),
        "alwaysAllowPersisted": True,
        "modelState": model_state,
    }


def _scenario_restart_cleanup(env: dict[str, str], base: str, token: str, workspace_id: str, procs: list) -> dict[str, Any]:
    bot = harness.create_hermes_bot(base, token, workspace_id, "Hermes Restart E2E")
    first = _start_gateway(env, base, bot, "Hermes Restart E2E", webhook=False)
    procs.append(first)
    status, dm = harness.http_json(
        "POST", f"{base}/conversations/dm", {"workspaceId": workspace_id, "otherUserId": bot["userId"]}, token)
    assert status == 200, (status, dm)
    dm_id = dm["id"]
    _wait_for_commands(base, token, dm_id)

    status, sent = harness.http_json("POST", f"{base}/messages/{dm_id}", {"content": TRIGGER_MESSAGE}, token)
    assert status == 200, (status, sent)
    stale = _wait_for_open_request(base, token, dm_id, "approval")

    # A crash, not a shutdown: nothing gets the chance to withdraw the request.
    os.killpg(first.pid, signal.SIGKILL)
    first.wait(timeout=10)
    assert _get_request(base, token, stale["id"])["status"] == "open"

    # Same bot token, fresh process (own HERMES_HOME, which cleanup does not depend on).
    procs.append(_start_gateway(env, base, bot, "Hermes Restart E2E second", webhook=False))
    cancelled = _wait_for_status(base, token, stale["id"], {"cancelled"}, "stale request cancelled on startup")
    assert cancelled["cancelReason"] == "Hermes restarted. Ask again.", cancelled
    status, body = harness.http_json(
        "POST", f"{base}/bot-requests/{stale['id']}/answer", {"choice": "once"}, token)
    assert status == 409, (status, body)
    return {"staleRequest": stale["id"], "cancelReason": cancelled["cancelReason"], "lateAnswerStatus": status}


def _run() -> None:
    env = _safe_child_env()

    procs: list[subprocess.Popen[Any]] = []
    model_proc = api_proc = worker_proc = None
    try:
        harness.start_postgres()
        harness.start_redis()
        harness.run([harness.PNPM, "--dir", "packages/api", "exec", "drizzle-kit", "migrate"], env=env)
        api_proc = harness.start_api(env)
        worker_proc = harness.start_worker(env)
        model_proc = _start_fake_model(env)

        base = f"http://127.0.0.1:{harness.API_PORT}"
        token, _user = _register(base, "Requests E2E Person")
        status, workspace = harness.http_json(
            "POST", f"{base}/workspaces/create", {"name": f"Hermes Requests E2E {RUN_ID}"}, token)
        assert status == 200, (status, workspace)

        inbox = _scenario_inbox_answers(env, base, token, workspace["id"], procs)
        restart = _scenario_restart_cleanup(env, base, token, workspace["id"], procs)
        print(json.dumps({"ok": True, "runId": RUN_ID, "realHermes": True,
                          "inboxAnswers": inbox, "restartCleanup": restart}, indent=2))
    finally:
        for proc in procs:
            harness.terminate_process(proc)
        harness.terminate_process(model_proc)
        harness.terminate_process(worker_proc, timeout=10)
        harness.terminate_process(api_proc, timeout=10)
        if not KEEP:
            harness.remove_owned_container(harness.REDIS_CONTAINER, "redis")
            harness.remove_owned_container(harness.PG_CONTAINER, "postgres")
        else:
            print(f"Keeping E2E resources because HERMES_E2E_KEEP=1; logs: {harness.HERMES_LOG_ROOT}")


def main() -> None:
    acquire_owned_directory(TMP, RUN_ID, "hermes-bot-requests-evidence")
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}

    def interrupt(signum, _frame):
        raise KeyboardInterrupt(f"Received signal {signum}; cleaning up E2E resources")

    for sig in previous:
        signal.signal(sig, interrupt)
    try:
        _run()
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    main()
