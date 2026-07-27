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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

E2E_HELPER_DIR = Path(__file__).resolve().parent
if str(E2E_HELPER_DIR) not in sys.path:
    sys.path.insert(0, str(E2E_HELPER_DIR))

from e2e_run import (
    EVIDENCE_SCHEMA_VERSION,
    acquire_owned_directory,
    allocate_loopback_port,
    assert_binary_unchanged,
    assert_source_unchanged,
    capture_source_identity,
    generate_run_id,
    sha256_file,
    validate_evidence_metadata,
    validate_run_id,
)

ROOT = Path(__file__).resolve().parents[2]
RUN_ID = validate_run_id(
    os.environ.get("THECHAT_E2E_RUN_ID") or generate_run_id("new-task")
)
os.environ["THECHAT_E2E_RUN_ID"] = RUN_ID
EVIDENCE_ROOT = Path(
    os.environ.get(
        "THECHAT_NEW_TASK_E2E_ROOT",
        str(
            Path.home()
            / ".cache"
            / "thechat-e2e"
            / "new-task-client-side"
            / RUN_ID
        ),
    )
).resolve()
CONTROL_NAMESPACE = validate_run_id(
    os.environ.get("THECHAT_E2E_CONTROL_NAMESPACE", RUN_ID)
)
os.environ["THECHAT_E2E_CONTROL_NAMESPACE"] = CONTROL_NAMESPACE
CONTROL_DIR = EVIDENCE_ROOT / f"control-{CONTROL_NAMESPACE}"
SCREENSHOT = EVIDENCE_ROOT / "new-task-client-side.png"
UI_EVIDENCE = EVIDENCE_ROOT / "ui-evidence.json"
BUILD_EVIDENCE = EVIDENCE_ROOT / "build-evidence.json"
SUMMARY_EVIDENCE = EVIDENCE_ROOT / "summary.json"
ATTACHMENT_FIXTURE = EVIDENCE_ROOT / "old-draft.png"
RETRYABLE_PROMPT = "retryable first task prompt"

# Set isolated resource identities before loading the shared harness, whose
# constants are resolved at import time.
for port_key in (
    "THECHAT_E2E_API_PORT",
    "THECHAT_E2E_POSTGRES_PORT",
    "THECHAT_E2E_REDIS_PORT",
    "THECHAT_E2E_TAURI_DRIVER_PORT",
):
    os.environ.setdefault(port_key, str(allocate_loopback_port()))
os.environ.setdefault(
    "THECHAT_E2E_PG_CONTAINER", f"thechat-new-task-e2e-postgres-{RUN_ID}"
)
os.environ.setdefault(
    "THECHAT_E2E_REDIS_CONTAINER", f"thechat-new-task-e2e-redis-{RUN_ID}"
)
os.environ.setdefault("THECHAT_E2E_EVIDENCE_ROOT", str(EVIDENCE_ROOT / "harness"))


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
    api_holder: list[subprocess.Popen[Any] | None],
    conversation_id: str,
    env: dict[str, str],
    stop: threading.Event,
) -> None:
    try:
        wait_for_file(CONTROL_DIR / "offline.request", stop, "offline request")
        count_before = thread_count(conversation_id)
        harness.terminate_process(api_holder[0], timeout=10)
        api_holder[0] = None
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

        wait_for_file(
            CONTROL_DIR / "reconnect.request",
            stop,
            "controlled reconnect request",
        )
        harness.run(["docker", "start", harness.REDIS_CONTAINER])
        harness.wait_for(
            lambda: port_reachable(harness.REDIS_PORT),
            timeout=30,
            label="Redis restart",
        )
        api_holder[0] = harness.start_api(env, refuse_collision=False)
        write_json(
            CONTROL_DIR / "online.json",
            {
                "apiReachable": port_reachable(harness.API_PORT),
                "postgresReachable": port_reachable(harness.POSTGRES_PORT),
                "redisReachable": port_reachable(harness.REDIS_PORT),
                "threadCountAfterReconnect": thread_count(conversation_id),
            },
        )

        wait_for_file(
            CONTROL_DIR / "final-database.request",
            stop,
            "final database verification request",
        )
        message_query = (
            "SELECT COALESCE(json_agg(content ORDER BY created_at), '[]'::json) "
            "FROM messages "
            f"WHERE conversation_id = '{conversation_id}'::uuid;"
        )
        def read_message_contents() -> list[str]:
            return json.loads(
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
                        message_query,
                    ]
                )
            )

        harness.wait_for(
            lambda: RETRYABLE_PROMPT in read_message_contents(),
            timeout=30,
            label="retried first prompt persistence",
        )
        write_json(
            CONTROL_DIR / "final-database.json",
            {
                "threadCountFinal": thread_count(conversation_id),
                "messageContents": read_message_contents(),
            },
        )
    except BaseException as error:
        write_json(
            CONTROL_DIR / "control-error.json",
            {"type": type(error).__name__, "message": str(error)},
        )
        stop.set()


def main() -> None:
    started_at = datetime.now(timezone.utc).isoformat()
    source_identity = capture_source_identity(ROOT)
    acquire_owned_directory(EVIDENCE_ROOT, RUN_ID, "new-task-evidence")
    env = child_env()
    CONTROL_DIR.mkdir(parents=True, exist_ok=True)
    # A valid 1x1 transparent PNG used to prove image/attachment state is
    # scoped out of a newly mounted local draft.
    ATTACHMENT_FIXTURE.write_bytes(
        bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
            "890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082"
        )
    )
    resource_identities = {
        "controlNamespace": CONTROL_NAMESPACE,
        "evidenceRoot": str(EVIDENCE_ROOT),
        "controlDir": str(CONTROL_DIR),
        "apiPort": harness.API_PORT,
        "postgresPort": harness.POSTGRES_PORT,
        "redisPort": harness.REDIS_PORT,
        "tauriDriverPort": int(os.environ["THECHAT_E2E_TAURI_DRIVER_PORT"]),
        "postgresContainer": harness.PG_CONTAINER,
        "redisContainer": harness.REDIS_CONTAINER,
    }
    test_command = [
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
    ]

    api_holder: list[subprocess.Popen[Any] | None] = [None]
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
        api_holder[0] = harness.start_api(env)
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
            args=(api_holder, conversation_id, env, control_stop),
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
            "NEW_TASK_CLIENT_SIDE_E2E_BUILD_EVIDENCE": str(BUILD_EVIDENCE),
            "NEW_TASK_CLIENT_SIDE_E2E_ATTACHMENT": str(ATTACHMENT_FIXTURE),
            "NEW_TASK_CLIENT_SIDE_E2E_RETRYABLE_PROMPT": RETRYABLE_PROMPT,
            "THECHAT_E2E_DATA_ROOT": str(EVIDENCE_ROOT / "tauri-data"),
            "THECHAT_E2E_RUN_ID": RUN_ID,
            "THECHAT_E2E_CONTROL_NAMESPACE": CONTROL_NAMESPACE,
            "THECHAT_E2E_TAURI_DRIVER_PORT": os.environ[
                "THECHAT_E2E_TAURI_DRIVER_PORT"
            ],
            "THECHAT_E2E_BUILD_EVIDENCE": str(BUILD_EVIDENCE),
            "THECHAT_E2E_EXPECTED_SOURCE_IDENTITY": json.dumps(source_identity),
            "THECHAT_E2E_RESOURCE_IDENTITIES": json.dumps(resource_identities),
            "THECHAT_E2E_STARTED_AT": started_at,
            "THECHAT_E2E_TEST_COMMAND": json.dumps(test_command),
            "TMPDIR": str(EVIDENCE_ROOT / "tmp"),
        }
        Path(desktop_env["TMPDIR"]).mkdir(parents=True, exist_ok=True)
        desktop_env.pop("SKIP_BUILD", None)
        run_bounded(
            test_command,
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
        if not BUILD_EVIDENCE.exists() or BUILD_EVIDENCE.stat().st_size == 0:
            raise AssertionError(
                f"Tauri build evidence was not produced: {BUILD_EVIDENCE}"
            )

        build_evidence = json.loads(BUILD_EVIDENCE.read_text(encoding="utf-8"))
        validate_evidence_metadata(build_evidence, expected_run_id=RUN_ID)
        ui_evidence = json.loads(UI_EVIDENCE.read_text(encoding="utf-8"))
        binding = ui_evidence.get("binding")
        if not isinstance(binding, dict):
            raise AssertionError("UI evidence is missing its self-binding metadata")
        validate_evidence_metadata(binding, expected_run_id=RUN_ID)
        if binding["git"] != build_evidence["git"]:
            raise AssertionError("UI evidence Git identity does not match the build")
        if binding["binary"] != build_evidence["binary"]:
            raise AssertionError("UI evidence binary identity does not match the build")
        if binding["resources"] != build_evidence["resources"]:
            raise AssertionError("UI evidence resource identities do not match the build")
        if binding["testCommand"] != test_command:
            raise AssertionError("UI evidence test command does not match the invocation")

        assert_source_unchanged(ROOT, source_identity)
        assert_binary_unchanged(
            Path(build_evidence["binary"]["path"]),
            build_evidence["binary"]["sha256"],
        )
        summary_binding = {
            "schemaVersion": EVIDENCE_SCHEMA_VERSION,
            "runId": RUN_ID,
            "git": source_identity,
            "binary": build_evidence["binary"],
            "resources": resource_identities,
            "startedAt": started_at,
            "endedAt": datetime.now(timezone.utc).isoformat(),
            "testCommand": test_command,
        }
        validate_evidence_metadata(summary_binding, expected_run_id=RUN_ID)
        # Re-check immediately before atomically finalizing the Python summary.
        assert_source_unchanged(ROOT, source_identity)
        assert_binary_unchanged(
            Path(build_evidence["binary"]["path"]),
            build_evidence["binary"]["sha256"],
        )
        write_json(
            SUMMARY_EVIDENCE,
            {
                "ok": True,
                "binding": summary_binding,
                "uiEvidence": str(UI_EVIDENCE),
                "uiEvidenceSha256": sha256_file(UI_EVIDENCE),
                "buildEvidence": str(BUILD_EVIDENCE),
                "buildEvidenceSha256": sha256_file(BUILD_EVIDENCE),
            },
        )

        completed = True
        print(
            json.dumps(
                {
                    "ok": True,
                    "runId": RUN_ID,
                    "conversationId": conversation_id,
                    "existingThreadId": existing_thread["id"],
                    "existingThreadTitle": existing_thread_title,
                    "generalCacheWitness": general_cache_witness,
                    "screenshot": str(SCREENSHOT),
                    "evidence": str(UI_EVIDENCE),
                    "summary": str(SUMMARY_EVIDENCE),
                },
                indent=2,
            )
        )
    finally:
        control_stop.set()
        harness.terminate_process(api_holder[0], timeout=10)
        harness.remove_owned_container(harness.REDIS_CONTAINER, "redis")
        harness.remove_owned_container(harness.PG_CONTAINER, "postgres")
        if not completed:
            print(f"Preserved failed-run evidence under {EVIDENCE_ROOT}", file=sys.stderr)


if __name__ == "__main__":
    main()
