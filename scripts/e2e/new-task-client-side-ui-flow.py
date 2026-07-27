#!/usr/bin/env python3
"""Real Tauri E2E for the client-only Hermes New task draft boundary."""

from __future__ import annotations

import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE_ROOT = Path(
    os.environ.get(
        "THECHAT_NEW_TASK_E2E_ROOT",
        str(Path.home() / "thechat-e2e" / "new-task-client-side"),
    )
).resolve()
CONTROL_DIR = EVIDENCE_ROOT / "control"
SCREENSHOT = EVIDENCE_ROOT / "new-task-client-side.png"
UI_EVIDENCE = EVIDENCE_ROOT / "ui-evidence.json"

# Set isolated resource identities before loading the shared harness, whose
# constants are resolved at import time.
os.environ.setdefault("THECHAT_E2E_API_PORT", "3348")
os.environ.setdefault("THECHAT_E2E_POSTGRES_PORT", "15554")
os.environ.setdefault("THECHAT_E2E_REDIS_PORT", "16391")
os.environ.setdefault("THECHAT_E2E_PG_CONTAINER", "thechat-new-task-e2e-postgres")
os.environ.setdefault("THECHAT_E2E_REDIS_CONTAINER", "thechat-new-task-e2e-redis")


def load_harness_module():
    path = ROOT / "scripts" / "e2e" / "hermes-bot-flow.py"
    spec = importlib.util.spec_from_file_location("thechat_new_task_e2e_harness", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load shared E2E harness: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


harness = load_harness_module()


def child_env() -> dict[str, str]:
    keep = {
        "PATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "TERM",
        "TMPDIR",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "XDG_CACHE_HOME",
        "XDG_RUNTIME_DIR",
    }
    env = {key: value for key, value in os.environ.items() if key in keep}
    env["PATH"] = f"{Path(harness.BUN).parent}:{env.get('PATH', '')}"
    env["DATABASE_URL"] = harness.DATABASE_URL
    env["NO_PROXY"] = "127.0.0.1,localhost"
    env["no_proxy"] = env["NO_PROXY"]
    return env


def run_bounded(cmd: list[str], *, env: dict[str, str], timeout: int) -> None:
    print("$", " ".join(cmd), flush=True)
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
        harness.terminate_process(proc, timeout=10)
        raise
    if return_code != 0:
        harness.terminate_process(proc, timeout=10)
        raise subprocess.CalledProcessError(return_code, cmd)


def port_reachable(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def wait_for_file(path: Path, stop: threading.Event, label: str) -> None:
    started = time.monotonic()
    while not path.exists():
        if stop.is_set():
            raise RuntimeError(f"Stopped before {label}")
        if time.monotonic() - started > 180:
            raise TimeoutError(f"Timed out waiting for {label}: {path}")
        time.sleep(0.1)


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.pending")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


def postgres_running() -> bool:
    return (
        harness.output(
            ["docker", "inspect", "-f", "{{.State.Running}}", harness.PG_CONTAINER]
        )
        == "true"
    )


def wait_for_postgres() -> None:
    harness.wait_for(
        lambda: subprocess.run(
            [
                "docker",
                "exec",
                harness.PG_CONTAINER,
                "pg_isready",
                "-U",
                "thechat",
                "-d",
                "thechat",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode
        == 0,
        timeout=30,
        label="offline E2E PostgreSQL restart",
    )


def thread_count(conversation_id: str) -> int:
    query = (
        "SELECT count(*) FROM conversation_threads "
        f"WHERE conversation_id = '{conversation_id}'::uuid;"
    )
    return int(
        harness.output(
            [
                "docker",
                "exec",
                harness.PG_CONTAINER,
                "psql",
                "-U",
                "thechat",
                "-d",
                "thechat",
                "-tAc",
                query,
            ]
        )
    )


def control_backend(
    api_proc: subprocess.Popen[Any],
    conversation_id: str,
    stop: threading.Event,
) -> None:
    try:
        wait_for_file(CONTROL_DIR / "offline.request", stop, "offline request")
        count_before = thread_count(conversation_id)
        harness.terminate_process(api_proc, timeout=10)
        harness.run(
            ["docker", "stop", harness.REDIS_CONTAINER, harness.PG_CONTAINER],
            check=False,
        )
        harness.wait_for(
            lambda: not port_reachable(harness.API_PORT)
            and not port_reachable(harness.POSTGRES_PORT)
            and not port_reachable(harness.REDIS_PORT),
            timeout=30,
            label="API, PostgreSQL, and Redis to become unreachable",
        )
        write_json(
            CONTROL_DIR / "offline.json",
            {
                "apiReachable": port_reachable(harness.API_PORT),
                "postgresReachable": port_reachable(harness.POSTGRES_PORT),
                "redisReachable": port_reachable(harness.REDIS_PORT),
                "postgresRunning": postgres_running(),
                "threadCountBefore": count_before,
            },
        )

        wait_for_file(
            CONTROL_DIR / "verify-database.request",
            stop,
            "database verification request",
        )
        harness.run(["docker", "start", harness.PG_CONTAINER])
        wait_for_postgres()
        count_after = thread_count(conversation_id)
        write_json(
            CONTROL_DIR / "database.json",
            {
                "threadCountAfter": count_after,
                "apiReachable": port_reachable(harness.API_PORT),
            },
        )
        harness.run(["docker", "stop", harness.PG_CONTAINER], check=False)
    except BaseException as error:
        write_json(
            CONTROL_DIR / "control-error.json",
            {"type": type(error).__name__, "message": str(error)},
        )
        stop.set()


def main() -> None:
    env = child_env()
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    CONTROL_DIR.mkdir(parents=True, exist_ok=True)
    for path in CONTROL_DIR.iterdir():
        if path.is_file():
            path.unlink()
    SCREENSHOT.unlink(missing_ok=True)
    UI_EVIDENCE.unlink(missing_ok=True)

    api_proc: subprocess.Popen[Any] | None = None
    control_stop = threading.Event()
    control_thread: threading.Thread | None = None
    completed = False

    try:
        harness.start_postgres()
        harness.start_redis()
        harness.run(
            [harness.PNPM, "--dir", "packages/api", "exec", "drizzle-kit", "migrate"],
            env=env,
        )
        api_proc = harness.start_api(env)
        base = f"http://127.0.0.1:{harness.API_PORT}"
        email = f"new-task-e2e-{int(time.time())}@example.com"
        password = "password123"

        status, registration = harness.http_json(
            "POST",
            f"{base}/auth/register",
            {"name": "New Task E2E", "email": email, "password": password},
        )
        assert status == 200, (status, registration)
        token = registration["accessToken"]
        status, workspace = harness.http_json(
            "POST",
            f"{base}/workspaces/create",
            {"name": "New Task E2E Workspace"},
            token,
        )
        assert status == 200, (status, workspace)
        bot = harness.create_hermes_bot(
            base,
            token,
            workspace["id"],
            "Koda Offline E2E",
            "Offline draft test bot",
        )
        status, conversation = harness.http_json(
            "POST",
            f"{base}/conversations/dm",
            {"workspaceId": workspace["id"], "otherUserId": bot["userId"]},
            token,
        )
        assert status == 200, (status, conversation)
        conversation_id = conversation["id"]
        existing_thread_title = "Existing persisted task"
        status, existing_thread = harness.http_json(
            "POST",
            f"{base}/conversations/threads/{conversation_id}",
            {"botId": bot["id"], "title": existing_thread_title},
            token,
        )
        assert status == 200, (status, existing_thread)
        assert thread_count(conversation_id) == 1
        general_cache_witness = "General cache loaded before selecting the existing task"
        status, general_message = harness.http_json(
            "POST",
            f"{base}/messages/{conversation_id}",
            {"content": general_cache_witness, "threadId": None},
            token,
        )
        assert status == 200, (status, general_message)

        control_thread = threading.Thread(
            target=control_backend,
            args=(api_proc, conversation_id, control_stop),
            daemon=True,
            name="new-task-e2e-backend-control",
        )
        control_thread.start()

        desktop_env = env | {
            "THECHAT_BACKEND_URL": base,
            "THECHAT_E2E_DISABLE_DOTENV": "1",
            "TAURI_E2E": "1",
            "NEW_TASK_CLIENT_SIDE_E2E": "1",
            "WDIO_MOCHA_TIMEOUT": "240000",
            "NEW_TASK_CLIENT_SIDE_E2E_EMAIL": email,
            "NEW_TASK_CLIENT_SIDE_E2E_PASSWORD": password,
            "NEW_TASK_CLIENT_SIDE_E2E_BOT_NAME": bot["name"],
            "NEW_TASK_CLIENT_SIDE_E2E_CONVERSATION_ID": conversation_id,
            "NEW_TASK_CLIENT_SIDE_E2E_EXISTING_THREAD_TITLE": existing_thread_title,
            "NEW_TASK_CLIENT_SIDE_E2E_GENERAL_CACHE_WITNESS": general_cache_witness,
            "NEW_TASK_CLIENT_SIDE_E2E_CONTROL_DIR": str(CONTROL_DIR),
            "NEW_TASK_CLIENT_SIDE_E2E_SCREENSHOT": str(SCREENSHOT),
            "NEW_TASK_CLIENT_SIDE_E2E_EVIDENCE": str(UI_EVIDENCE),
            "THECHAT_E2E_DATA_ROOT": str(EVIDENCE_ROOT / "tauri-data"),
            "TMPDIR": str(EVIDENCE_ROOT / "tmp"),
        }
        Path(desktop_env["TMPDIR"]).mkdir(parents=True, exist_ok=True)
        desktop_env.pop("SKIP_BUILD", None)
        run_bounded(
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
                "e2e/opt-in/new-task-client-side.e2e.js",
            ],
            env=desktop_env,
            timeout=600,
        )

        if control_thread is not None:
            control_thread.join(timeout=30)
        if control_thread is not None and control_thread.is_alive():
            raise RuntimeError("Backend control thread did not finish")
        if (CONTROL_DIR / "control-error.json").exists():
            raise RuntimeError((CONTROL_DIR / "control-error.json").read_text())
        if not SCREENSHOT.exists() or SCREENSHOT.stat().st_size == 0:
            raise AssertionError(f"Tauri E2E screenshot was not produced: {SCREENSHOT}")
        if not UI_EVIDENCE.exists() or UI_EVIDENCE.stat().st_size == 0:
            raise AssertionError(f"Tauri E2E evidence was not produced: {UI_EVIDENCE}")

        completed = True
        print(
            json.dumps(
                {
                    "ok": True,
                    "conversationId": conversation_id,
                    "existingThreadId": existing_thread["id"],
                    "existingThreadTitle": existing_thread_title,
                    "generalCacheWitness": general_cache_witness,
                    "screenshot": str(SCREENSHOT),
                    "evidence": str(UI_EVIDENCE),
                },
                indent=2,
            )
        )
    finally:
        control_stop.set()
        harness.terminate_process(api_proc, timeout=10)
        harness.run(["docker", "rm", "-f", harness.REDIS_CONTAINER], check=False)
        harness.run(["docker", "rm", "-f", harness.PG_CONTAINER], check=False)
        if not completed:
            print(f"Preserved failed-run evidence under {EVIDENCE_ROOT}", file=sys.stderr)


if __name__ == "__main__":
    main()
