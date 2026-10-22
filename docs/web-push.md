# Background notifications (Web Push)

The browser edition notifies people when TheChat is closed, on desktop browsers
and on phones, using standard Web Push. There is no native app.

| Platform | Works when |
| --- | --- |
| Android (Chrome, Edge, Samsung Internet, Firefox) | Notifications are turned on in TheChat Settings or the prompt. The tab can be closed. |
| iPhone / iPad (iOS/iPadOS 16.4+) | TheChat is added to the Home Screen and opened from there, then notifications are turned on. Safari tabs cannot receive push. |
| Desktop Chrome, Edge, Firefox, Safari | Notifications are turned on. The browser must be running (it can be in the background). |

The operating system still decides what is shown. Focus/Do Not Disturb, the
app's system notification setting, battery savers and a force-quit browser can
delay or hide notifications. TheChat cannot override these.

## What notifies

| Event | Who | Setting |
| --- | --- | --- |
| Direct message | The other person | Direct messages |
| Message in a channel that @mentions you | The mentioned person | Mentions |
| An agent's answer in a DM, or in a channel run you started | The person the agent is answering | Agent replies |
| An agent request (approval, question, review) | Its addressee; in a DM, the participants; in a channel, the person who started the run | Agent requests |

Never the sender. Rules are evaluated when the notification is sent (by
default 3 seconds after the message, `WEB_PUSH_DELAY_MS`), so it is skipped if
the message was read on another device in the meantime, the recipient left the
workspace, changed their settings, or the request was already answered.

Agent replies notify once per run, with the run's newest message. While a
Hermes run is still going, its interim messages ("Looking into it…") wait; the
run ends when Hermes sends a final message, reports the turn completed, fails or
is cancelled. After 10 minutes the newest message notifies anyway. Webhook bots
and messages outside a run notify straight away.

Settings are account-wide and stored on the server, because a closed browser
cannot consult local settings. "Show message previews" off replaces message
text with "Sent you a message" / "Mentioned you" / "Replied".

## How it works

```
message / agent request
  -> pg-boss chat.message.sent event or bot request creation
  -> pg-boss queue push.notification   push.fanout   (one job per source, delayed)
  -> push.deliver                (one job per device, retried with backoff)
  -> browser push service (FCM, Mozilla, Apple, WNS), VAPID-signed, aes128gcm
  -> service worker /sw.js shows the notification; a tap opens #/open?...
```

- `packages/api/src/push/`: routes (`/push/config`, `/push/subscriptions`,
  `/push/subscriptions/status`, `/push/preferences`, `/push/test`), recipient
  rules (`content.ts`), queue jobs (`jobs.ts`) and the sender (`sender.ts`).
- `packages/web/src/sw/service-worker.ts`: compiled to a classic `/sw.js`. It
  only shows notifications and routes taps. It has no fetch handler and caches
  nothing.
- `packages/web/src/platform/push.ts`: browser registration state; Settings
  section and the one-time post-login prompt use it.
- `packages/web/pwa/`: web app manifest and icons, needed for iOS Home Screen
  install.

Job ids are derived from the source (`push-fanout:message:<id>`,
`push-deliver:<source>:<subscription>`), so a redelivered or replayed event
never notifies twice. Each notification carries a per-conversation tag and
push `Topic`, so a burst replaces itself instead of piling up.

### Devices and accounts

A device is one browser push subscription, tied to the exact signed-in session
that registered it (`push_subscriptions.session_id`, `ON DELETE CASCADE`).
Logging out or session expiry removes it. If someone else signs in on the same
browser, the old subscription is unsubscribed in the browser and the next
registration moves the endpoint to the new account. Up to 20 devices are kept
per account. The push service's `404`/`410` deletes a device; repeated other
rejections (10) also drop it.

While background push is on for a browser, that page skips its own in-page
notification for direct messages, so you do not get two.

### Security

- Endpoints are untrusted and are only accepted for the browsers' push
  services: `fcm.googleapis.com`, `android.googleapis.com`,
  `*.push.services.mozilla.com`, `web.push.apple.com` / `*.push.apple.com` and
  `*.notify.windows.com`, HTTPS on port 443, no credentials. The worker checks
  again before sending and never follows redirects.
- Endpoints are capability URLs. They are never logged; logs carry only the
  push-service hostname and HTTP status.
- Payloads are end-to-end encrypted to the browser (RFC 8291). The push
  services see only ciphertext, the VAPID identity and the topic hash.
- Every push shows a notification (`userVisibleOnly`). Safari revokes push for
  sites that send silent pushes.

## Configuration

Background push is off unless all three are set (on the API **and** worker):

| Variable | Value |
| --- | --- |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | VAPID public key (base64url) |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | VAPID private key (base64url), secret |
| `WEB_PUSH_SUBJECT` | `mailto:` address or `https:` URL push services can contact |
| `WEB_PUSH_DELAY_MS` | Optional, default `3000` |
| `WEB_PUSH_TTL_SECONDS` | Optional, default `43200` (how long a push service keeps an undelivered message) |

Generate the key pair once:

```sh
bunx web-push generate-vapid-keys
```

Rotating the pair invalidates every existing subscription; people have to turn
notifications on again. Half-configured or malformed values stop the API and
worker at startup.

With the Helm chart, create a Secret with the three keys and set
`webPushSecret` to its name. Both Deployments then read it with `secretKeyRef`;
the chart refuses literal `env.WEB_PUSH_*` values.

The worker needs outbound HTTPS to the push services listed above.

## Verification

Automated:

```sh
pnpm --filter @thechat/api exec bun test --env-file ../../.env src/push/push.test.ts
pnpm --filter @thechat/web test:unit
python3 deploy/api/tests/test_web_push_secret.py
python3 deploy/web/tests/test_image.py
```

The API tests decrypt each push exactly as a browser would and verify the VAPID
signature. They do not prove that a locked phone shows the notification.

Before relying on it, check on real devices against a deployment with VAPID
keys:

1. Android Chrome: turn on, send a test notification from Settings, close the
   tab, lock the phone, have someone DM you. Tap it: the DM opens.
2. iPhone: Safari shows "add to Home Screen first". Add it, open from the Home
   Screen, turn on, allow. Repeat step 1 with the app swiped away.
3. Mention in a channel, an agent reply, an agent approval; each notifies once.
4. Read the message on a laptop within the delay: the phone stays quiet.
5. Log out on the phone: no further notifications.
