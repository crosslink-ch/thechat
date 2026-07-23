#!/usr/bin/env python3
"""Real Hermes -> TheChat -> Tauri approval UI end-to-end test.

The only fake is the deterministic OpenAI-compatible model endpoint. The test
starts an actual Hermes Gateway from source, connects it through the native
TheChat polling adapter, sends a DM through the real desktop UI, observes the
structured approval card, clicks Approve, and verifies Hermes continues.
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

ROOT = Path(__file__).resolve().parents[2]
TMP = ROOT / ".tmp"

# Give this heavier UI flow its own ports, containers, and Hermes state so it
# can run alongside the API-only Hermes smoke test.
os.environ.setdefault("THECHAT_E2E_API_PORT", "3339")
os.environ.setdefault("THECHAT_E2E_POSTGRES_PORT", "15545")
os.environ.setdefault("THECHAT_E2E_REDIS_PORT", "16382")
os.environ.setdefault(
    "THECHAT_E2E_DATABASE_URL",
    "postgres://thechat:thechat@localhost:15545/thechat",
)
os.environ.setdefault("THECHAT_E2E_REDIS_URL", "redis://localhost:16382")
os.environ.setdefault(
    "THECHAT_E2E_PG_CONTAINER", "thechat-hermes-approval-ui-e2e-postgres"
)
os.environ.setdefault(
    "THECHAT_E2E_REDIS_CONTAINER", "thechat-hermes-approval-ui-e2e-redis"
)
os.environ.setdefault("HERMES_E2E_PROVIDER", "custom")
os.environ.setdefault("HERMES_E2E_MODEL", "hermes-approval-e2e")
os.environ.setdefault("HERMES_E2E_HOME", str(TMP / "hermes-approval-ui-e2e-home"))
os.environ.setdefault("HERMES_E2E_LOG_DIR", str(TMP / "hermes-approval-ui-e2e-logs"))
_sibling_hermes = ROOT.parent / "hermes-agent"
if _sibling_hermes.exists():
    os.environ.setdefault("HERMES_E2E_SOURCE_DIR", str(_sibling_hermes))

MODEL_PORT = int(os.environ.get("HERMES_APPROVAL_E2E_MODEL_PORT", "18081"))
KEEP = os.environ.get("HERMES_E2E_KEEP") == "1"


def _load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load E2E helper: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


harness = _load_module(
    "thechat_hermes_bot_flow", ROOT / "scripts/e2e/hermes-bot-flow.py"
)
fake_model = _load_module(
    "thechat_fake_openai_approval_server",
    ROOT / "scripts/e2e/fake-openai-approval-server.py",
)


def _terminate(proc: subprocess.Popen[Any] | None, timeout: int = 15) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def _start_fake_model() -> subprocess.Popen[Any]:
    TMP.mkdir(parents=True, exist_ok=True)
    log_path = TMP / "hermes-approval-ui-e2e-fake-model.log"
    with log_path.open("w") as log:
        proc = subprocess.Popen(
            [
                sys.executable,
                "-u",
                str(ROOT / "scripts/e2e/fake-openai-approval-server.py"),
                "--port",
                str(MODEL_PORT),
            ],
            cwd=ROOT,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
        )

    def ready() -> bool:
        if proc.poll() is not None:
            tail = (
                log_path.read_text(errors="replace")[-4000:]
                if log_path.exists()
                else ""
            )
            raise RuntimeError(f"Fake model exited with {proc.returncode}\n{tail}")
        return (
            harness.http_json("GET", f"http://127.0.0.1:{MODEL_PORT}/health")[0] == 200
        )

    try:
        harness.wait_for(ready, timeout=30, label="deterministic approval model")
    except BaseException:
        _terminate(proc)
        raise
    return proc


def _wait_for_gateway_registration(base: str, token: str, conversation_id: str) -> None:
    def registered() -> bool:
        status, detail = harness.http_json(
            "GET",
            f"{base}/conversations/detail/{conversation_id}",
            token=token,
        )
        if status != 200:
            return False
        for participant in detail.get("participants") or []:
            bot = participant.get("bot") or {}
            if bot.get("kind") == "hermes" and bot.get("commands"):
                return True
        return False

    harness.wait_for(
        registered, timeout=60, label="Hermes gateway command registration"
    )


def _run_desktop_e2e(
    env: dict[str, str],
    *,
    base: str,
    email: str,
    password: str,
    bot_name: str,
    conversation_id: str,
) -> None:
    screenshot = TMP / "hermes-approval-ui-e2e.png"
    screenshot.parent.mkdir(parents=True, exist_ok=True)
    screenshot.unlink(missing_ok=True)
    desktop_env = env | {
        "THECHAT_BACKEND_URL": base,
        "TAURI_E2E": "1",
        "WDIO_MOCHA_TIMEOUT": "240000",
        "HERMES_APPROVAL_E2E_EMAIL": email,
        "HERMES_APPROVAL_E2E_PASSWORD": password,
        "HERMES_APPROVAL_E2E_BOT_NAME": bot_name,
        "HERMES_APPROVAL_E2E_CONVERSATION_ID": conversation_id,
        "HERMES_APPROVAL_E2E_TRIGGER_MESSAGE": (
            f"{fake_model.TRIGGER_MARKER}: run the deterministic terminal check now"
        ),
        "HERMES_APPROVAL_E2E_COMMAND": fake_model.APPROVAL_COMMAND,
        "HERMES_APPROVAL_E2E_FINAL_MESSAGE": fake_model.FINAL_MESSAGE,
        "HERMES_APPROVAL_E2E_SCREENSHOT": str(screenshot),
    }
    harness.run(
        [
            harness.PNPM,
            "--filter",
            "@thechat/desktop",
            "exec",
            "wdio",
            "run",
            "e2e/wdio.conf.js",
            "--spec",
            "e2e/specs/hermes-approval.e2e.js",
        ],
        env=desktop_env,
    )
    if not screenshot.exists() or screenshot.stat().st_size == 0:
        raise AssertionError(f"Approval UI screenshot was not produced: {screenshot}")


def _verify_backend_contract(
    base: str,
    token: str,
    conversation_id: str,
    bot_name: str,
) -> dict[str, Any]:
    # Terminal progress is intentionally cleared from the public runtime store
    # after completion. The WebDriver assertion observes approval.request while
    # it is live; post-completion verification therefore focuses on the
    # resulting Hermes message and the absence of the text fallback.
    status, messages = harness.http_json(
        "GET",
        f"{base}/messages/{conversation_id}",
        token=token,
    )
    assert status == 200, (status, messages)
    bot_messages = [
        message for message in messages if message.get("senderName") == bot_name
    ]
    assert any(
        message.get("content") == fake_model.FINAL_MESSAGE for message in bot_messages
    ), bot_messages
    assert not any(
        "Reply " in (message.get("content") or "")
        and "/approve" in (message.get("content") or "")
        for message in messages
    ), messages

    return {
        "finalMessage": fake_model.FINAL_MESSAGE,
        "screenshot": str(TMP / "hermes-approval-ui-e2e.png"),
    }


def main() -> None:
    env = os.environ.copy()
    env["PATH"] = f"{Path(harness.BUN).parent}:{env.get('PATH', '')}"
    env["DATABASE_URL"] = harness.DATABASE_URL
    env["OPENAI_API_KEY"] = "thechat-hermes-approval-e2e"
    env["OPENAI_BASE_URL"] = f"http://127.0.0.1:{MODEL_PORT}/v1"

    model_proc: subprocess.Popen[Any] | None = None
    api_proc: subprocess.Popen[Any] | None = None
    worker_proc: subprocess.Popen[Any] | None = None
    hermes_proc: subprocess.Popen[Any] | None = None

    try:
        harness.start_postgres()
        harness.start_redis()
        harness.run(
            [harness.PNPM, "--dir", "packages/api", "exec", "drizzle-kit", "migrate"],
            env=env,
        )
        api_proc = harness.start_api(env)
        worker_proc = harness.start_worker(env)
        model_proc = _start_fake_model()

        base = f"http://127.0.0.1:{harness.API_PORT}"
        stamp = time.time_ns()
        email = f"hermes-approval-ui-e2e-{stamp}@example.com"
        password = "password123"
        workspace_name = f"Hermes Approval UI E2E {stamp}"
        bot_name = "Hermes Approval E2E"

        status, registered = harness.http_json(
            "POST",
            f"{base}/auth/register",
            {"name": "Hermes Approval UI E2E", "email": email, "password": password},
        )
        assert status == 200, (status, registered)
        token = registered["accessToken"]

        status, workspace = harness.http_json(
            "POST",
            f"{base}/workspaces/create",
            {"name": workspace_name},
            token,
        )
        assert status == 200, (status, workspace)

        bot = harness.create_hermes_bot(
            base,
            token,
            workspace["id"],
            bot_name,
            "Follow the deterministic E2E model response and use the terminal tool when requested.",
        )
        hermes_proc = harness.start_hermes_gateway(
            env,
            base,
            bot["apiKey"],
            bot_name,
            approval_mode="manual",
            approval_timeout=180,
            model_api_mode="chat_completions",
            model_base_url=f"http://127.0.0.1:{MODEL_PORT}/v1",
        )

        status, dm = harness.http_json(
            "POST",
            f"{base}/conversations/dm",
            {"workspaceId": workspace["id"], "otherUserId": bot["userId"]},
            token,
        )
        assert status == 200, (status, dm)
        conversation_id = dm["id"]
        _wait_for_gateway_registration(base, token, conversation_id)

        _run_desktop_e2e(
            env,
            base=base,
            email=email,
            password=password,
            bot_name=bot_name,
            conversation_id=conversation_id,
        )
        evidence = _verify_backend_contract(base, token, conversation_id, bot_name)
        print(json.dumps({"ok": True, "realHermes": True, **evidence}, indent=2))
    finally:
        _terminate(hermes_proc)
        _terminate(model_proc)
        _terminate(worker_proc, timeout=10)
        _terminate(api_proc, timeout=10)
        if not KEEP:
            harness.run(["docker", "rm", "-f", harness.REDIS_CONTAINER], check=False)
            harness.run(["docker", "rm", "-f", harness.PG_CONTAINER], check=False)
        else:
            print(
                "Keeping E2E resources because HERMES_E2E_KEEP=1; "
                f"Hermes home root: {harness.HERMES_HOME_ROOT}"
            )


if __name__ == "__main__":
    main()
