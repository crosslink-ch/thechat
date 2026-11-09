# Incoming webhooks

Incoming webhooks let monitoring tools post into one TheChat channel using only
a secret URL. They are separate from outgoing webhook bots: no bot API key,
Authorization header, or custom TheChat message body is needed.

## Create or revoke a URL

1. As a workspace owner or admin, open the channel's **… → Incoming webhooks**.
2. Enter a name, such as **Uptime Kuma**, and choose **Create webhook**.
3. Copy the URL now. TheChat stores only its SHA-256 hash and a short identifying
   prefix; closing the dialog or choosing **Hide URL** removes the one-time reveal.
4. To stop posts, choose **Revoke → Confirm revoke**. Existing messages keep their
   sender name, but subsequent posts to that URL return `404`.

Each URL is non-expiring, bound to its original channel, and acts as its own bot
sender. It has no sign-in credentials, reading, bot-management, or cross-channel privileges.
The webhook belongs to the channel, not the creator's membership. Removing its
creator from the workspace does not revoke it; another workspace manager can.
Deleting the channel invalidates its URLs. Lost URLs must be replaced.

## curl

Keep the URL in your secret manager, not source control or screenshots. For an
interactive Bash session:

```sh
read -rsp 'Webhook URL: ' THECHAT_WEBHOOK_URL; printf '\n'
curl --fail-with-body --request POST "$THECHAT_WEBHOOK_URL" \
  --header 'Content-Type: application/json' \
  --data '{"text":"Checkout is down: HTTP 503"}'
unset THECHAT_WEBHOOK_URL
```

Success returns HTTP `200` with plain text `ok`, compatible with Slack webhooks.
Messages appear live and create the usual unread state. Notification preferences
and channel mention rules apply as for other channel messages; this does not
force a broadcast or override muted notifications. Bot automation is not invoked.

## Uptime Kuma

1. In TheChat, create an incoming webhook named **Uptime Kuma** for your alerts channel.
2. In Uptime Kuma, choose **Setup Notification**, then notification type **Slack**.
3. Paste the URL into **Webhook URL**. Leave **Channel Name**, **Username**, and
   **Icon Emoji** empty: TheChat fixes the destination and sender at creation.
4. **Send rich messages** can be on or off. Choose **Test**, save, then enable the
   notification on your monitor. A successful Test is not a monitor transition;
   also check a real down/up transition in your development environment.

Kuma's top-level `text` contains its readable alert, including the monitor name,
Down/Up state and failure/recovery reason. No Slack workspace or Slack app is needed.

## Payloads and limits

- POST `application/json`, with optional charset. Compressed bodies are not supported.
- `{"text":"..."}` is the simplest format. Unknown fields are ignored.
- Slack top-level `text` takes precedence, avoiding duplicate fallback/rich alert
  content. Without text, TheChat extracts header/section/field/context text and
  action-button labels/URLs from `blocks`, and pretext/title/text/fields/blocks/footer
  (or fallback) from `attachments`. It renders a readable text message, not Slack's
  interactive widgets, images, color panels or full Block Kit UI.
- Slack HTTP(S) links become readable labels plus URLs. Slack user IDs and channel
  overrides do not select TheChat users/channels. `channel`, `username`, `icon_*`,
  `thread_ts`, `threadId`, and `conversationId` cannot change the bound destination,
  sender or task. Attachments in Slack JSON are text containers, not uploaded files.
- Maximum request body: **65,536 bytes**, checked before JSON parsing, including
  streamed requests without Content-Length. Oversized requests return `413` JSON.
- Maximum accepted posts per webhook: **30 per 60-second window**. The database
  serializes the counter across API replicas. `429` includes a `Retry-After` header
  in seconds. Other webhooks have independent budgets. Invalid payloads consume
  no posting budget.
- Malformed JSON, empty/unsupported content or NUL characters return `400` JSON;
  unsupported media type/encoding returns `415`; invalid/revoked credentials return
  `404` for otherwise valid posts; temporary infrastructure failure returns `503`.
  Errors use `{"error":"..."}` and do not echo the secret URL or submitted payload.
- Every accepted POST creates a new message. There is no delivery deduplication:
  a sender retry after an ambiguous network failure can create a duplicate.

Non-secret limits live in `packages/api/src/incoming-webhooks/config.ts`, alongside
other source-controlled API policy. No extra environment flags are required.

## Operators and verification

Deploy the generated database migration before API/client code. Incoming URLs
use the API origin, not necessarily the web frontend's origin. Proxies must route
`/hooks/incoming/` to the API without additional authentication. Treat that whole
path as a credential: exclude/redact it in reverse-proxy, CDN, tracing, and error
reporting access logs. The API suppresses automatic request/error logging for
these paths and emits a templated HTTP span plus a status-only request counter.
Do not publish request URLs, bodies, or webhook creation responses in telemetry.

With disposable Postgres/Redis and the API schema/queues initialized:

```sh
pnpm --filter @thechat/api test -- src/incoming-webhooks/incoming-webhooks.test.ts
pnpm --filter @thechat/client exec vitest run src/components/IncomingWebhooksModal.test.tsx
# With the loopback web/API stack described in docs/web.md running:
pnpm test:e2e:web incoming-webhooks.spec.ts --project chromium-desktop --project chromium-phone
```

The browser test creates synthetic users, manages the URL through the real UI,
posts with curl, asserts a live WebSocket message and persisted history, and
checks revocation. Evidence is written outside Git using the existing E2E config.
