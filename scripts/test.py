#!/usr/bin/env python3
"""Run all test suites in parallel, only showing output from failures."""

import base64
import json
import os
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parent.parent
CREDENTIALS_FILE = ROOT / ".test-credentials.json"

# OpenAI device auth constants (same as packages/desktop/src/core/codex-auth.ts)
CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_ISSUER = "https://auth.openai.com"
CODEX_VERIFICATION_URL = "https://auth.openai.com/codex/device"



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


def is_postgres_running() -> bool:
    """Check if PostgreSQL is reachable using DATABASE_URL from env."""
    from urllib.parse import urlparse
    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        return False
    parsed = urlparse(db_url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 5432
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


def rust_cmd() -> list[str]:
    """Rust unit tests only — ignored tests are handled by opt-in suites (mcp, codex)."""
    return [
        "cargo",
        "test",
        "--manifest-path",
        "packages/desktop/src-tauri/Cargo.toml",
    ]


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
        "name": "openclaw-channel",
        "cmd": ["pnpm", "--filter", "@thechat/openclaw-channel", "test"],
    },
    {
        "name": "rust",
        "cmd": rust_cmd(),
    },
    {
        "name": "integration",
        "cmd": ["pnpm", "--filter", "@thechat/desktop", "test:integration"],
        "env": {"INTEGRATION": "true"},
    },
    {
        "name": "mcp",
        "cmd": [
            "cargo", "test",
            "--manifest-path", "packages/desktop/src-tauri/Cargo.toml",
            "mcp::tests", "--", "--ignored",
        ],
        "opt_in": True,  # local MCP integration tests (slow, needs npx)
    },
    {
        "name": "codex",
        "cmd": [
            "cargo", "test",
            "--manifest-path", "packages/desktop/src-tauri/Cargo.toml",
            "codex_live", "--", "--ignored",
        ],
        "opt_in": True,  # needs CODEX_ACCESS_TOKEN credentials
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


def _http_json(method: str, url: str, *, json_body: dict | None = None,
                form_body: dict | None = None) -> dict:
    """Minimal HTTP helper using only stdlib."""
    if json_body is not None:
        data = json.dumps(json_body).encode()
        content_type = "application/json"
    elif form_body is not None:
        data = urlencode(form_body).encode()
        content_type = "application/x-www-form-urlencoded"
    else:
        data = None
        content_type = None
    headers = {"User-Agent": "thechat-test/1.0"}
    if content_type:
        headers["Content-Type"] = content_type
    req = Request(url, data=data, headers=headers, method=method)
    with urlopen(req) as resp:
        return json.loads(resp.read())


def _parse_jwt_claims(token: str) -> dict:
    """Decode JWT payload (no signature verification — we trust the issuer)."""
    payload = token.split(".")[1]
    # Restore base64url → base64
    payload = payload.replace("-", "+").replace("_", "/")
    payload += "=" * ((4 - len(payload) % 4) % 4)
    return json.loads(base64.b64decode(payload))


def _extract_account_id(tokens: dict) -> str:
    """Extract chatgpt_account_id from id_token or access_token JWT claims."""
    for key in ("id_token", "access_token"):
        tok = tokens.get(key)
        if not tok:
            continue
        try:
            claims = _parse_jwt_claims(tok)
            if isinstance(claims.get("chatgpt_account_id"), str):
                return claims["chatgpt_account_id"]
            orgs = claims.get("organizations")
            if isinstance(orgs, list) and orgs and "id" in orgs[0]:
                return orgs[0]["id"]
        except Exception:
            continue
    return ""


def _refresh_tokens(refresh_token: str) -> dict:
    """Refresh access token using refresh_token grant."""
    return _http_json("POST", f"{CODEX_ISSUER}/oauth/token", form_body={
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CODEX_CLIENT_ID,
    })


def load_codex_credentials() -> dict | None:
    """Load and auto-refresh Codex credentials from .test-credentials.json.

    Returns dict with access_token, account_id (ready to use) or None.
    """
    if not CREDENTIALS_FILE.exists():
        return None
    creds = json.loads(CREDENTIALS_FILE.read_text())
    if not creds.get("access_token") or not creds.get("refresh_token"):
        return None

    # Refresh if within 60s of expiry
    expires_at = creds.get("expires_at", 0)
    if time.time() > expires_at - 60:
        try:
            tokens = _refresh_tokens(creds["refresh_token"])
            account_id = _extract_account_id(tokens) or creds.get("account_id", "")
            new_expires_at = time.time() + tokens.get("expires_in", 3600)
            creds = {
                "access_token": tokens["access_token"],
                "refresh_token": tokens["refresh_token"],
                "account_id": account_id,
                "expires_at": new_expires_at,
            }
            CREDENTIALS_FILE.write_text(json.dumps(creds, indent=2) + "\n")
        except Exception as e:
            print(f"\033[31mFailed to refresh Codex token: {e}\033[0m")
            print("Run 'python3 scripts/test.py init' to re-authenticate.")
            return None

    return creds


def cmd_init():
    """Run the OpenAI device auth flow and save credentials for testing."""
    print("Starting OpenAI Codex device authentication...\n")

    # Step 1: Request device code
    device = _http_json("POST", f"{CODEX_ISSUER}/api/accounts/deviceauth/usercode",
                        json_body={"client_id": CODEX_CLIENT_ID})
    device_auth_id = device["device_auth_id"]
    user_code = device["user_code"]
    interval = max(int(device.get("interval", 5)), 5)

    print(f"  Your code: \033[1;36m{user_code}\033[0m\n")
    print(f"  Go to: \033[4m{CODEX_VERIFICATION_URL}\033[0m")
    print(f"  Enter the code above and authorize the app.\n")

    print("Waiting for authorization", end="", flush=True)

    # Step 2: Poll until authorized
    while True:
        time.sleep(interval)
        print(".", end="", flush=True)
        try:
            poll_result = _http_json(
                "POST", f"{CODEX_ISSUER}/api/accounts/deviceauth/token",
                json_body={
                    "client_id": CODEX_CLIENT_ID,
                    "device_auth_id": device_auth_id,
                    "user_code": user_code,
                })
            # Success — got authorization_code
            break
        except Exception as e:
            err_str = str(e)
            # These are expected while waiting
            if "authorization_pending" in err_str or "slow_down" in err_str or "403" in err_str:
                continue
            print(f"\n\033[31mPoll error: {e}\033[0m")
            sys.exit(1)

    print(" authorized!\n")

    # Step 3: Exchange code for tokens
    auth_code = poll_result["authorization_code"]
    code_verifier = poll_result["code_verifier"]

    tokens = _http_json("POST", f"{CODEX_ISSUER}/oauth/token", form_body={
        "grant_type": "authorization_code",
        "code": auth_code,
        "redirect_uri": f"{CODEX_ISSUER}/deviceauth/callback",
        "client_id": CODEX_CLIENT_ID,
        "code_verifier": code_verifier,
    })

    account_id = _extract_account_id(tokens)
    expires_at = time.time() + tokens.get("expires_in", 3600)

    # Step 4: Save credentials
    creds = {
        "access_token": tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "account_id": account_id,
        "expires_at": expires_at,
    }
    CREDENTIALS_FILE.write_text(json.dumps(creds, indent=2) + "\n")

    print(f"\033[32mAuthentication successful!\033[0m")
    print(f"  Account ID: {account_id}")
    print(f"  Credentials saved to: {CREDENTIALS_FILE.relative_to(ROOT)}")
    print(f"\n  These credentials will auto-refresh when used by tests.")


def main():
    start = time.monotonic()

    args = sys.argv[1:]

    # Handle 'init' subcommands
    if args and args[0] == "init":
        cmd_init()
        return
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
    elif not run_all:
        # Exclude opt-in suites unless explicitly named or --all
        suites = [s for s in suites if not s.get("opt_in")]

    # Skip integration tests if backend is not running
    if any(s["name"] == "integration" for s in suites) and not is_backend_running():
        print(
            f"\033[33mSkipping integration tests: "
            f"backend not running on localhost:{BACKEND_PORT}\033[0m"
        )
        suites = [s for s in suites if s["name"] != "integration"]
        if not suites:
            sys.exit(0)

    # Skip API tests if PostgreSQL is not reachable
    if any(s["name"] == "api" for s in suites) and not is_postgres_running():
        print(
            "\033[33mSkipping API tests: "
            "PostgreSQL is not reachable\033[0m"
        )
        suites = [s for s in suites if s["name"] != "api"]
        if not suites:
            sys.exit(0)

    # Load Codex credentials for the codex suite
    if any(s["name"] == "codex" for s in suites):
        creds = load_codex_credentials()
        if not creds:
            print(
                "\033[33mSkipping codex tests: "
                "no credentials (run 'python3 scripts/test.py init' first)\033[0m"
            )
            suites = [s for s in suites if s["name"] != "codex"]
            if not suites:
                sys.exit(0)
        else:
            for s in suites:
                if s["name"] == "codex":
                    s["env"] = {
                        "CODEX_ACCESS_TOKEN": creds["access_token"],
                        "CODEX_ACCOUNT_ID": creds.get("account_id", ""),
                    }

    print(f"Running {len(suites)} test suite(s): {', '.join(s['name'] for s in suites)}")
    if not run_all:
        print("  (pass --all to include opt-in suites: mcp, codex)")
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
