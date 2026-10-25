# Native secure input (v3)

The shared `@thechat/client` renders the same masked forms in web and desktop.
This is a separate memory-only response lane, **never** chat, clarification,
`bot_requests`, a queued invocation or a durable inbox. Bitwarden's existing
[v2 protocol and shared-profile access](native-vault-unlock.md) are unchanged.

## Where prompts appear

The production `/channel/$id` route (web hash URL `/#/channel/<id>`) loads the
requester-filtered runtime snapshot and consumes the channel's realtime runtime
updates in `ChannelChatView`. The same shared `HermesProgressInline` forms used
by Hermes DMs and DM task threads handle **all five v3 kinds and v2 Bitwarden**.
Channels show their conversation's thread lanes, matching the ordinary channel
message/request timeline; invocation, bot, conversation and thread context stay
bound to the original event. No durable bot-request row is created.

Only the original human requester sees or answers the private form. Other
channel participants, including the bot owner when not the requester, receive
neither request nor resolution metadata. Code prompts remain available to an
admitted nonowner requester; the four owner-only kinds keep their existing API
authority checks. Channel submit/cancel uses the same dedicated Eden endpoints,
never the ordinary message composer or websocket message-send path.

Changing channels unmounts and clears the form, fences pending encryption and
removes the old channel's runtime subscriptions. Re-entering a channel and
websocket reauthentication refresh its snapshot even inside the normal cache
freshness window, recovering resolutions missed while away. New runtime activity
follows the bottom only while ordinary chat auto-follow is enabled: intentional
history scrolling is preserved, with **Jump to bottom** available for activity.

## Capability and authority

`GET /hermes-platform/health` exposes `capabilities: {botRequests: 1, secureInput: 3}`.
Hermes must observe exactly v3 and have a signed webhook configured before it
requests a prompt. An unavailable/mixed-version lane fails closed, with no
plaintext fallback. There is no new TheChat environment feature flag.

| Kind | Ordered fields | Who can request and answer | Public target |
| --- | --- | --- | --- |
| `onepassword.unlock` | `["password"]` | Original human requester **and** current bot owner | `1Password` |
| `vault.save_login` | `["identifier","password"]` | Original human requester **and** current bot owner | Bound HTTP(S) browser origin |
| `vault.code` | `["code"]` | Original admitted human requester, including nonowners | Callback site/origin |
| `sudo.password` | `["password"]` | Original human requester **and** current bot owner; Hermes profile opt-in | Redacted command or safe description |
| `skill.secret` | `["value"]` | Original human requester **and** current bot owner; Hermes profile opt-in | Valid environment-variable name |

TheChat reads the owner from the current canonical bot row, never from caller
actor/owner claims. Publication and submit/cancel revalidate human identity,
workspace/conversation admission, bot admission and nonterminal active execution.
Only the original requester receives request/resolution realtime events or
snapshot metadata. Snapshots also hide owner-only requests after an ownership
change or admission revocation. The UI's human/requester guard is defense in
depth, not the authority boundary.

Hermes owns the default-off `sudo.password`/`skill.secret` **profile configuration**
settings, turn callback installation, profile isolation, secret persistence and
privileged-command approval policy. TheChat cannot assert those local settings.
Only `skill.secret` intentionally persists its result in the target Hermes
profile environment; a sudo password must remain memory-only. An unlock/login
prompt is not approval to run a privileged command.

## Strict progress metadata

The authenticated bot posts `secure.input.request` to its invocation's progress
endpoint with exactly this payload (no custom field types/labels or extra keys):

```ts
{
  version: 3,
  requestId: canonicalUUID,
  sessionKey: safeNonemptyString,       // <=1000 chars
  profileId: safeOpaqueNonemptyString,  // <=255 chars
  requesterUserId: originalInvocationHumanRequester,
  promptKind, fields, target,          // table above; target <=2000 chars, never a secret
  nonce: canonicalBase64url32Bytes,     // 43 chars, no padding
  expiresAt: integerUnixMilliseconds,  // live, at most 120 s (+30 s clock-skew allowance)
  algorithm: 'RSA-OAEP-3072-SHA256+A256GCM',
  publicKeySpkiB64: canonicalBase64Rsa3072Spki
}
```

Safe context strings reject surrounding whitespace and control characters.
Labels, descriptions, status and tool identifiers are fixed by the API/client,
not supplied by the caller. Targets are React text, not HTML. Request ID retries
keep the immutable first metadata and stable event ID, including concurrent
requests. Altered replay contexts are rejected. Pending requests outlive normal
activity timeout/event overflow until expiry/resolution. Retained request
identity metadata permits late expiry resolution without resurrecting prompts.

Resolution is exactly:

```ts
{ version: 3, requestId, sessionKey,
  outcome: 'submitted' | 'cancelled' | 'expired' | 'failed' }
```

The request/session must match the original. Submitted means the encrypted
response was delivered, **not** that the underlying operation succeeded. The
next native tool result reports success/failure.

## Encryption and response

All fields are encrypted together as a JSON object with exactly the listed
keys. Preserve the exact Unicode and whitespace values; do not trim or normalize.
Each string is 1–4096 UTF-8 bytes (identifier at most 1024), and the encoded JSON
plaintext is at most 16384 bytes. Codes are masked **text**, not numeric-only;
alphanumeric recovery codes work. Hermes validates decrypted JSON, rejecting
duplicate/extra/missing keys and invalid value types/lengths.

Fresh AES256-GCM uses a random 32-byte key, 12-byte IV and 128-bit tag. RSA3072
OAEP-SHA256 wraps that AES key. Both the OAEP label and GCM AAD are compact UTF-8
JSON of the following ordered array, with actual null for an unthreaded request:

```text
[3,botId,requesterUserId,profileId,sessionKey,invocationId,conversationId,
 threadId-or-null,requestId,promptKind,fields,target,nonce,expiresAt]
```

The client uses Eden Treaty, outside React Query mutations/caches, to POST
`/bot-runtime/invocations/:invocationId/interactions/:eventId/secure-input`:

```ts
{ version: 3, action: 'submit', wrappedKeyB64, ivB64, ciphertextB64 }
// or, without WebCrypto:
{ version: 3, action: 'cancel' }
```

All three encrypted values use canonical standard padded base64; decoded sizes
are 384 bytes, 12 bytes and 17–16400 bytes respectively (ciphertext includes tag).
No plaintext or replacement routing/actor property is accepted. Failures use
fixed safe errors and every response, including auth, malformed JSON and upstream
failures, is `Cache-Control: no-store`.

Secret strings live only in the mounted form and temporary encryption copies.
The form clears immediately on submit/cancel and on failure, resolution, expiry,
request/context replacement, viewer changes, terminal invocation and unmount.
A replacement remount invalidates old async crypto so it cannot deliver a stale
answer. Timers expire a mounted form even without a parent update. Byte buffers
are zeroed; JavaScript strings and CryptoKey allocations cannot promise physical
memory erasure. There is no localStorage/sessionStorage, Zustand or query-cache
secret/ciphertext entry.

## Signed direct relay

The API reconstructs the complete context from the first request and current
invocation/bot, then immediately sends:

```ts
{
  type: 'thechat.hermes_platform.secure_input',
  interaction: {
    id: eventId, requestType: 'secure.input.request',
    invocationId, conversationId, threadId,
    actorUserId: originalInvocationHumanRequester,
    action, version: 3, requestId, sessionKey, profileId, requesterUserId,
    promptKind, fields, target, nonce, expiresAt,
    algorithm: 'RSA-OAEP-3072-SHA256+A256GCM',
    // wrappedKeyB64, ivB64, ciphertextB64 only for submit
  }
}
```

`publicKeySpkiB64` is not echoed in the relay. Existing timestamp/HMAC headers
sign the exact body; redirects are refused and the bounded delivery timeout is
five seconds. Only `{ok:true, duplicate:boolean}` is reflected from the upstream
acknowledgment. Ciphertext never enters PostgreSQL, Redis, realtime, BullMQ,
progress metadata, durable bot requests or logs. Hermes handles this envelope
**before** any durable inbox write and owns atomic single-use/concurrent/replay
fencing, as with v2. TheChat does not queue or retry ciphertext. After an ambiguous
network failure the user must re-enter values; Hermes's consumed-request state
prevents a second secret delivery.

## Verification

With disposable loopback PostgreSQL/Redis configured in the normal `.env`:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
# From packages/api (Bun options precede explicit ./ paths):
TEST_REDIS_URL=redis://127.0.0.1:16380 bun test --env-file ../../.env --timeout=30000 ./src/services/secure-input.test.ts ./src/services/vault-unlock.test.ts ./src/services/bot-progress-store.test.ts
bun test --env-file ../../.env --timeout=30000 -t 'Secure input v3|Native vault unlock' ./src/bots/bots.test.ts
# From repository root:
pnpm --filter @thechat/client exec vitest run src/routes/channel.test.tsx src/components/HermesSecureInput.test.tsx src/lib/hermes-secure-input.test.ts src/hooks/useBotRuntime.test.ts
python3 scripts/test.py typecheck client web desktop client-boundaries
pnpm build:web
pnpm build:desktop
pnpm build:api
```

Tests use synthetic values and real WebCrypto, API routes, PostgreSQL, Redis
and signed loopback webhooks. No real password manager, credentials or privilege
changes are required. Paired Hermes broker interoperability must also be
verified before publication; a client encryption test alone does not prove it.
