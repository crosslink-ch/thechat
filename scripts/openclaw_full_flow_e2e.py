#!/usr/bin/env python3
"""
Full-flow OpenClaw <-> TheChat end-to-end test orchestrator.

This script wires together a real OpenClaw runtime, the local TheChat
`@thechat/openclaw-channel` plugin, and a real TheChat API instance to
prove the round-trip:

  human DM in TheChat
    -> TheChat fires a signed webhook
    -> OpenClaw gateway (with the channel plugin installed) verifies it
    -> the OpenClaw agent (configured with OpenRouter) generates a reply
    -> the channel plugin posts the reply back to TheChat as a bot message
    -> the orchestrator polls TheChat and confirms the bot reply arrived.

It is opt-in. By default `python3 scripts/test.py` will not run this; set
`OPENCLAW_E2E_FULL=1` (and provide the env vars listed below) to invoke it.

The script loads `.env` from the repository root without overriding variables
already present in the process environment.

Required environment:
  OPENROUTER_API_KEY
      OpenRouter API key. Used by OpenClaw to call OpenRouter. NEVER logged
      or written to disk by this script. Forwarded only via the OpenClaw
      child process environment.
  DATABASE_URL
      Postgres URL the TheChat API will use. Same shape as `.env`. Required
      only when no existing TheChat API URL is configured.

Optional environment:
  OPENCLAW_E2E_FULL=1
      Required to actually run the suite. When unset the script exits 0
      with a "skipped" message so it can be wired into `scripts/test.py`
      as an opt-in suite.
  OPENCLAW_E2E_RUNTIME
      OpenClaw runtime backend: `docker` (default) or `source`.
      Docker uses the prebuilt OpenClaw image and does not clone/build
      OpenClaw locally. Source keeps the older clone/build path for
      debugging OpenClaw itself.
  OPENCLAW_E2E_DOCKER_IMAGE
      Docker image used when OPENCLAW_E2E_RUNTIME=docker. Defaults to
      `ghcr.io/openclaw/openclaw:2026.4.26-slim`.
  OPENCLAW_E2E_DOCKER_PULL
      Docker image pull policy: `missing` (default), `always`, or `never`.
  OPENCLAW_E2E_MODEL
      Model id passed as `agents.defaults.model.primary`. Defaults to
      `openrouter/openai/gpt-5.4-nano`. The full agent path requires a
      tool-capable model; raw completion-only models can fail once OpenClaw
      sends tools.
  OPENCLAW_E2E_OPENCLAW_REPO
      Git URL to clone. Defaults to `https://github.com/openclaw/openclaw.git`.
      Used only when OPENCLAW_E2E_RUNTIME=source.
  OPENCLAW_E2E_OPENCLAW_REF
      Branch/tag/sha to check out. Defaults to `main`.
      Used only when OPENCLAW_E2E_RUNTIME=source.
  OPENCLAW_E2E_CACHE_DIR
      Persistent dir for the OpenClaw clone + build. Defaults to
      `.openclaw-e2e/cache` under this repo. Reusing the cache skips a slow
      pnpm install + build on subsequent runs.
      Used only when OPENCLAW_E2E_RUNTIME=source.
  OPENCLAW_E2E_WORK_DIR
      Parent directory for per-run isolated OpenClaw state, logs, and other
      scratch data. Defaults to `.openclaw-e2e/work` under this repo. This
      avoids using `/tmp` by default, which can be memory-backed on dev boxes.
  OPENCLAW_E2E_ALLOW_STALE_CACHE=1
      If fetching the requested OpenClaw ref fails, continue with the
      existing cached checkout instead of failing fast. Default is fail-fast
      so the suite does not silently run against stale OpenClaw code.
  OPENCLAW_E2E_SKIP_BUILD=1
      Skip `pnpm install` + `pnpm build` even when `dist/entry.js` is
      missing. Only useful when you have manually preloaded the cache.
  OPENCLAW_E2E_KEEP_TEMP=1
      Do not delete the per-run temp state dir on exit (helpful for
      post-mortem inspection of OpenClaw logs and config).
  OPENCLAW_E2E_RESPONSE_TIMEOUT
      Seconds to wait for a bot reply once the human message is sent.
      Defaults to 180.
  OPENCLAW_E2E_GATEWAY_STARTUP_TIMEOUT
      Seconds to wait for the OpenClaw gateway to become ready. Defaults to
      300 because the slim Docker image stages runtime dependencies on first
      boot.
  OPENCLAW_E2E_TOTAL_TIMEOUT
      Hard ceiling (seconds) for the full orchestration. Defaults to 900.
  THECHAT_BACKEND_URL
      If set, the script uses an already-running TheChat API at that URL
      and skips spawning its own. Otherwise a fresh API is started on an
      ephemeral port using the local source tree.
  THECHAT_API_URL
      Deprecated fallback for THECHAT_BACKEND_URL.

Secrets handling:
  - The orchestrator never logs the OpenRouter key, the bot API key, or
    the bot webhook secret. `_redact()` is applied to anything that goes
    through `log()`.
  - The on-disk OpenClaw config still contains the secrets it needs (this
    is unavoidable for the agent to actually call OpenRouter). The temp
    state dir is cleaned up on exit unless `OPENCLAW_E2E_KEEP_TEMP=1`.

Wired into `scripts/test.py` as the opt-in `openclaw-full-e2e` suite.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_DIR = ROOT / "packages" / "openclaw-channel-thechat"

DEFAULT_RUNTIME = "docker"
DEFAULT_DOCKER_IMAGE = "ghcr.io/openclaw/openclaw:2026.4.26-slim"
DEFAULT_DOCKER_PULL = "missing"
DEFAULT_MODEL = "openrouter/openai/gpt-5.4-nano"
DEFAULT_REPO = "https://github.com/openclaw/openclaw.git"
DEFAULT_REF = "main"
DEFAULT_WORK_DIR = ROOT / ".openclaw-e2e" / "work"
DEFAULT_CACHE_DIR = ROOT / ".openclaw-e2e" / "cache"
WEBHOOK_PATH = "/thechat/webhook"
DOCKER_OPENCLAW_HOME = "/home/node/.openclaw"
DOCKER_GATEWAY_PORT = 18789


# ---------------------------------------------------------------------------
# Logging with secret redaction
# ---------------------------------------------------------------------------

_REDACT_VALUES: list[str] = []


def load_dotenv() -> None:
    """Load repo-root .env into os.environ without overriding existing vars."""
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("\"'")
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv()


def register_secret(value: Optional[str]) -> None:
    """Register a string that must never appear in stdout/stderr."""
    if value and len(value) >= 6:
        _REDACT_VALUES.append(value)


def _redact(text: str) -> str:
    out = text
    for v in _REDACT_VALUES:
        if v and v in out:
            out = out.replace(v, "***REDACTED***")
    # Also redact `bot_...` and `whsec_...` shapes defensively even when not
    # registered yet.
    out = re.sub(r"\bbot_[A-Za-z0-9_-]{8,}", "bot_***REDACTED***", out)
    out = re.sub(r"\bwhsec_[A-Za-z0-9_-]{8,}", "whsec_***REDACTED***", out)
    out = re.sub(r"\bsk-or-[A-Za-z0-9_-]{8,}", "sk-or-***REDACTED***", out)
    return out


def log(msg: str) -> None:
    print(_redact(f"[openclaw-e2e] {msg}"), flush=True)


def err(msg: str) -> None:
    print(_redact(f"[openclaw-e2e] ERROR: {msg}"), file=sys.stderr, flush=True)


def warn(msg: str) -> None:
    print(_redact(f"[openclaw-e2e] WARN: {msg}"), file=sys.stderr, flush=True)


def resolve_thechat_url_override() -> tuple[str, str]:
    backend_url = os.environ.get("THECHAT_BACKEND_URL", "").strip().rstrip("/")
    legacy_url = os.environ.get("THECHAT_API_URL", "").strip().rstrip("/")

    if backend_url:
        if legacy_url and legacy_url != backend_url:
            warn(
                "both THECHAT_BACKEND_URL and deprecated THECHAT_API_URL are set; "
                "using THECHAT_BACKEND_URL"
            )
        return backend_url, "THECHAT_BACKEND_URL"

    if legacy_url:
        warn("THECHAT_API_URL is deprecated; use THECHAT_BACKEND_URL instead")
        return legacy_url, "THECHAT_API_URL"

    return "", ""


def resolve_openclaw_runtime() -> str:
    runtime = os.environ.get("OPENCLAW_E2E_RUNTIME", DEFAULT_RUNTIME).strip().lower()
    if runtime not in ("docker", "source"):
        raise SystemExit(
            "OPENCLAW_E2E_RUNTIME must be either 'docker' or 'source' "
            f"(got {runtime!r})"
        )
    return runtime


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError as e:
        raise SystemExit(f"{name} must be a number (got {raw!r})") from e


def rewrite_localhost_url_for_docker(url: str) -> str:
    """Return a host URL that is reachable from Docker bridge networking."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        return url

    hostname = "host.docker.internal"
    if parsed.port is not None:
        netloc = f"{hostname}:{parsed.port}"
    else:
        netloc = hostname
    if parsed.username:
        userinfo = urllib.parse.quote(parsed.username, safe="")
        if parsed.password:
            userinfo += f":{urllib.parse.quote(parsed.password, safe='')}"
        netloc = f"{userinfo}@{netloc}"

    return urllib.parse.urlunsplit(
        (parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment)
    )


# ---------------------------------------------------------------------------
# Process / port helpers
# ---------------------------------------------------------------------------


def free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for_port(host: str, port: int, timeout_s: float) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1):
                return True
        except OSError:
            time.sleep(0.25)
    return False


def wait_for_http(url: str, timeout_s: float) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if 200 <= resp.status < 500:
                    return True
        except (
            urllib.error.URLError,
            urllib.error.HTTPError,
            ConnectionError,
            TimeoutError,
            socket.timeout,
            OSError,
        ):
            pass
        time.sleep(0.5)
    return False


def wait_for_webhook_responsive(url: str, timeout_s: float) -> bool:
    """Wait until the plugin webhook route can reject an invalid request fast."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        req = urllib.request.Request(
            url,
            data=b"{}",
            headers={
                "Content-Type": "application/json",
                "User-Agent": "thechat-openclaw-e2e/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=2) as resp:
                if 200 <= resp.status < 500:
                    return True
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403):
                return True
        except (
            urllib.error.URLError,
            ConnectionError,
            TimeoutError,
            socket.timeout,
            OSError,
        ):
            pass
        time.sleep(0.5)
    return False


def kill_proc(proc: Optional[subprocess.Popen]) -> None:
    if proc is None or proc.poll() is not None:
        return
    # Both subprocess types we spawn use start_new_session=True, so they own a
    # process group. Signal the whole group so node + any children die.
    try:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                proc.kill()
            proc.wait(timeout=5)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------


def http(
    method: str,
    url: str,
    body: Optional[dict[str, Any]] = None,
    token: Optional[str] = None,
    timeout: float = 30.0,
) -> tuple[int, Any]:
    headers = {"User-Agent": "thechat-openclaw-e2e/1.0"}
    data: Optional[bytes] = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode()
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                parsed = text
            return resp.status, parsed
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = text
        return e.code, parsed


# ---------------------------------------------------------------------------
# OpenClaw clone + build
# ---------------------------------------------------------------------------


def ensure_openclaw_checkout(repo: str, ref: str, cache_dir: Path) -> Path:
    allow_stale_cache = os.environ.get("OPENCLAW_E2E_ALLOW_STALE_CACHE") == "1"

    def sync_to_ref(checkout_dir: Path) -> None:
        fetch = subprocess.run(
            ["git", "-C", str(checkout_dir), "fetch", "--depth=1", "origin", ref],
            check=False,
            capture_output=True,
            text=True,
        )
        if fetch.returncode == 0:
            subprocess.run(
                ["git", "-C", str(checkout_dir), "checkout", "--force", "FETCH_HEAD"],
                check=True,
                capture_output=True,
                text=True,
            )
            return

        warn(
            "failed to fetch requested OpenClaw ref "
            f"{ref!r}; fetch stderr follows:\n{fetch.stderr.strip() or fetch.stdout.strip()}"
        )
        if not allow_stale_cache:
            raise SystemExit(
                "unable to fetch requested OpenClaw ref; refusing to run on stale "
                "cache. Set OPENCLAW_E2E_ALLOW_STALE_CACHE=1 to override."
            )

        warn(
            "OPENCLAW_E2E_ALLOW_STALE_CACHE=1 set; continuing with existing cached "
            "OpenClaw checkout."
        )
        local_checkout = subprocess.run(
            ["git", "-C", str(checkout_dir), "checkout", "--force", ref],
            check=False,
            capture_output=True,
            text=True,
        )
        if local_checkout.returncode != 0:
            warn(
                "requested ref is not present in local cache either; keeping current "
                "HEAD unchanged."
            )

    cache_dir.mkdir(parents=True, exist_ok=True)
    checkout = cache_dir / "openclaw"
    if (checkout / ".git").is_dir():
        log(f"reusing cached OpenClaw checkout at {checkout}")
        subprocess.run(
            ["git", "-C", str(checkout), "remote", "set-url", "origin", repo],
            check=True,
            capture_output=True,
            text=True,
        )
        sync_to_ref(checkout)
    else:
        log(f"cloning {repo} into {checkout}")
        subprocess.run(
            ["git", "clone", "--depth=1", repo, str(checkout)],
            check=True,
        )
        sync_to_ref(checkout)
    rev = subprocess.run(
        ["git", "-C", str(checkout), "rev-parse", "--short=12", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    log(f"OpenClaw checkout ready at commit {rev}")
    return checkout


def build_openclaw_if_needed(checkout: Path, skip_build: bool) -> None:
    entry = checkout / "dist" / "entry.js"
    if skip_build:
        if not entry.exists():
            warn(
                "OPENCLAW_E2E_SKIP_BUILD=1 but dist/entry.js is missing — OpenClaw will fail to launch."
            )
        else:
            log("skipping OpenClaw build (OPENCLAW_E2E_SKIP_BUILD=1)")
        return
    if entry.exists():
        log("OpenClaw build artifact present, skipping pnpm install + build")
        return

    log("running pnpm install for OpenClaw (slow, one-time per cache)")
    subprocess.run(
        ["pnpm", "install", "--frozen-lockfile=false"],
        check=True,
        cwd=checkout,
    )
    log("running pnpm build for OpenClaw")
    subprocess.run(["pnpm", "build"], check=True, cwd=checkout)


# ---------------------------------------------------------------------------
# OpenClaw config writing
# ---------------------------------------------------------------------------


def write_openclaw_config(
    state_dir: Path,
    *,
    gateway_port: int,
    gateway_bind: str = "loopback",
    gateway_auth: str = "none",
    thechat_base_url: str,
    bot_id: str,
    bot_user_id: str,
    bot_api_key: str,
    bot_webhook_secret: str,
    bot_name: str,
    model_primary: str,
    openrouter_api_key: str,
    workspace_path: Optional[str] = None,
    include_thechat_channel: bool = True,
) -> Path:
    state_dir.mkdir(parents=True, exist_ok=True)
    workspace = state_dir / "workspace"
    workspace.mkdir(exist_ok=True)
    effective_workspace = workspace_path or str(workspace)
    config_path = state_dir / "openclaw.json"
    cfg: dict[str, Any] = {
        "gateway": {
            "mode": "local",
            "port": gateway_port,
            "bind": gateway_bind,
            "auth": {"mode": gateway_auth},
            "controlUi": {"enabled": False},
        },
        "env": {
            "vars": {
                "OPENROUTER_API_KEY": openrouter_api_key,
            }
        },
        "agents": {
            "defaults": {
                "workspace": effective_workspace,
                "model": {"primary": model_primary},
                "elevatedDefault": "off",
                "thinkingDefault": "off",
                "timeoutSeconds": 240,
                # The channel e2e only needs a short natural-language reply.
                # Loading every local OpenClaw skill makes first-turn prompt
                # preparation noisy and slow, and can dominate this test.
                "skills": [],
            },
            "list": [{"id": "main", "default": True, "skills": []}],
        },
    }
    if include_thechat_channel:
        cfg["channels"] = {
            "thechat": {
                "baseUrl": thechat_base_url,
                "botId": bot_id,
                "botUserId": bot_user_id,
                "botName": bot_name,
                "apiKey": bot_api_key,
                "webhookSecret": bot_webhook_secret,
                "requireMentionInChannels": False,
                "allowOtherBots": False,
            }
        }
    config_path.write_text(json.dumps(cfg, indent=2))
    # Restrict permissions because the file contains the bot key + webhook
    # secret + OpenRouter key.
    try:
        os.chmod(config_path, 0o600)
    except OSError:
        pass
    return config_path


def enable_thechat_channel_in_config(
    config_path: Path,
    *,
    thechat_base_url: str,
    bot_id: str,
    bot_user_id: str,
    bot_api_key: str,
    bot_webhook_secret: str,
    bot_name: str,
) -> None:
    try:
        cfg = json.loads(config_path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(f"failed to read OpenClaw config for channel wiring: {e}") from e

    channels = cfg.setdefault("channels", {})
    channels["thechat"] = {
        "baseUrl": thechat_base_url,
        "botId": bot_id,
        "botUserId": bot_user_id,
        "botName": bot_name,
        "apiKey": bot_api_key,
        "webhookSecret": bot_webhook_secret,
        "requireMentionInChannels": False,
        "allowOtherBots": False,
    }

    try:
        config_path.write_text(json.dumps(cfg, indent=2))
    except OSError as e:
        raise SystemExit(f"failed to update OpenClaw config with TheChat channel: {e}") from e

    try:
        os.chmod(config_path, 0o600)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# TheChat API process
# ---------------------------------------------------------------------------


def start_thechat_api(port: int, log_path: Path) -> subprocess.Popen:
    log(f"starting TheChat API on port {port}")
    log_fh = log_path.open("w")
    env = os.environ.copy()
    env["THECHAT_BACKEND_PORT"] = str(port)
    env["LOG_LEVEL"] = env.get("LOG_LEVEL", "warn")
    proc = subprocess.Popen(
        ["bun", "run", str(ROOT / "packages" / "api" / "src" / "index.ts")],
        cwd=ROOT,
        env=env,
        stdout=log_fh,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return proc


# ---------------------------------------------------------------------------
# OpenClaw gateway process
# ---------------------------------------------------------------------------


def stage_thechat_plugin(state_dir: Path) -> Path:
    staged_plugin_dir = state_dir / "plugin-source" / "thechat-channel"
    shutil.rmtree(staged_plugin_dir.parent, ignore_errors=True)
    shutil.copytree(
        PLUGIN_DIR,
        staged_plugin_dir,
        ignore=shutil.ignore_patterns("node_modules", ".git", ".turbo"),
    )
    return staged_plugin_dir


def install_thechat_plugin_from_source(
    checkout: Path,
    state_dir: Path,
    config_path: Path,
    openrouter_api_key: str,
) -> None:
    log("installing TheChat OpenClaw channel plugin (linked from local checkout)")
    staged_plugin_dir = stage_thechat_plugin(state_dir)

    env = os.environ.copy()
    env["OPENCLAW_HOME"] = str(state_dir)
    env["OPENCLAW_STATE_DIR"] = str(state_dir)
    env["OPENCLAW_CONFIG_PATH"] = str(config_path)
    env["OPENROUTER_API_KEY"] = openrouter_api_key
    # `plugins install -l <path>` adds the path to plugins.load.paths and
    # writes an installs record to plugins/installs.json. `--force` lets it
    # overwrite a stale record from a prior run sharing the same cache.
    cmd = [
        "node",
        str(checkout / "openclaw.mjs"),
        "plugins",
        "install",
        "-l",
        str(staged_plugin_dir),
        "--force",
    ]
    res = subprocess.run(cmd, cwd=checkout, env=env, capture_output=True, text=True)
    if res.returncode != 0:
        # Fall back to install without --force in case the version doesn't
        # support that flag for linked installs.
        log(
            "linked install with --force failed; retrying without --force "
            f"(rc={res.returncode})"
        )
        cmd_no_force = [c for c in cmd if c != "--force"]
        res2 = subprocess.run(
            cmd_no_force, cwd=checkout, env=env, capture_output=True, text=True
        )
        if res2.returncode != 0:
            err("plugin install failed; OpenClaw stdout:")
            err(res2.stdout)
            err("OpenClaw stderr:")
            err(res2.stderr)
            raise SystemExit(
                f"openclaw plugins install failed (rc={res2.returncode})"
            )
    installs_path = state_dir / "plugins" / "installs.json"
    if not installs_path.exists():
        raise SystemExit(
            f"plugin install did not create expected state file: {installs_path}"
        )
    try:
        installs_raw = installs_path.read_text(errors="replace")
    except OSError as e:
        raise SystemExit(f"failed reading plugin install state: {e}") from e
    if str(staged_plugin_dir) not in installs_raw:
        raise SystemExit(
            "plugin install state does not reference the local TheChat plugin "
            f"path: {staged_plugin_dir}"
        )


def start_openclaw_gateway(
    checkout: Path,
    state_dir: Path,
    config_path: Path,
    openrouter_api_key: str,
    log_path: Path,
    port: int,
) -> subprocess.Popen:
    log(f"starting OpenClaw gateway on port {port}")
    env = os.environ.copy()
    env["OPENCLAW_HOME"] = str(state_dir)
    env["OPENCLAW_STATE_DIR"] = str(state_dir)
    env["OPENCLAW_CONFIG_PATH"] = str(config_path)
    env["OPENROUTER_API_KEY"] = openrouter_api_key
    log_fh = log_path.open("w")
    proc = subprocess.Popen(
        [
            "node",
            str(checkout / "openclaw.mjs"),
            "gateway",
            "run",
            "--port",
            str(port),
            "--bind",
            "loopback",
            "--auth",
            "none",
            "--allow-unconfigured",
        ],
        cwd=checkout,
        env=env,
        stdout=log_fh,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return proc


def docker_openclaw_base_args(state_dir: Path) -> list[str]:
    return [
        "--add-host",
        "host.docker.internal:host-gateway",
        "-e",
        f"OPENCLAW_HOME={DOCKER_OPENCLAW_HOME}",
        "-e",
        f"OPENCLAW_STATE_DIR={DOCKER_OPENCLAW_HOME}",
        "-e",
        f"OPENCLAW_CONFIG_PATH={DOCKER_OPENCLAW_HOME}/openclaw.json",
        "-e",
        "OPENROUTER_API_KEY",
        "-e",
        "OPENCLAW_DISABLE_BONJOUR=1",
        "-v",
        f"{state_dir.resolve()}:{DOCKER_OPENCLAW_HOME}",
    ]


def ensure_docker_image(image: str, pull_policy: str) -> None:
    if pull_policy not in ("missing", "always", "never"):
        raise SystemExit(
            "OPENCLAW_E2E_DOCKER_PULL must be 'missing', 'always', or 'never' "
            f"(got {pull_policy!r})"
        )

    inspect = subprocess.run(
        ["docker", "image", "inspect", image],
        check=False,
        capture_output=True,
        text=True,
    )
    image_present = inspect.returncode == 0
    if pull_policy == "never":
        if not image_present:
            raise SystemExit(
                f"Docker image {image!r} is not present and "
                "OPENCLAW_E2E_DOCKER_PULL=never"
            )
        log(f"using existing Docker image {image}")
        return

    if pull_policy == "always" or not image_present:
        reason = (
            "pull policy is always" if pull_policy == "always" else "image missing"
        )
        log(f"pulling OpenClaw Docker image {image} ({reason})")
        subprocess.run(["docker", "pull", image], check=True)
    else:
        log(f"using existing Docker image {image}")


def install_thechat_plugin_from_docker(
    image: str,
    state_dir: Path,
    openrouter_api_key: str,
) -> None:
    log("installing TheChat OpenClaw channel plugin inside Docker image")
    staged_plugin_dir = stage_thechat_plugin(state_dir)
    staged_plugin_container_path = (
        f"{DOCKER_OPENCLAW_HOME}/plugin-source/thechat-channel"
    )

    env = os.environ.copy()
    env["OPENROUTER_API_KEY"] = openrouter_api_key

    def run_install(extra_args: list[str]) -> subprocess.CompletedProcess[str]:
        cmd = [
            "docker",
            "run",
            "--rm",
            *docker_openclaw_base_args(state_dir),
            image,
            "node",
            "openclaw.mjs",
            "plugins",
            "install",
            "-l",
            staged_plugin_container_path,
            *extra_args,
        ]
        return subprocess.run(cmd, env=env, capture_output=True, text=True)

    res = run_install(["--force"])
    if res.returncode != 0:
        log(
            "Docker linked install with --force failed; retrying without "
            f"--force (rc={res.returncode})"
        )
        res = run_install([])
    if res.returncode != 0:
        err("plugin install failed; OpenClaw stdout:")
        err(res.stdout)
        err("OpenClaw stderr:")
        err(res.stderr)
        raise SystemExit(f"openclaw plugins install failed (rc={res.returncode})")

    installs_path = state_dir / "plugins" / "installs.json"
    if not installs_path.exists():
        raise SystemExit(
            f"plugin install did not create expected state file: {installs_path}"
        )
    try:
        installs_raw = installs_path.read_text(errors="replace")
    except OSError as e:
        raise SystemExit(f"failed reading plugin install state: {e}") from e
    if (
        staged_plugin_container_path not in installs_raw
        and str(staged_plugin_dir) not in installs_raw
    ):
        raise SystemExit(
            "plugin install state does not reference the local TheChat plugin "
            f"path: {staged_plugin_container_path}"
        )


def start_openclaw_gateway_docker(
    image: str,
    state_dir: Path,
    openrouter_api_key: str,
    gateway_token: str,
    log_path: Path,
    host_port: int,
    container_name: str,
) -> subprocess.Popen:
    log(
        f"starting OpenClaw Docker gateway {container_name} on host port "
        f"{host_port}"
    )
    env = os.environ.copy()
    env["OPENROUTER_API_KEY"] = openrouter_api_key
    env["OPENCLAW_GATEWAY_TOKEN"] = gateway_token
    log_fh = log_path.open("w")
    proc = subprocess.Popen(
        [
            "docker",
            "run",
            "--rm",
            "--name",
            container_name,
            "-p",
            f"127.0.0.1:{host_port}:{DOCKER_GATEWAY_PORT}",
            "-e",
            "OPENCLAW_GATEWAY_TOKEN",
            *docker_openclaw_base_args(state_dir),
            image,
            "node",
            "openclaw.mjs",
            "gateway",
            "--bind",
            "lan",
            "--port",
            str(DOCKER_GATEWAY_PORT),
        ],
        env=env,
        stdout=log_fh,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return proc


def stop_docker_container(container_name: Optional[str]) -> None:
    if not container_name:
        return
    subprocess.run(
        ["docker", "rm", "-f", container_name],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


# ---------------------------------------------------------------------------
# TheChat setup helpers (flow steps 2-9 in the simulated test, but real)
# ---------------------------------------------------------------------------


def setup_thechat_state(
    base_url: str,
) -> dict[str, Any]:
    """Register a human, create a workspace, create a bot. Returns ids/keys."""

    human_email = f"openclaw-e2e-{uuid.uuid4()}@example.test"
    human_password = "test-only-password-do-not-rotate"

    log(f"registering human {human_email}")
    status, body = http(
        "POST",
        f"{base_url}/auth/register",
        body={
            "name": "OpenClaw E2E Human",
            "email": human_email,
            "password": human_password,
        },
    )
    if status != 200 or not isinstance(body, dict) or "accessToken" not in body:
        raise SystemExit(f"register failed: {status} {body}")
    human_token = body["accessToken"]
    human_user_id = body["user"]["id"]

    log("creating workspace")
    status, body = http(
        "POST",
        f"{base_url}/workspaces/create",
        body={"name": f"openclaw-e2e-{int(time.time())}"},
        token=human_token,
    )
    if status != 200 or not isinstance(body, dict) or "id" not in body:
        raise SystemExit(f"workspace create failed: {status} {body}")
    workspace_id = body["id"]

    log("creating bot")
    status, body = http(
        "POST",
        f"{base_url}/bots/create",
        body={"name": "OpenClaw E2E Bot"},
        token=human_token,
    )
    if status != 200 or not isinstance(body, dict) or "apiKey" not in body:
        raise SystemExit(f"bot create failed: {status} {body}")
    bot_id: str = body["id"]
    bot_user_id: str = body["userId"]
    bot_api_key: str = body["apiKey"]
    bot_webhook_secret: str = body["webhookSecret"]
    register_secret(bot_api_key)
    register_secret(bot_webhook_secret)

    return {
        "human_email": human_email,
        "human_token": human_token,
        "human_user_id": human_user_id,
        "workspace_id": workspace_id,
        "bot_id": bot_id,
        "bot_user_id": bot_user_id,
        "bot_api_key": bot_api_key,
        "bot_webhook_secret": bot_webhook_secret,
    }


def configure_bot_webhook(
    base_url: str, bot_id: str, webhook_url: str, token: str
) -> None:
    log(f"setting bot webhook URL to {webhook_url}")
    status, body = http(
        "PATCH",
        f"{base_url}/bots/{bot_id}",
        body={"webhookUrl": webhook_url},
        token=token,
    )
    if status != 200:
        raise SystemExit(f"bot patch failed: {status} {body}")


def add_bot_to_workspace(
    base_url: str, bot_id: str, workspace_id: str, token: str
) -> None:
    log("adding bot to workspace")
    status, body = http(
        "POST",
        f"{base_url}/bots/{bot_id}/workspaces",
        body={"workspaceId": workspace_id},
        token=token,
    )
    if status != 200:
        raise SystemExit(f"add bot to workspace failed: {status} {body}")


def create_dm(
    base_url: str, workspace_id: str, other_user_id: str, token: str
) -> str:
    log("creating DM with bot")
    status, body = http(
        "POST",
        f"{base_url}/conversations/dm",
        body={"workspaceId": workspace_id, "otherUserId": other_user_id},
        token=token,
    )
    if status != 200 or not isinstance(body, dict) or "id" not in body:
        raise SystemExit(f"dm create failed: {status} {body}")
    return body["id"]


def send_human_message(
    base_url: str, conversation_id: str, content: str, token: str
) -> str:
    log(f"sending human message: {content!r}")
    status, body = http(
        "POST",
        f"{base_url}/messages/{conversation_id}",
        body={"content": content},
        token=token,
    )
    if status != 200 or not isinstance(body, dict) or "id" not in body:
        raise SystemExit(f"send message failed: {status} {body}")
    return body["id"]


def poll_for_bot_reply(
    base_url: str,
    conversation_id: str,
    bot_user_id: str,
    after_ms: int,
    token: str,
    timeout_s: float,
) -> Optional[dict[str, Any]]:
    """Return the first message after `after_ms` whose senderType==bot."""
    deadline = time.monotonic() + timeout_s
    poll_interval = 1.0
    while time.monotonic() < deadline:
        status, body = http(
            "GET",
            f"{base_url}/messages/{conversation_id}?limit=50",
            token=token,
        )
        if status == 200 and isinstance(body, list):
            for m in body:
                if (
                    isinstance(m, dict)
                    and m.get("senderType") == "bot"
                    and m.get("senderId") == bot_user_id
                ):
                    # Tolerate either ISO timestamp or numeric epoch ms.
                    created_at = m.get("createdAt")
                    if isinstance(created_at, str):
                        try:
                            from datetime import datetime, timezone

                            ts_ms = int(
                                datetime.fromisoformat(
                                    created_at.replace("Z", "+00:00")
                                )
                                .astimezone(timezone.utc)
                                .timestamp()
                                * 1000
                            )
                        except ValueError:
                            ts_ms = after_ms + 1
                    elif isinstance(created_at, (int, float)):
                        ts_ms = int(created_at)
                    else:
                        ts_ms = after_ms + 1
                    if ts_ms > after_ms:
                        return m
        time.sleep(poll_interval)
    return None


# ---------------------------------------------------------------------------
# Tail helper for diagnostics
# ---------------------------------------------------------------------------


def tail_log(path: Path, max_lines: int = 80) -> str:
    if not path.exists():
        return "<no log file>"
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return "<unreadable>"
    lines = text.splitlines()[-max_lines:]
    return _redact("\n".join(lines))


def wait_for_log(path: Path, needle: str, timeout_s: float) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            if path.exists() and needle in path.read_text(errors="replace"):
                return True
        except OSError:
            pass
        time.sleep(0.5)
    return False


# ---------------------------------------------------------------------------
# Main orchestration
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description="OpenClaw <-> TheChat full-flow E2E orchestrator"
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Validate non-secret prerequisites and exit without running the test.",
    )
    args = parser.parse_args()

    runtime = resolve_openclaw_runtime()
    thechat_url_override, thechat_url_source = resolve_thechat_url_override()
    needs_local_thechat = not thechat_url_override
    required_tools = ["docker"] if runtime == "docker" else ["git", "node", "pnpm"]
    if needs_local_thechat:
        required_tools.append("bun")

    if not args.check_only and os.environ.get("OPENCLAW_E2E_FULL") != "1":
        log(
            "OPENCLAW_E2E_FULL is not set to 1 — skipping (this suite is opt-in)."
        )
        return 0

    if needs_local_thechat and not os.environ.get("DATABASE_URL", "").strip():
        err(
            "DATABASE_URL is required when neither THECHAT_BACKEND_URL nor "
            "THECHAT_API_URL is set "
            "(the orchestrator must start its own TheChat API)."
        )
        return 2

    # Tooling preflight.
    for tool in required_tools:
        if shutil.which(tool) is None:
            err(f"required tool not found on PATH: {tool}")
            return 2

    if args.check_only:
        log("preflight OK")
        return 0

    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not openrouter_key:
        err("OPENROUTER_API_KEY is required for this test (never logged).")
        return 2
    register_secret(openrouter_key)

    docker_image = os.environ.get("OPENCLAW_E2E_DOCKER_IMAGE", DEFAULT_DOCKER_IMAGE)
    docker_pull = os.environ.get("OPENCLAW_E2E_DOCKER_PULL", DEFAULT_DOCKER_PULL)
    repo = os.environ.get("OPENCLAW_E2E_OPENCLAW_REPO", DEFAULT_REPO)
    ref = os.environ.get("OPENCLAW_E2E_OPENCLAW_REF", DEFAULT_REF)
    model = os.environ.get("OPENCLAW_E2E_MODEL", DEFAULT_MODEL)
    cache_dir = Path(
        os.environ.get("OPENCLAW_E2E_CACHE_DIR", str(DEFAULT_CACHE_DIR))
    ).expanduser()
    work_dir = Path(
        os.environ.get("OPENCLAW_E2E_WORK_DIR", str(DEFAULT_WORK_DIR))
    ).expanduser()
    skip_build = os.environ.get("OPENCLAW_E2E_SKIP_BUILD") == "1"
    keep_temp = os.environ.get("OPENCLAW_E2E_KEEP_TEMP") == "1"
    response_timeout = env_float("OPENCLAW_E2E_RESPONSE_TIMEOUT", 180.0)
    gateway_startup_timeout = env_float(
        "OPENCLAW_E2E_GATEWAY_STARTUP_TIMEOUT", 300.0
    )
    total_timeout = env_float("OPENCLAW_E2E_TOTAL_TIMEOUT", 900.0)
    overall_deadline = time.monotonic() + total_timeout

    work_dir.mkdir(parents=True, exist_ok=True)
    tmp_root = Path(tempfile.mkdtemp(prefix="run-", dir=work_dir))
    log(f"temp state dir: {tmp_root} (KEEP_TEMP={keep_temp})")
    log(f"OpenClaw runtime: {runtime}")

    api_proc: Optional[subprocess.Popen] = None
    gateway_proc: Optional[subprocess.Popen] = None
    gateway_container: Optional[str] = None

    api_log = tmp_root / "thechat-api.log"
    gateway_log = tmp_root / "openclaw-gateway.log"

    try:
        # 1. OpenClaw runtime preparation.
        checkout: Optional[Path] = None
        if runtime == "docker":
            ensure_docker_image(docker_image, docker_pull)
        else:
            checkout = ensure_openclaw_checkout(repo, ref, cache_dir)
            if time.monotonic() > overall_deadline:
                err("total timeout exceeded before OpenClaw build")
                return 1
            build_openclaw_if_needed(checkout, skip_build)

        # 2. TheChat API.
        thechat_url = thechat_url_override or None
        if thechat_url:
            log(
                f"using existing TheChat API at {thechat_url} "
                f"from {thechat_url_source}"
            )
        else:
            api_port = free_port()
            api_proc = start_thechat_api(api_port, api_log)
            thechat_url = f"http://127.0.0.1:{api_port}"
            if not wait_for_http(f"{thechat_url}/health", timeout_s=30):
                err(
                    "TheChat API did not become healthy in time. Tail of log:"
                )
                err(tail_log(api_log))
                return 1
        # Sanity health check whichever API we ended up with.
        status, _ = http("GET", f"{thechat_url}/health", timeout=5)
        if status >= 500:
            err(f"TheChat API health endpoint returned {status}")
            return 1

        # 3. TheChat state.
        state = setup_thechat_state(thechat_url)

        # 4. OpenClaw config + plugin install + gateway run.
        openclaw_state_dir = tmp_root / "openclaw-state"
        gateway_port = free_port()
        thechat_url_for_openclaw = (
            rewrite_localhost_url_for_docker(thechat_url)
            if runtime == "docker"
            else thechat_url
        )
        if thechat_url_for_openclaw != thechat_url:
            log(
                "using Docker-reachable TheChat URL inside OpenClaw: "
                f"{thechat_url_for_openclaw}"
            )
        config_path = write_openclaw_config(
            openclaw_state_dir,
            gateway_port=DOCKER_GATEWAY_PORT if runtime == "docker" else gateway_port,
            gateway_bind="lan" if runtime == "docker" else "loopback",
            gateway_auth="token" if runtime == "docker" else "none",
            thechat_base_url=thechat_url_for_openclaw,
            bot_id=state["bot_id"],
            bot_user_id=state["bot_user_id"],
            bot_api_key=state["bot_api_key"],
            bot_webhook_secret=state["bot_webhook_secret"],
            bot_name="OpenClaw E2E Bot",
            model_primary=model,
            openrouter_api_key=openrouter_key,
            workspace_path=(
                f"{DOCKER_OPENCLAW_HOME}/workspace"
                if runtime == "docker"
                else None
            ),
            include_thechat_channel=False,
        )

        if runtime == "docker":
            install_thechat_plugin_from_docker(
                docker_image, openclaw_state_dir, openrouter_key
            )
        else:
            assert checkout is not None
            install_thechat_plugin_from_source(
                checkout, openclaw_state_dir, config_path, openrouter_key
            )
        enable_thechat_channel_in_config(
            config_path,
            thechat_base_url=thechat_url_for_openclaw,
            bot_id=state["bot_id"],
            bot_user_id=state["bot_user_id"],
            bot_api_key=state["bot_api_key"],
            bot_webhook_secret=state["bot_webhook_secret"],
            bot_name="OpenClaw E2E Bot",
        )

        if time.monotonic() > overall_deadline:
            err("total timeout exceeded before gateway start")
            return 1

        if runtime == "docker":
            gateway_token = f"openclaw-e2e-{uuid.uuid4().hex}"
            register_secret(gateway_token)
            gateway_container = f"thechat-openclaw-e2e-{tmp_root.name}"
            gateway_proc = start_openclaw_gateway_docker(
                docker_image,
                openclaw_state_dir,
                openrouter_key,
                gateway_token,
                gateway_log,
                gateway_port,
                gateway_container,
            )
        else:
            assert checkout is not None
            gateway_proc = start_openclaw_gateway(
                checkout,
                openclaw_state_dir,
                config_path,
                openrouter_key,
                gateway_log,
                gateway_port,
            )

        gateway_url = f"http://127.0.0.1:{gateway_port}"
        if not wait_for_port("127.0.0.1", gateway_port, timeout_s=60):
            err("OpenClaw gateway port did not open in time. Tail of log:")
            err(tail_log(gateway_log))
            return 1
        if not wait_for_log(
            gateway_log, "[gateway] ready", timeout_s=gateway_startup_timeout
        ):
            err("OpenClaw gateway did not become ready in time. Tail of log:")
            err(tail_log(gateway_log))
            return 1
        if not wait_for_http(f"{gateway_url}/healthz", timeout_s=15):
            warn("OpenClaw /healthz did not respond after the ready log.")

        webhook_url = f"{gateway_url}{WEBHOOK_PATH}"
        if not wait_for_webhook_responsive(webhook_url, timeout_s=60):
            err(
                "OpenClaw TheChat webhook route did not become responsive in "
                "time. Tail of log:"
            )
            err(tail_log(gateway_log))
            return 1

        # 5. Webhook URL on the bot, then wire up DM and send the human message.
        configure_bot_webhook(
            thechat_url, state["bot_id"], webhook_url, state["human_token"]
        )
        add_bot_to_workspace(
            thechat_url,
            state["bot_id"],
            state["workspace_id"],
            state["human_token"],
        )
        conversation_id = create_dm(
            thechat_url,
            state["workspace_id"],
            state["bot_user_id"],
            state["human_token"],
        )

        # The unique nonce gives us a way to reason about provenance: an LLM
        # often (but not always) reflects parts of the question, but we don't
        # rely on that — we rely on a non-empty `senderType=="bot"` reply
        # arriving after we sent. The nonce just makes per-run logs unique.
        nonce = uuid.uuid4().hex[:8]
        prompt = (
            f"Hello OpenClaw bot. Run-id {nonce}. Please reply with a single "
            "short sentence acknowledging this message."
        )
        before_ms = int(time.time() * 1000)
        send_human_message(
            thechat_url, conversation_id, prompt, state["human_token"]
        )

        # 6. Poll for a real bot reply.
        poll_budget = min(
            response_timeout, max(5.0, overall_deadline - time.monotonic())
        )
        log(
            f"polling TheChat for bot reply (up to {poll_budget:.0f}s)..."
        )
        bot_msg = poll_for_bot_reply(
            thechat_url,
            conversation_id,
            state["bot_user_id"],
            before_ms,
            state["human_token"],
            poll_budget,
        )

        if not bot_msg:
            err(
                "no bot reply received within timeout — OpenClaw did not "
                "respond. Tail of OpenClaw gateway log:"
            )
            err(tail_log(gateway_log))
            err("Tail of TheChat API log (if started by us):")
            err(tail_log(api_log))
            return 1

        content = bot_msg.get("content", "")
        if not isinstance(content, str) or not content.strip():
            err(f"bot reply had empty/invalid content: {bot_msg!r}")
            return 1

        # The simulated test posts deterministic `Echo: <human>` replies.
        # Reject any reply whose content is a literal echo so a regression in
        # which the simulated backend silently runs cannot mask a real-flow
        # break.
        if content.strip() == f"Echo: {prompt}":
            err(
                "bot reply matches the simulated `Echo: <prompt>` pattern — "
                "this looks like the simulated backend, not a real OpenClaw "
                "agent. Failing."
            )
            return 1

        log(
            "bot reply received (length="
            f"{len(content)}): {content[:200].splitlines()[0] if content else ''}"
        )
        log("OK — full-flow OpenClaw <-> TheChat round-trip succeeded.")
        return 0

    finally:
        stop_docker_container(gateway_container)
        kill_proc(gateway_proc)
        kill_proc(api_proc)
        if not keep_temp:
            shutil.rmtree(tmp_root, ignore_errors=True)
        else:
            log(f"kept temp dir for inspection: {tmp_root}")


if __name__ == "__main__":
    sys.exit(main())
