# Native owner-only Bitwarden unlock (v1)

This is a dedicated encrypted native vault response, **not** clarification text,
chat content, a bot invocation, or a copy/migration of Hermes vault state. The
shared client supplies the same UI and encryption for web and desktop.

## Request and identity

`GET /hermes-platform/health` (Hermes bot token only) exposes top-level
`ownerUserId` from canonical `bots.ownerId`. The gateway must bind its trusted
owner to that value, not to chat member roles or user-supplied claims.

The bot publishes `vault.unlock.request` through the existing progress endpoint.
The API strictly validates the following metadata-only payload:

```ts
{
  version: 1,
  requestId: UUID,
  sessionKey: string,
  profileId: opaqueString,
  backend: 'bitwarden',
  ownerUserId: canonicalBotOwner,
  requesterUserId: canonicalBotOwner,
  nonce: base64url32Bytes,
  expiresAt: unixMillisecondsInteger,
  algorithm: 'RSA-OAEP-3072-SHA256+A256GCM',
  publicKeySpkiB64: base64Rsa3072Spki
}
```

Lifetime is at most 120 seconds. The original invocation requester must be a
human and the bot owner. The API rejects injected extra payload properties,
non-SPKI/non-RSA3072 keys, forged owner/requester claims, expired requests and
terminal execution. Stable request retries preserve the first context; a retry
cannot replace its profile, session, nonce, expiry or public key.

The API forces status `waiting`, label `Unlock Bitwarden`, and preview
`Unlocking allows Hermes to access your owner vault for this runtime profile.`
Tool identifiers and caller-supplied preview/label are not stored for this type.
Both realtime publication and snapshot reads enforce canonical owner-only
access. Client hiding is additional defense, not the authorization boundary.
Pending vault prompts survive the normal inactivity timeout and event overflow
until their expiry or matching resolution.

## Response, encryption and relay

The client uses Eden Treaty to POST:

`/bot-runtime/invocations/:invocationId/interactions/:eventId/vault-unlock`

Strict response union:

```ts
{ version: 1, action: 'submit', wrappedKeyB64, ivB64, ciphertextB64 }
// or, no crypto required:
{ version: 1, action: 'cancel' }
```

Standard canonical padded base64 is required. Decoded sizes are exactly 384
bytes for the wrapped key, exactly 12 for IV, and 17–4112 for ciphertext including
the GCM authentication tag. No plaintext field or replacement routing context
is accepted.

The browser encrypts the exact UTF-8 password bytes (1–4096 bytes), without
trimming or Unicode normalization, with a random 32-byte AES256-GCM key and
random 12-byte IV. The 128-bit GCM tag is included in ciphertext. RSA-OAEP with
the ephemeral RSA3072 SPKI and SHA256 wraps the AES key. Both OAEP label and GCM
AAD are UTF-8 compact JSON of this **ordered array**:

```text
[1,botId,ownerUserId,requesterUserId,profileId,sessionKey,invocationId,
 conversationId,threadId-or-null,requestId,'bitwarden',nonce,expiresAt]
```

The password exists only in masked component state and temporary encryption
buffers. Input clears before submission/cancellation and on request replacement,
resolution/expiry and unmount. There is no secret-bearing local/session storage,
Zustand store, React Query mutation/cache, chat message, progress event, database,
Redis or invocation inbox. Buffer copies are zeroed when encryption completes;
JavaScript strings/CryptoKey allocations cannot promise physical memory erasure.
No secret values or upstream diagnostic bodies are displayed in errors.

The API verifies the human owner, original human requester, current conversation
access, active invocation, exact request event and unexpired/unresolved metadata.
It signs and directly forwards this envelope, without queuing or persisting the
body:

```ts
{
  type: 'thechat.hermes_platform.vault_unlock',
  interaction: {
    id: eventId, requestType: 'vault.unlock.request', requestId,
    invocationId, conversationId, threadId, sessionKey, version: 1,
    profileId, backend: 'bitwarden', ownerUserId, requesterUserId,
    nonce, expiresAt, algorithm: 'RSA-OAEP-3072-SHA256+A256GCM',
    actorUserId: canonicalOwner, action,
    // encryptedFields only for action=submit
  }
}
```

All context is canonical from the invocation and first request event. Existing
webhook timestamp/signature headers bind the body; redirects are refused.
The response is sanitized metadata `{ok:true, duplicate:boolean}` from the
upstream acknowledgment. The dedicated endpoint sends `Cache-Control: no-store`
on success, auth/validation/service failures and malformed JSON. The response
contains fixed errors, never upstream text. Normal approvals/clarifications are
unchanged.

## Resolution

The bot publishes `vault.unlock.resolved` with strict metadata payload:

```ts
{ version: 1, requestId, sessionKey,
  outcome: 'submitted' | 'cancelled' | 'expired' | 'failed' }
```

Resolution must identify the same request and session. **Submitted means only
that the encrypted response was delivered**, not that Bitwarden unlocked. The
next native vault tool result reports success/failure. The ephemeral key and
native unlock operation remain owned by Hermes, outside TheChat.

## Verification

Synthetic tests cover strict payload/key/size validation, signed canonical
relay, owner/member/bot authorization, realtime and snapshot privacy, no
invocation/progress persistence of the response, expiry/resolution/terminal
execution, malformed JSON/no-store and safe errors. Client tests cover exact
Unicode/whitespace roundtrip with real WebCrypto, masked input cleanup,
crypto-free cancel, dedicated Eden transport and overlapping progress lanes.
Run Bun API tests with disposable loopback PostgreSQL/Redis, shared client tests,
`pnpm -r exec tsc --noEmit`, `pnpm build:web`, and `pnpm build:desktop`.
