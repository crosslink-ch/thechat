#!/usr/bin/env python3
"""Run all test suites in parallel, only showing output from failures."""

import os
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_dotenv() -> None:
    """Load .env file into os.environ (without overriding existing vars)."""
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv()

BACKEND_PORT = int(os.environ.get("THECHAT_BACKEND_PORT", 3000))


def is_backend_running() -> bool:
    """Check if there's a process listening on the backend port."""
    try:
        with socket.create_connection(("localhost", BACKEND_PORT), timeout=1):
            return True
    except OSError:
        return False


def rust_cmd(include_ignored: bool) -> list[str]:
    cmd = [
        "cargo",
        "test",
        "--manifest-path",
        "packages/desktop/src-tauri/Cargo.toml",
    ]
    if include_ignored:
        cmd += ["--", "--include-ignored"]
    return cmd


SUITES = [
    {
        "name": "typecheck",
        "cmd": ["pnpm", "-r", "exec", "tsc", "--noEmit"],
    },
    {
        "name": "desktop",
        "cmd": ["pnpm", "--filter", "@thechat/desktop", "test:unit"],
    },
    {
        "name": "api",
        "cmd": ["pnpm", "--filter", "@thechat/api", "test"],
    },
    {
        "name": "rust",
        "cmd_fn": rust_cmd,
    },
    {
        "name": "integration",
        "cmd": ["pnpm", "--filter", "@thechat/desktop", "test:integration"],
        "env": {"INTEGRATION": "true"},
    },
]


@dataclass
class Result:
    name: str
    returncode: int
    output: str
    duration: float


def run_suite(suite: dict) -> Result:
    env = {**os.environ, **suite.get("env", {})}
    start = time.monotonic()
    proc = subprocess.run(
        suite["cmd"],
        capture_output=True,
        text=True,
        env=env,
        cwd=ROOT,
    )
    duration = time.monotonic() - start
    output = proc.stdout
    if proc.stderr:
        output += proc.stderr
    return Result(
        name=suite["name"],
        returncode=proc.returncode,
        output=output.strip(),
        duration=duration,
    )


def main():
    start = time.monotonic()

    args = sys.argv[1:]
    run_all = "--all" in args
    names = {a for a in args if not a.startswith("-")}

    suites = SUITES
    if names:
        unknown = names - {s["name"] for s in SUITES}
        if unknown:
            print(f"Unknown suites: {', '.join(unknown)}")
            print(f"Available: {', '.join(s['name'] for s in SUITES)}")
            sys.exit(1)
        suites = [s for s in SUITES if s["name"] in names]

    # Skip integration tests if backend is not running
    if any(s["name"] == "integration" for s in suites) and not is_backend_running():
        print(
            f"\033[33mSkipping integration tests: "
            f"backend not running on localhost:{BACKEND_PORT}\033[0m"
        )
        suites = [s for s in suites if s["name"] != "integration"]
        if not suites:
            sys.exit(0)

    # Resolve cmd_fn (used by rust suite to toggle --include-ignored)
    for s in suites:
        if "cmd_fn" in s:
            s["cmd"] = s["cmd_fn"](run_all)

    print(f"Running {len(suites)} test suite(s): {', '.join(s['name'] for s in suites)}")
    if not run_all:
        print("  (skipping slow tests — pass --all to include them)")
    print()

    results: list[Result] = []
    with ThreadPoolExecutor(max_workers=len(suites)) as pool:
        futures = {pool.submit(run_suite, s): s["name"] for s in suites}
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            status = "\033[32mPASS\033[0m" if result.returncode == 0 else "\033[31mFAIL\033[0m"
            print(f"  {status}  {result.name} ({result.duration:.1f}s)")

    total = time.monotonic() - start
    failed = [r for r in results if r.returncode != 0]
    passed = len(results) - len(failed)

    if failed:
        for r in failed:
            print()
            print(f"\033[31m{'=' * 60}\033[0m")
            print(f"\033[31m FAILED: {r.name}\033[0m")
            print(f"\033[31m{'=' * 60}\033[0m")
            print(r.output)

    print()
    if not failed:
        print(f"\033[32mAll {passed} suite(s) passed\033[0m in {total:.1f}s")
    else:
        print(
            f"\033[31m{len(failed)} failed\033[0m, {passed} passed in {total:.1f}s"
        )
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
