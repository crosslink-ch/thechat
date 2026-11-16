# Desktop end-to-end tests

The WebdriverIO suites drive the compiled Tauri binary through `tauri-driver` and
`WebKitWebDriver`. The default suite contains lightweight desktop smoke tests;
resource-heavy workflows live under `opt-in/` and have dedicated launchers.

## Secure message attachments

Run the full attachment lifecycle locally with:

```bash
pnpm test:e2e:attachments-ui
# or through the repository suite runner
python3 scripts/test.py attachments-ui
```

The launcher starts disposable Postgres, Redis, and LocalStack S3 containers,
runs the real API and outbox worker, builds the desktop app with the isolated
backend URL, and executes `opt-in/attachments.e2e.js` under Xvfb. It requires
Docker, `tauri-driver`, `WebKitWebDriver`, and `xvfb-run`, but no cloud or model
credentials. It forces Docker's `default` context, refuses non-Unix (for example
remote TCP) daemon endpoints, binds every published service and the API to loopback,
and removes only stale containers carrying the attachment-suite ownership label.
The attachment and Hermes-approval native suites share one non-blocking lock so
they cannot race on Tauri build artifacts.

The flow verifies:

- ordered visible draft transitions through prepare, upload, validation, and ready states
  for an opaque EML, an image, and active HTML content;
- attachment-only send after a deliberately lost response, followed by an
  idempotent retry with the same client message ID and the same canonical server
  message ID from both successful HTTP responses;
- one rendered opaque file card and an exact byte-for-byte native download that
  is saved without invoking a desktop opener;
- a narrow expanded-image viewer whose 44px icon controls remain outside the
  image pixels;
- active HTML content being accepted as a ready opaque file with no inline
  preview; and
- authenticated cancellation of a real in-flight upload, followed by terminal
  deleted state and object-store cleanup before the desktop session closes.

Screenshots are written under `.tmp/`. Set `ATTACHMENT_E2E_KEEP=1` to keep
containers and generated fixtures for debugging after a run.

## Password reset

Run the focused API tests or the compiled desktop flow with:

```bash
pnpm test:api:password-reset
pnpm test:e2e:password-reset-ui
```

The launcher starts fresh Postgres, Redis, and Mailpit containers on a dedicated
Docker bridge with IP masquerading disabled, publishes them only on explicit
loopback addresses, and refuses occupied ports. Missing pinned service images are
pulled once before the containers start. It builds the Tauri binary from
source, disables dotenv, telemetry, package-manager network access, and inherited
provider credentials, and verifies API-process ownership before driving the UI.
Test addresses use the reserved `example.invalid` domain; no external mailbox or
production account is used.

## Hermes approvals and bot requests

```bash
python3 scripts/test.py hermes-approval-ui   # compiled desktop UI
python3 scripts/test.py hermes-requests      # API level
```

Both suites run a real Hermes Gateway against a deterministic local model, so they
need no provider credentials. They do need a Hermes checkout that contains the
TheChat platform adapter next to this repository (or `HERMES_E2E_SOURCE_DIR`).
The upstream NousResearch repository does not ship that adapter:

```bash
git clone https://github.com/crosslink-ch/hermes-agent.git ../hermes-agent
(cd ../hermes-agent && uv sync --frozen --extra messaging)
```

Sync the environment before the first run. The approval harness starts Hermes
with `uv run --frozen` behind a dead loopback proxy, so it cannot install packages
itself, and both suites' webhook transport needs `aiohttp` from the `messaging`
extra.
