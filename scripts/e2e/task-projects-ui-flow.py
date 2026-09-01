#!/usr/bin/env python3
"""Compiled-Tauri acceptance flow for installation-local Hermes task projects."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

E2E_HELPER_DIR = Path(__file__).resolve().parent
if str(E2E_HELPER_DIR) not in sys.path:
    sys.path.insert(0, str(E2E_HELPER_DIR))

from e2e_run import (
    acquire_owned_directory,
    allocate_loopback_port,
    assert_binary_unchanged,
    assert_source_unchanged,
    capture_source_identity,
    generate_run_id,
    sha256_file,
    validate_run_id,
)

ROOT = Path(__file__).resolve().parents[2]
RUN_ID = validate_run_id(
    os.environ.get("THECHAT_E2E_RUN_ID") or generate_run_id("task-projects")
)
os.environ["THECHAT_E2E_RUN_ID"] = RUN_ID
EVIDENCE_ROOT = Path(
    os.environ.get(
        "THECHAT_TASK_PROJECTS_E2E_ROOT",
        str(Path.home() / ".cache" / "thechat-e2e" / "task-projects" / RUN_ID),
    )
).resolve()
SCREENSHOT_ORGANIZED = EVIDENCE_ROOT / "task-projects-organized.png"
SCREENSHOT_MENU = EVIDENCE_ROOT / "task-projects-move-menu.png"
UI_EVIDENCE = EVIDENCE_ROOT / "ui-evidence.json"
BUILD_EVIDENCE = EVIDENCE_ROOT / "build-evidence.json"
SUMMARY_EVIDENCE = EVIDENCE_ROOT / "summary.json"
THREAD_TITLES = [
    "Polish launch page",
    "Prepare launch checklist",
    "Interview beta users",
    "Summarize feedback",
    "Review analytics",
]

for port_key in (
    "THECHAT_E2E_API_PORT",
    "THECHAT_E2E_POSTGRES_PORT",
    "THECHAT_E2E_REDIS_PORT",
    "THECHAT_E2E_TAURI_DRIVER_PORT",
):
    os.environ.setdefault(port_key, str(allocate_loopback_port()))
os.environ.setdefault(
    "THECHAT_E2E_PG_CONTAINER", f"thechat-task-projects-postgres-{RUN_ID}"
)
os.environ.setdefault(
    "THECHAT_E2E_REDIS_CONTAINER", f"thechat-task-projects-redis-{RUN_ID}"
)
os.environ.setdefault("THECHAT_E2E_EVIDENCE_ROOT", str(EVIDENCE_ROOT / "harness"))


def load_harness_module():
    path = ROOT / "scripts" / "e2e" / "hermes-bot-flow.py"
    spec = importlib.util.spec_from_file_location("thechat_task_projects_harness", path)
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
    process = subprocess.Popen(
        cmd,
        cwd=ROOT,
        env=env,
        text=True,
        start_new_session=True,
    )
    try:
        return_code = process.wait(timeout=timeout)
    except BaseException:
        harness.terminate_process(process, timeout=10)
        raise
    if return_code != 0:
        harness.terminate_process(process, timeout=10)
        raise subprocess.CalledProcessError(return_code, cmd)


def thread_count(conversation_id: str) -> int:
    query = (
        "SELECT COUNT(*) FROM conversation_threads "
        f"WHERE conversation_id = '{conversation_id}';"
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


def main() -> None:
    started_at = datetime.now(timezone.utc).isoformat()
    source_identity = capture_source_identity(ROOT)
    acquire_owned_directory(EVIDENCE_ROOT, RUN_ID, "task-projects-evidence")
    env = child_env()
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
        "e2e/opt-in/task-projects.e2e.js",
    ]
    resource_identities = {
        "apiPort": harness.API_PORT,
        "postgresPort": harness.POSTGRES_PORT,
        "redisPort": harness.REDIS_PORT,
        "tauriDriverPort": int(os.environ["THECHAT_E2E_TAURI_DRIVER_PORT"]),
        "postgresContainer": harness.PG_CONTAINER,
        "redisContainer": harness.REDIS_CONTAINER,
    }
    api_process: subprocess.Popen[Any] | None = None
    completed = False

    try:
        harness.start_postgres()
        harness.start_redis()
        harness.run(
            [harness.PNPM, "--dir", "packages/api", "exec", "drizzle-kit", "migrate"],
            env=env,
        )
        api_process = harness.start_api(env)
        base = f"http://127.0.0.1:{harness.API_PORT}"
        email = f"task-projects-e2e-{int(time.time())}@example.com"
        password = "password123"

        status, registration = harness.http_json(
            "POST",
            f"{base}/auth/register",
            {"name": "Task Projects E2E", "email": email, "password": password},
        )
        assert status == 200, (status, registration)
        token = registration["accessToken"]
        status, workspace = harness.http_json(
            "POST",
            f"{base}/workspaces/create",
            {"name": "Local Projects Workspace"},
            token,
        )
        assert status == 200, (status, workspace)
        bot = harness.create_hermes_bot(
            base,
            token,
            workspace["id"],
            "Koda Projects E2E",
        )
        status, conversation = harness.http_json(
            "POST",
            f"{base}/conversations/dm",
            {"workspaceId": workspace["id"], "otherUserId": bot["userId"]},
            token,
        )
        assert status == 200, (status, conversation)
        conversation_id = conversation["id"]
        thread_ids: dict[str, str] = {}
        for title in THREAD_TITLES:
            status, thread = harness.http_json(
                "POST",
                f"{base}/conversations/threads/{conversation_id}",
                {"botId": bot["id"], "title": title},
                token,
            )
            assert status == 200, (status, thread)
            thread_ids[title] = thread["id"]

        count_before = thread_count(conversation_id)
        assert count_before == len(THREAD_TITLES)
        desktop_env = env | {
            "THECHAT_BACKEND_URL": base,
            "THECHAT_E2E_DISABLE_DOTENV": "1",
            "THECHAT_E2E_LOOPBACK_ONLY": "1",
            "TAURI_E2E": "1",
            "TASK_PROJECTS_E2E": "1",
            "WDIO_MOCHA_TIMEOUT": "240000",
            "TASK_PROJECTS_E2E_EMAIL": email,
            "TASK_PROJECTS_E2E_PASSWORD": password,
            "TASK_PROJECTS_E2E_BOT_NAME": bot["name"],
            "TASK_PROJECTS_E2E_CONVERSATION_ID": conversation_id,
            "TASK_PROJECTS_E2E_THREAD_IDS": json.dumps(thread_ids),
            "TASK_PROJECTS_E2E_SCREENSHOT_ORGANIZED": str(SCREENSHOT_ORGANIZED),
            "TASK_PROJECTS_E2E_SCREENSHOT_MENU": str(SCREENSHOT_MENU),
            "TASK_PROJECTS_E2E_EVIDENCE": str(UI_EVIDENCE),
            "TASK_PROJECTS_E2E_BUILD_EVIDENCE": str(BUILD_EVIDENCE),
            "THECHAT_E2E_DATA_ROOT": str(EVIDENCE_ROOT / "tauri-data"),
            "THECHAT_E2E_RUN_ID": RUN_ID,
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
        run_bounded(test_command, env=desktop_env, timeout=900)

        for artifact in (
            SCREENSHOT_ORGANIZED,
            SCREENSHOT_MENU,
            UI_EVIDENCE,
            BUILD_EVIDENCE,
        ):
            if not artifact.exists() or artifact.stat().st_size == 0:
                raise AssertionError(f"Expected E2E artifact was not produced: {artifact}")
        count_after = thread_count(conversation_id)
        if count_after != count_before:
            raise AssertionError(
                f"Project organization wrote backend threads: {count_before} -> {count_after}"
            )

        build_evidence = json.loads(BUILD_EVIDENCE.read_text(encoding="utf-8"))
        ui_evidence = json.loads(UI_EVIDENCE.read_text(encoding="utf-8"))
        if not ui_evidence.get("ok"):
            raise AssertionError("UI evidence did not report success")
        assert_source_unchanged(ROOT, source_identity)
        assert_binary_unchanged(
            Path(build_evidence["binary"]["path"]),
            build_evidence["binary"]["sha256"],
        )
        summary = {
            "ok": True,
            "runId": RUN_ID,
            "conversationId": conversation_id,
            "threadCountBefore": count_before,
            "threadCountAfter": count_after,
            "screenshots": [str(SCREENSHOT_ORGANIZED), str(SCREENSHOT_MENU)],
            "uiEvidence": str(UI_EVIDENCE),
            "uiEvidenceSha256": sha256_file(UI_EVIDENCE),
            "buildEvidence": str(BUILD_EVIDENCE),
            "buildEvidenceSha256": sha256_file(BUILD_EVIDENCE),
        }
        SUMMARY_EVIDENCE.write_text(json.dumps(summary, indent=2), encoding="utf-8")
        completed = True
        print(json.dumps(summary, indent=2))
    finally:
        harness.terminate_process(api_process, timeout=10)
        harness.remove_owned_container(harness.REDIS_CONTAINER, "redis")
        harness.remove_owned_container(harness.PG_CONTAINER, "postgres")
        if not completed:
            print(f"Preserved failed-run evidence under {EVIDENCE_ROOT}", file=sys.stderr)


if __name__ == "__main__":
    main()
