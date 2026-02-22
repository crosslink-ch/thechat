#!/usr/bin/env python3
"""Run all test suites in parallel, only showing output from failures."""

import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SUITES = [
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
        "cmd": [
            "cargo",
            "test",
            "--manifest-path",
            "packages/desktop/src-tauri/Cargo.toml",
        ],
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

    suites = SUITES
    if len(sys.argv) > 1:
        names = set(sys.argv[1:])
        unknown = names - {s["name"] for s in SUITES}
        if unknown:
            print(f"Unknown suites: {', '.join(unknown)}")
            print(f"Available: {', '.join(s['name'] for s in SUITES)}")
            sys.exit(1)
        suites = [s for s in SUITES if s["name"] in names]

    print(f"Running {len(suites)} test suite(s): {', '.join(s['name'] for s in suites)}")
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
