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
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from types import ModuleType
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
TMP = ROOT / ".tmp"
RUN_ID = f"{os.getpid()}-{time.time_ns()}"
FAKE_MODEL_LOG = TMP / f"hermes-approval-ui-e2e-fake-model-{RUN_ID}.log"

# Give this heavier UI flow its own ports and uniquely owned resources so it
# can run alongside the API-only Hermes smoke test without deleting another
# run's containers or reusing approval/session state.
os.environ.setdefault("THECHAT_E2E_API_PORT", "3339")
os.environ.setdefault("THECHAT_E2E_POSTGRES_PORT", "15545")
os.environ.setdefault("THECHAT_E2E_REDIS_PORT", "16382")
os.environ.setdefault(
    "THECHAT_E2E_DATABASE_URL",
    "postgres://thechat:thechat@localhost:"
    f"{os.environ['THECHAT_E2E_POSTGRES_PORT']}/thechat",
)
os.environ.setdefault(
    "THECHAT_E2E_REDIS_URL",
    f"redis://localhost:{os.environ['THECHAT_E2E_REDIS_PORT']}",
)
os.environ["THECHAT_E2E_PG_CONTAINER"] = (
    f"thechat-hermes-approval-ui-e2e-postgres-{RUN_ID}"
)
os.environ["THECHAT_E2E_REDIS_CONTAINER"] = (
    f"thechat-hermes-approval-ui-e2e-redis-{RUN_ID}"
)
os.environ.setdefault("HERMES_E2E_PROVIDER", "custom")
os.environ.setdefault("HERMES_E2E_MODEL", "hermes-approval-e2e")
os.environ["HERMES_E2E_HOME"] = str(TMP / "hermes-approval-ui-e2e-home" / RUN_ID)
os.environ["HERMES_E2E_LOG_DIR"] = str(TMP / "hermes-approval-ui-e2e-logs" / RUN_ID)
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
TRIGGER_MESSAGE = (
    f"{fake_model.TRIGGER_MARKER}: run the deterministic terminal check now"
)

_SAFE_ENV_KEYS = {
    "CARGO_HOME",
    "CI",
    "DISPLAY",
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
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
}


def _safe_child_env() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key in _SAFE_ENV_KEYS}
    env["PATH"] = f"{Path(harness.BUN).parent}:{env.get('PATH', '')}"
    env["DATABASE_URL"] = harness.DATABASE_URL
    env["OPENAI_API_KEY"] = "thechat-hermes-approval-e2e-local-only"
    env["OPENAI_BASE_URL"] = f"http://127.0.0.1:{MODEL_PORT}/v1"
    env["NO_PROXY"] = "127.0.0.1,localhost,::1"
    env["no_proxy"] = env["NO_PROXY"]
    return env


def _preflight_approval_command(env: dict[str, str]) -> None:
    script = """
import json
import subprocess
import sys
from tools.approval import detect_dangerous_command, detect_hardline_command

command = sys.argv[1]
run = subprocess.run(command, shell=True, capture_output=True, text=True)
print(json.dumps({
    "dangerous": bool(detect_dangerous_command(command)[0]),
    "hardline": bool(detect_hardline_command(command)[0]),
    "exitCode": run.returncode,
    "stdout": run.stdout,
    "stderr": run.stderr,
}))
"""
    result = subprocess.run(
        [
            harness.UV,
            "run",
            "--frozen",
            "python",
            "-c",
            script,
            fake_model.APPROVAL_COMMAND,
        ],
        cwd=harness.HERMES_SOURCE_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise AssertionError("Hermes approval preflight produced no result")
    evidence = json.loads(lines[-1])
    expected_stdout = f"{fake_model.OUTPUT_MARKER}\n"
    if (
        not evidence["dangerous"]
        or evidence["hardline"]
        or evidence["exitCode"] != 0
        or evidence["stdout"] != expected_stdout
        or evidence["stderr"]
    ):
        raise AssertionError(
            f"Unsafe or non-deterministic Hermes approval command: {evidence}"
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


def _start_fake_model(env: dict[str, str]) -> subprocess.Popen[Any]:
    TMP.mkdir(parents=True, exist_ok=True)
    log_path = FAKE_MODEL_LOG
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
            env=env,
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
    failure_screenshot = TMP / "hermes-approval-ui-e2e-failure.png"
    screenshot.parent.mkdir(parents=True, exist_ok=True)
    screenshot.unlink(missing_ok=True)
    failure_screenshot.unlink(missing_ok=True)
    desktop_env = env | {
        "THECHAT_BACKEND_URL": base,
        "THECHAT_E2E_DISABLE_DOTENV": "1",
        "TAURI_E2E": "1",
        "HERMES_APPROVAL_E2E": "1",
        "WDIO_MOCHA_TIMEOUT": "240000",
        "HERMES_APPROVAL_E2E_EMAIL": email,
        "HERMES_APPROVAL_E2E_PASSWORD": password,
        "HERMES_APPROVAL_E2E_BOT_NAME": bot_name,
        "HERMES_APPROVAL_E2E_CONVERSATION_ID": conversation_id,
        "HERMES_APPROVAL_E2E_TRIGGER_MESSAGE": TRIGGER_MESSAGE,
        "HERMES_APPROVAL_E2E_COMMAND": fake_model.APPROVAL_COMMAND,
        "HERMES_APPROVAL_E2E_REASON": fake_model.APPROVAL_REASON_MARKER,
        "HERMES_APPROVAL_E2E_FINAL_MESSAGE": fake_model.FINAL_MESSAGE,
        "HERMES_APPROVAL_E2E_SCREENSHOT": str(screenshot),
    }
    # This suite embeds the backend URL at Tauri build time. Never inherit a
    # stale-build shortcut from a developer shell.
    desktop_env.pop("SKIP_BUILD", None)
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
            "e2e/opt-in/hermes-approval.e2e.js",
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
    assert any(message.get("content") == TRIGGER_MESSAGE for message in messages), (
        messages
    )
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


def _verify_model_contract() -> dict[str, int]:
    status, state = harness.http_json("GET", f"http://127.0.0.1:{MODEL_PORT}/state")
    assert status == 200, (status, state)
    assert state.get("toolCallResponses") == 1, state
    assert state.get("successfulFinalResponses") == 1, state
    return state


def main() -> None:
    env = _safe_child_env()
    env["HERMES_YOLO_MODE"] = "0"
    env["TERMINAL_ENV"] = "local"
    env["TIRITH_ENABLED"] = "0"
    gateway_env = env | {
        # Fail closed if any inherited/configured provider tries external egress.
        "ALL_PROXY": "http://127.0.0.1:9",
        "HTTP_PROXY": "http://127.0.0.1:9",
        "HTTPS_PROXY": "http://127.0.0.1:9",
    }
    _preflight_approval_command(gateway_env)

    model_proc: subprocess.Popen[Any] | None = None
    api_proc: subprocess.Popen[Any] | None = None
    worker_proc: subprocess.Popen[Any] | None = None
    hermes_proc: subprocess.Popen[Any] | None = None
    completed = False

    try:
        harness.start_postgres()
        harness.start_redis()
        harness.run(
            [harness.PNPM, "--dir", "packages/api", "exec", "drizzle-kit", "migrate"],
            env=env,
        )
        api_proc = harness.start_api(env)
        worker_proc = harness.start_worker(env)
        model_proc = _start_fake_model(env)

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
            gateway_env,
            base,
            bot["apiKey"],
            bot_name,
            approval_mode="manual",
            approval_timeout=180,
            model_api_mode="chat_completions",
            model_base_url=f"http://127.0.0.1:{MODEL_PORT}/v1",
            require_loopback_model=True,
            additional_config="""
platform_toolsets:
  thechat:
    - terminal
    - no_mcp
terminal:
  backend: local
security:
  tirith_enabled: false
auxiliary:
  title_generation:
    enabled: false
agent:
  environment_probe: false
""",
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
        model_state = _verify_model_contract()
        print(
            json.dumps(
                {
                    "ok": True,
                    "realHermes": True,
                    "modelState": model_state,
                    **evidence,
                },
                indent=2,
            )
        )
        completed = True
    finally:
        _terminate(hermes_proc)
        _terminate(model_proc)
        _terminate(worker_proc, timeout=10)
        _terminate(api_proc, timeout=10)
        if not KEEP:
            harness.run(["docker", "rm", "-f", harness.REDIS_CONTAINER], check=False)
            harness.run(["docker", "rm", "-f", harness.PG_CONTAINER], check=False)
            if completed:
                shutil.rmtree(harness.HERMES_HOME_ROOT, ignore_errors=True)
                shutil.rmtree(harness.HERMES_LOG_ROOT, ignore_errors=True)
                for parent in (
                    harness.HERMES_HOME_ROOT.parent,
                    harness.HERMES_LOG_ROOT.parent,
                ):
                    try:
                        parent.rmdir()
                    except OSError:
                        # Another concurrent/retained run may still own a sibling.
                        pass
                FAKE_MODEL_LOG.unlink(missing_ok=True)
        else:
            print(
                "Keeping E2E resources because HERMES_E2E_KEEP=1; "
                f"Hermes home root: {harness.HERMES_HOME_ROOT}"
            )


if __name__ == "__main__":
    main()
