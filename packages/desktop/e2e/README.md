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

The launcher starts disposable Postgres, Redis, LocalStack S3, and ClamAV containers,
runs the real API and outbox worker, builds the desktop app with the isolated
backend URL, and executes `opt-in/attachments.e2e.js` under Xvfb. It requires
Docker, `tauri-driver`, `WebKitWebDriver`, and `xvfb-run`, but no cloud or model
credentials.

The flow verifies:

- visible draft transitions through prepare, upload, scan, and ready states;
- attachment-only send after a deliberately lost response, followed by an
  idempotent retry with the same client message ID;
- one rendered file card and an exact byte-for-byte download;
- actual EICAR rejection by ClamAV; and
- deletion of a ready draft cancelled before send.

Screenshots are written under `.tmp/`. Set `ATTACHMENT_E2E_KEEP=1` to keep
containers and generated fixtures for debugging after a run.
