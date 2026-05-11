#!/usr/bin/env python3
"""Run Hermes Gateway runtime directly for isolated E2E tests.

Do not invoke `hermes gateway run` here. The Hermes CLI foreground command
best-effort refreshes an installed user systemd service before startup. In the
TheChat E2E harness we intentionally set HERMES_HOME to a temporary directory;
using the CLI would let that temporary home leak into the developer's normal
`hermes-gateway.service` definition.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path


def main() -> int:
    source_dir = Path(os.environ.get("HERMES_E2E_SOURCE_DIR", os.getcwd())).resolve()
    if not (source_dir / "gateway" / "run.py").exists():
        print(f"Hermes source checkout not found or invalid: {source_dir}", file=sys.stderr)
        return 1

    os.chdir(source_dir)
    sys.path.insert(0, str(source_dir))

    from gateway.run import start_gateway

    success = asyncio.run(start_gateway(replace=True, verbosity=0))
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
