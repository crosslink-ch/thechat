# Native shared Bitwarden unlock (v2)

This is a dedicated encrypted native vault response, **not** clarification text,
chat content, a bot invocation, or a copy/migration of Hermes vault state. The
shared client supplies the same UI and encryption for web and desktop.

## Shared access, private interaction

Any already-admitted human who initiated the invocation can request and answer
**their own** Bitwarden unlock prompt, irrespective of bot ownership. Unlocking
makes Bitwarden available to all admitted users of that agent/runtime profile.
It is not a requester-private vault session. The initiating requester alone sees
the request and its resolution in both realtime fanout and runtime snapshots;
other participants, including the bot owner, cannot submit or cancel it.
Conversation admission and current bot access checks are unchanged.

`GET /hermes-platform/health` still exposes canonical `ownerUserId` for existing
owner-scoped integrations. That value is **not** a Bitwarden authorization input.
1Password and ordinary approval/clarification semantics are unchanged.

## Request and identity

The bot publishes `vault.unlock.request` through the existing progress endpoint.
The API strictly validates this metadata-only payload:

```ts
{
  version: 2,
  requestId: UUID,
  sessionKey: string,
  profileId: opaqueString,
  backend: 'bitwarden',
  requesterUserId: originalInvocationHumanRequester,
  nonce: base64url32Bytes,
  expiresAt: unixMillisecondsInteger,
  algorithm: 'RSA-OAEP-3072-SHA256+A256GCM',
  publicKeySpkiB64: base64Rsa3072Spki
}
```

Lifetime is at most 120 seconds. The original invocation requester must be a
human with current conversation access. The bot credential must match the
invocation, and the bot must still have access to the conversation. The API
rejects extra properties (including `ownerUserId`), non-SPKI/non-RSA3072 keys,
forged requester claims, expired requests and terminal execution. Stable retries
preserve the first context: a retry cannot replace its profile, session, nonce,
expiry or public key. Equality is schema-canonical so Redis JSON key ordering
cannot break an exact retry. A concurrent altered retry is rejected after the
store's atomic first-request selection, without replacing the original context.

The API forces status `waiting`, label `Unlock Bitwarden`, and preview
`Unlocking gives all users of this agent/profile access to Bitwarden.`
Tool identifiers and caller-supplied preview/label are not stored for this type.
Client requester-only hiding is additional defense, not the authorization
boundary. Pending prompts survive inactivity and event overflow until expiry
or matching resolution. Expired metadata remains available only for lifecycle
correlation, not public snapshots.

## Response, encryption and relay

The client uses Eden Treaty to POST:

`/bot-runtime/invocations/:invocationId/interactions/:eventId/vault-unlock`

Strict response union:

```ts
{ version: 2, action: 'submit', wrappedKeyB64, ivB64, ciphertextB64 }
// or, no crypto required:
{ version: 2, action: 'cancel' }
```

Standard canonical padded base64 is required. Decoded sizes are exactly 384
bytes for the wrapped key, exactly 12 for IV, and 17–4112 for ciphertext including
the GCM authentication tag. No plaintext field or replacement routing context
is accepted.

The browser encrypts exact UTF-8 password bytes (1–4096 bytes), without trimming
or Unicode normalization, with a random 32-byte AES256-GCM key and random 12-byte
IV. The 128-bit GCM tag is included in ciphertext. RSA-OAEP with ephemeral
RSA3072 SPKI and SHA256 wraps the AES key. Both OAEP label and GCM AAD are UTF-8
compact JSON of this **ordered array**:

```text
[2,botId,requesterUserId,profileId,sessionKey,invocationId,
 conversationId,threadId-or-null,requestId,'bitwarden',nonce,expiresAt]
```

Password state exists only in the masked mounted component and temporary
encryption buffers. Input clears before submission/cancellation and on request
replacement, resolution/expiry and unmount. No secret-bearing local/session
storage, Zustand store, React Query mutation/cache, chat message, progress event,
database, Redis or invocation inbox is written. Temporary byte copies are zeroed
when encryption completes; JavaScript strings/CryptoKey allocations cannot
promise physical memory erasure. Errors never display secrets or upstream text.

The API verifies the original human requester, current conversation and bot
access, active invocation, exact request event and unexpired/unresolved metadata.
It signs and directly forwards this envelope without queuing or persisting it:

```ts
{
  type: 'thechat.hermes_platform.vault_unlock',
  interaction: {
    id: eventId, requestType: 'vault.unlock.request', requestId,
    invocationId, conversationId, threadId, sessionKey, version: 2,
    profileId, backend: 'bitwarden', requesterUserId,
    nonce, expiresAt, algorithm: 'RSA-OAEP-3072-SHA256+A256GCM',
    actorUserId: originalInvocationHumanRequester, action,
    // encryptedFields only for action=submit
  }
}
```

All context comes from the invocation and first request. Existing webhook
signature/timestamp headers bind the exact body; redirects are refused. The
sanitized upstream acknowledgment is `{ok:true, duplicate:boolean}`. The
endpoint sends `Cache-Control: no-store` on success, auth/validation/service
failures and malformed JSON. Errors are fixed and never reflect upstream text.

## Resolution and paired rollout

The bot publishes strict metadata-only `vault.unlock.resolved`:

```ts
{ version: 2, requestId, sessionKey,
  outcome: 'submitted' | 'cancelled' | 'expired' | 'failed' }
```

The resolution's request/session correlate with the first request; its private
recipient comes from the original invocation requester, not owner metadata or
caller-supplied routing. **Submitted means only that the encrypted response was
delivered**, not that Bitwarden unlocked. The next native tool result reports
success/failure. Ephemeral keys, unlock work, per-profile isolation, idle expiry,
Lock and shutdown relocking remain Hermes responsibilities. Successful shared
Bitwarden state survives initiating-session teardown, while pending unlock work
is still cancelled/fenced by Hermes.

Deploy this v2 TheChat contract together with the corresponding Hermes change.
Legacy v1 requests, resolutions and responses are rejected; they are never
reinterpreted using v2 authenticated context. A mixed-version pair therefore
fails closed. Finish/cancel existing prompts before a coordinated rollout;
retry the native vault operation after both sides support v2. Do not fall back
to sending a password through chat or ordinary clarification.

## Verification

Synthetic tests exercise nonowner admission, requester-only submit/cancel,
signed canonical relay, requester-private realtime/snapshot projections,
legacy-envelope rejection, strict key/size validation, unchanged persistence,
expiry/resolution/terminal execution, first-context retries (real Redis and
concurrent races), malformed JSON/no-store and safe errors. Shared client tests
exercise real WebCrypto exact Unicode/whitespace roundtrip, authenticated-context
tampering, masked input lifecycle cleanup, crypto-free cancel, dedicated Eden
transport and overlapping progress lanes.

Run Bun API tests with disposable loopback PostgreSQL/Redis, shared client tests,
`pnpm -r exec tsc --noEmit`, `pnpm build:web`, and `pnpm build:desktop`.
