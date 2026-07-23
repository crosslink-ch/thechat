#!/usr/bin/env python3
"""Run Hermes Gateway directly for isolated E2E tests.

Do not invoke ``hermes gateway run`` here. The Hermes CLI foreground command
best-effort refreshes an installed user systemd service before startup. With an
isolated ``HERMES_HOME``, that could rewrite the developer's normal gateway
service to point at temporary E2E state.

The approval UI suite additionally sets ``HERMES_E2E_DISABLE_RUNTIME_ENV=1``.
In that mode this bootstrap disables Hermes's repeated dotenv/secret reloads,
disables machine-global managed scope, and verifies the effective provider URL
before starting the gateway. This keeps source ``.env`` and ``/etc/hermes``
state from undoing the parent harness's sanitized child environment.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

_ISOLATION_FLAG = "HERMES_E2E_DISABLE_RUNTIME_ENV"
_EXPECTED_BASE_URL = "HERMES_E2E_EXPECTED_MODEL_BASE_URL"
_EVIDENCE_PATH = "HERMES_E2E_PROVIDER_EVIDENCE_PATH"
_PROTECTED_ENV_KEYS = (
    "ALL_PROXY",
    "CUSTOM_BASE_URL",
    "HERMES_INFERENCE_MODEL",
    "HERMES_INFERENCE_PROVIDER",
    "HERMES_MANAGED_DIR",
    "HERMES_YOLO_MODE",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "THECHAT_BASE_URL",
    "THECHAT_BOT_TOKEN",
    "TIRITH_ENABLED",
)
_PINNED_PROXY_KEYS = ("ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY")
_FORBIDDEN_PROXY_KEYS = ("all_proxy", "https_proxy", "http_proxy")
_EXPECTED_PROXY_URL = "http://127.0.0.1:9"
_CREDENTIAL_SUFFIXES = ("_API_KEY", "_TOKEN", "_SECRET", "_KEY")
_ALLOWED_CREDENTIAL_KEYS = {"OPENAI_API_KEY", "THECHAT_BOT_TOKEN"}


def _unexpected_credential_keys() -> list[str]:
    return sorted(
        key
        for key, value in os.environ.items()
        if value
        and key.endswith(_CREDENTIAL_SUFFIXES)
        and key not in _ALLOWED_CREDENTIAL_KEYS
    )


def _loopback_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and parsed.hostname in {
        "127.0.0.1",
        "localhost",
        "::1",
    }


def _install_runtime_environment_guard(expected_base_url: str) -> dict[str, str | None]:
    """Disable every Hermes dotenv entry point before importing the gateway."""
    if not _loopback_url(expected_base_url):
        raise RuntimeError(
            f"Hermes E2E expected model URL must be loopback: {expected_base_url!r}"
        )

    managed_dir = Path(os.environ.get("HERMES_MANAGED_DIR", ""))
    if not str(managed_dir) or managed_dir.is_dir():
        raise RuntimeError(
            "Hermes E2E requires HERMES_MANAGED_DIR to name a nonexistent path"
        )

    unexpected_proxies = [key for key in _FORBIDDEN_PROXY_KEYS if os.environ.get(key)]
    proxy_mismatches = [
        key for key in _PINNED_PROXY_KEYS if os.environ.get(key) != _EXPECTED_PROXY_URL
    ]
    if unexpected_proxies or proxy_mismatches:
        raise RuntimeError(
            "Hermes E2E child proxy isolation is invalid: "
            f"unexpected={unexpected_proxies}, mismatched={proxy_mismatches}"
        )
    unexpected_credentials = _unexpected_credential_keys()
    if (
        unexpected_credentials
        or os.environ.get("OPENAI_API_KEY") != "thechat-hermes-approval-e2e-local-only"
    ):
        raise RuntimeError(
            "Hermes E2E child inherited unexpected credential variables: "
            f"{unexpected_credentials}"
        )

    # Pin the endpoint in both config and the one environment override that can
    # outrank config for the custom provider. The post-import resolver check
    # below proves this value survived all gateway imports.
    os.environ["CUSTOM_BASE_URL"] = expected_base_url
    os.environ["OPENAI_BASE_URL"] = expected_base_url
    os.environ["HERMES_YOLO_MODE"] = "0"
    os.environ["TIRITH_ENABLED"] = "0"
    protected_before = {key: os.environ.get(key) for key in _PROTECTED_ENV_KEYS}

    dotenv = importlib.import_module("dotenv")
    env_loader = importlib.import_module("hermes_cli.env_loader")

    # Hermes intentionally reloads user/project dotenv and external secret
    # sources at startup and each turn. That behavior is correct in production
    # but violates this deterministic test's isolation contract.
    setattr(dotenv, "load_dotenv", lambda *args, **kwargs: False)
    setattr(env_loader, "load_dotenv", lambda *args, **kwargs: False)
    setattr(env_loader, "load_hermes_dotenv", lambda *args, **kwargs: [])
    setattr(env_loader, "_apply_managed_env", lambda: None)
    setattr(env_loader, "_apply_external_secret_sources", lambda _home: None)
    return protected_before


def _verify_runtime_environment(
    expected_base_url: str,
    protected_before: dict[str, str | None],
) -> dict[str, Any]:
    from hermes_cli import managed_scope
    from hermes_cli.runtime_provider import resolve_runtime_provider

    managed_dir = managed_scope.get_managed_dir()
    if managed_dir is not None:
        raise RuntimeError(
            f"Hermes E2E managed scope unexpectedly active: {managed_dir}"
        )

    changed = {
        key: {"before": protected_before[key], "after": os.environ.get(key)}
        for key in _PROTECTED_ENV_KEYS
        if os.environ.get(key) != protected_before[key]
    }
    if changed:
        # Values can include credentials; report names only.
        raise RuntimeError(
            f"Hermes E2E protected environment changed during gateway import: {sorted(changed)}"
        )

    unexpected_proxies = [key for key in _FORBIDDEN_PROXY_KEYS if os.environ.get(key)]
    if unexpected_proxies:
        raise RuntimeError(
            f"Hermes E2E gateway import restored proxy variables: {unexpected_proxies}"
        )
    unexpected_credentials = _unexpected_credential_keys()
    if (
        unexpected_credentials
        or os.environ.get("OPENAI_API_KEY") != "thechat-hermes-approval-e2e-local-only"
    ):
        raise RuntimeError(
            "Hermes E2E gateway import restored credential variables: "
            f"{unexpected_credentials}"
        )

    requested_provider = os.environ.get("HERMES_INFERENCE_PROVIDER", "custom")
    target_model = os.environ.get("HERMES_INFERENCE_MODEL")
    resolved = resolve_runtime_provider(
        requested=requested_provider,
        target_model=target_model,
    )
    effective_base_url = str(resolved.get("base_url") or "").rstrip("/")
    if effective_base_url != expected_base_url.rstrip("/") or not _loopback_url(
        effective_base_url
    ):
        raise RuntimeError(
            "Hermes E2E provider escaped loopback isolation: "
            f"provider={resolved.get('provider')!r} base_url={effective_base_url!r}"
        )

    return {
        "provider": str(resolved.get("provider") or ""),
        "baseUrl": effective_base_url,
        "requestedProvider": requested_provider,
        "model": target_model or "",
        "dotenvDisabled": True,
        "managedScope": False,
        "proxyKeys": sorted(_PINNED_PROXY_KEYS),
        "credentialKeys": sorted(
            key for key in _ALLOWED_CREDENTIAL_KEYS if os.environ.get(key)
        ),
    }


def _write_provider_evidence(payload: dict[str, Any]) -> None:
    evidence_path = Path(os.environ.get(_EVIDENCE_PATH, "")).resolve()
    hermes_home = Path(os.environ["HERMES_HOME"]).resolve()
    if not str(evidence_path) or not evidence_path.is_relative_to(hermes_home):
        raise RuntimeError(
            "Hermes E2E provider evidence path must be inside HERMES_HOME"
        )
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = evidence_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    temporary.replace(evidence_path)


def main() -> int:
    source_dir = Path(os.environ.get("HERMES_E2E_SOURCE_DIR", os.getcwd())).resolve()
    if not (source_dir / "gateway" / "run.py").exists():
        print(
            f"Hermes source checkout not found or invalid: {source_dir}",
            file=sys.stderr,
        )
        return 1

    os.chdir(source_dir)
    sys.path.insert(0, str(source_dir))

    isolation_enabled = os.environ.get(_ISOLATION_FLAG) == "1"
    expected_base_url = os.environ.get(_EXPECTED_BASE_URL, "")
    protected_before: dict[str, str | None] = {}
    if isolation_enabled:
        protected_before = _install_runtime_environment_guard(expected_base_url)

    from gateway.run import start_gateway

    if isolation_enabled:
        evidence = _verify_runtime_environment(expected_base_url, protected_before)
        _write_provider_evidence(evidence)

    success = asyncio.run(start_gateway(replace=True, verbosity=0))
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
