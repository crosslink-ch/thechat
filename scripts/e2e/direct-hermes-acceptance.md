# Direct Hermes real-process acceptance (inference fixture)

This harness replaces **only inference** with a deterministic loopback OpenAI-compatible fixture. It does **not** use a real/paid LLM and requires no external model credentials. The pinned Hermes dashboard/RPC server, AIAgent loop, terminal tool, SQLite SessionDB, TheChat authentication/API, Redis single-use permission capabilities, raw proxy and PostgreSQL are real processes.

It changes no production API/proxy code and writes no TheChat transcript rows.

## Prerequisites

- Linux disposable devbox; Python environment installed from Hermes source commit `0825c35d9faa42b166101ffc448ef9acb46012ef`.
- Bun, Node, installed TheChat workspace dependencies (parent runs `pnpm install --frozen-lockfile`).
- Docker, or `sudo -n docker` on this devbox. Override with `--docker docker`.
- Images `postgres:17-alpine`, `redis:7-alpine` available locally. Image overrides are accepted.

From the prepared Hermes source checkout:

```bash
uv sync --frozen --no-dev
uv pip install --python .venv/bin/python playwright==1.58.0
PLAYWRIGHT_BROWSERS_PATH=/workspace/direct-hermes-e2e/browsers .venv/bin/python -m playwright install chromium
sudo -n env NEEDRESTART_MODE=l /workspace/hermes-source/.venv/bin/python -m playwright install-deps chromium
sudo -n docker pull postgres:17-alpine
sudo -n docker pull redis:7-alpine
```

Do not run install commands under any live user's `HERMES_HOME`. The acceptance itself creates fresh `HOME` and `HERMES_HOME` under its scratch run directory, passes a sanitized environment, blocks non-loopback Python socket connections, disables machine-global managed state and refuses checkout/ancestor `.env` files. It starts `uvicorn` directly, **not** `hermes gateway run`, so it cannot rewrite user gateway services. Only the random disposable dashboard token and fake local inference key enter Hermes.

## Run

From `/workspace/thechat`:

```bash
# Fixture negative controls: missing file, wrong output and invalid result fail.
python3 scripts/e2e/direct-hermes-fixture-test.py

# Real transport/tool/history acceptance. Default deadline: 540 seconds.
/workspace/hermes-source/.venv/bin/python scripts/e2e/direct-hermes-acceptance.py

# Plus rendered production chat view acceptance:
/workspace/hermes-source/.venv/bin/python scripts/e2e/direct-hermes-acceptance.py --browser
```

Optional flags:

- `--hermes-source PATH`, `--scratch PATH`, `--docker 'sudo -n docker'`
- `--timeout SECONDS` for acceptance; increase only for a heavily loaded devbox.
- `--browser --keep-running --keep-seconds 1800` to hold a **loopback-only** disposable preview after PASS, maximum 3600 seconds. `PREVIEW_READY` reports the run directory; its mode-0600 `preview-access.json` contains only disposable test login details. Stop the harness supervisor with SIGTERM/SIGINT for owned cleanup. No public preview deployment is created. Do not run destructive broad suites against its database; use separate test DBs.

Each run reserves fresh loopback ports and unique containers with an ownership label. Ports, source-byte SHA-256 values, run ID and acceptance results are in `report.json`. Runs clean their own process groups and containers in `finally`, including failures and deadlines; cleanup checks the label before deleting containers and reads back that no owned container remains. Artifacts intentionally remain in scratch for review. Docker images and downloaded browser binaries remain reusable prerequisites. The harness does not shut down unrelated services or delete prior evidence.

## Settings, sharing, and stable-refresh acceptance

```bash
/workspace/hermes-source/.venv/bin/python scripts/e2e/direct-hermes-acceptance.py --settings --browser
/workspace/hermes-source/.venv/bin/python scripts/e2e/direct-hermes-harness-test.py
```

`--settings` adds real HTTP checks for owner-only defaults/administration, eligible
humans, explicit sharing acknowledgement, stale revision rejection, endpoint/token
validation, encrypted storage and redaction, a grantee's own-DM connection, shared
history/prompting, active and unused-ticket revocation, current membership, token
rotation and restoration against the real upstream gateway.

With `--browser`, the authenticated harness also mounts the real **Manage bots**
route and exercises its typed API settings form. A test-only WebSocket delivery
probe holds and then releases an actual `session.list` response without changing
its bytes. It measures session rows, list child count, Refresh-button geometry,
and scroll position before/during/after refresh at desktop and narrow widths.
No loading row may be inserted and no existing row may shift. The helper unit
suite contains negative controls proving that moved rows or reset scrolling fail
these assertions; those synthetic controls are not substitute E2E evidence.

All people, grants, credentials, and workspaces in these tests are disposable.
Sharing the gateway is intentional and explicitly **not** per-person isolation.
Revocation disconnects the transport but cannot cancel already-started Hermes
work. Reports keep timing and credential-redaction results separate from the
production-built browser-component evidence; native Windows/Tauri is not claimed.

## Attachment and slash-command acceptance

```bash
/workspace/hermes-source/.venv/bin/python scripts/e2e/direct-hermes-acceptance.py --browser --composer --settings
/workspace/hermes-source/.venv/bin/python scripts/e2e/direct-hermes-composer-test.py
```

`--composer` exercises actual file-picker uploads, removal without upload,
session-scoped pending files, attachment-only sends, size rejection without losing
the WebSocket, native image input, and slash-command dispatch in the browser.
The fixture proves text-file receipt through real agent file access and records
the actual image input delivered by Hermes. Disk bytes/hashes are checked in the
isolated gateway workspace. `/branch` and `/fork` must create real durable Hermes
sessions with copied history and an unchanged parent; follow-up messages and a
page reload verify the branch, not a synthetic client-only session. Control and
unknown commands must not become ordinary model prompts.

The report separates these checks and provider receipts from the existing
chat/settings/zero-shift checks. Inference is still deterministic and labelled;
this proves transport, bytes, agent/tool delivery and session persistence, not a
paid model's image interpretation. Browser/native-bridge unit coverage does not
claim an interactive Windows/Tauri file-dialog or native drag-and-drop E2E run.

## Assertions

1. Real `/auth/register` creates disposable owner and outsider; owner creates workspace, Direct Hermes bot and exact DM.
2. Outsider ticket request is 403. Owner ticket is allowed, `Cache-Control: no-store`, and neither bot nor ticket response reveals the Hermes gateway credential.
3. A real WebSocket capability upgrade receives **`gateway.ready`** through the opaque proxy. Reusing its consumed capability is rejected with **401**.
4. `session.create` returns distinct runtime and durable IDs. `prompt.submit({session_id,text})` returns **`{status:"streaming"}`** (ACK, not final response).
5. The genuine Hermes tool executes `printf '%s\n' DIRECT_HERMES_REAL_TERMINAL_OK | tee <owned scratch marker>`. The fixture does not create this file. Both tool result `exit_code:0`/output and marker bytes are asserted, and the next real provider request must contain Hermes' real tool result before the fixture returns its deterministic final answer.
6. Real `message.start`, `message.delta`, `tool.start`, `tool.complete`, and `message.complete` traverse the proxy. The final payload must have `status:"complete"` and exact fixture text.
7. Session B contains no A user/tool history. Both saved sessions appear in `session.list`. `session.history` reads genuine stored messages.
8. Live sessions are explicitly closed, the WebSocket is disconnected, and a **new capability** reconnects. `session.resume` hydrates A's durable transcript; a new prompt proves prior user, assistant and terminal tool result reached inference. Switching to B and back preserves isolation.
9. SQLite rows independently contain A's terminal result, assistant response and followup and B's separate content. PostgreSQL `messages` count remains **zero**.
10. With `--browser`, a **production build of the real `DirectHermesSessionsView`** mounts in a dedicated harness entry and signs in through actual `/auth/login`. Chromium selects saved A, reads its history, submits followup, switches A/B, reloads and recovers history, creates a fresh session and sends another real terminal turn. The browser-specific harmless command begins with bounded `sleep 3` so the actual **Running** tool card can be captured. The test expands the real rendered tool card, verifies its printf command and successful output/exit code, and measures control/sidebar/content geometry at **1440×1000** and **390×844**, including long unbroken submitted content and draft text. Browser RPC frames and actual ticket requests are recorded without credentials. This proves the production component/controller through real auth/proxy, **not full desktop navigation or native Tauri shell**.

The harness-only stylesheet imports the real desktop stylesheet and explicitly scans the real `desktop/src` with Tailwind v4 `@source`; otherwise a scratch-root build can silently omit utility CSS. Built-selector and computed-style guards assert effective flex/min-width/overflow before geometry is accepted. No production CSS is overridden. At 390px the test also scrolls the lower session B row into view, selects its isolated history, verifies composer containment and returns to the new session. Intentional scroll-boundary clipping is not treated as a CSS overlap defect.

## Pinned wire contract

Source paths are relative to the pinned Hermes archive:

- `tui_gateway/ws.py:343–355`: ready notification is `{jsonrpc:"2.0",method:"event",params:{type:"gateway.ready",payload:{...}}}`.
- `tui_gateway/methods_session.py:14–159,356–775,2685–2714`: create/resume/history; runtime IDs are required for `session.history`, durable IDs for cold `session.resume`.
- `tui_gateway/methods_prompt.py:268–835`: prompt submit ACK; not a final result.
- `tui_gateway/server.py:6022–6100`: `tool.start`/`tool.complete` with `tool_id`, name, args and live result.
- `tui_gateway/server.py:11026–11046,11273–11331`: streaming text and terminal message completion.
- `tui_gateway/server.py:7703–7806`: persisted **display history omits tool outputs and IDs**; tool result verification uses live events and actual SQLite rows. UI must not invent missing saved outputs.

The harness intentionally does not guess `session.status` fields or expect unsupported `session.events.since`/`gateway.ping` on this pin.

## Evidence files

Printed `REPORT <path>` points to the authoritative result. All artifacts live under the unique scratch directory, never in the source tree:

- `report.json`: exact assertions, IDs/counts, runtime ports and verified cleanup.
- `rpc-frames.jsonl`: real RPC responses and events (no capabilities).
- `provider-evidence.json`: effective custom provider, loopback base URL, isolated home.
- `fixture-audit.json`: actual inference request stages/roles and marker-only user IDs; no paid inference claim.
- `terminal-marker.txt`: written only by the actual terminal tool.
- `hermes-home/state.db`: actual Hermes messages, retained for inspection.
- `browser-api-requests.json`, `browser-rpc-frames.json`, `browser-dom.txt` and PNG screenshots for browser success. Browser failures instead retain `browser-failure-dom.txt`/PNG.
- Per-process logs and production browser build log.

No credentials belong in a committed report or console output. Runtime-only browser input is mode 0600 and removed during cleanup. Disposable preview access is scoped to the isolated stack; never reuse those passwords.
