import { it, expect } from "vitest";
import { webcrypto } from "node:crypto";
import { encryptVaultUnlock, vaultUnlockContext } from "./hermes-vault-unlock";
it("encrypts exact unicode/whitespace UTF8 with OAEP label and matching AES AAD", async () => {
  const keys = await webcrypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const request = {
    version: 1 as const,
    requestId: "11111111-1111-4111-a111-111111111111",
    sessionKey: "session",
    profileId: "opaque",
    backend: "bitwarden" as const,
    ownerUserId: "owner",
    requesterUserId: "owner",
    nonce: Buffer.alloc(32).toString("base64url"),
    expiresAt: Date.now() + 120000,
    algorithm: "RSA-OAEP-3072-SHA256+A256GCM" as const,
    publicKeySpkiB64: Buffer.from(
      await webcrypto.subtle.exportKey("spki", keys.publicKey),
    ).toString("base64"),
  };
  const event = {
    botId: "bot",
    invocationId: "invocation",
    conversationId: "conversation",
    threadId: null,
  };
  const secret = "  päss🔒e\u0301 \t";
  const encrypted = await encryptVaultUnlock(
    event,
    request,
    secret,
    webcrypto as unknown as Crypto,
  );
  const aad = Uint8Array.from(
    new TextEncoder().encode(vaultUnlockContext(event, request)),
  );
  expect(JSON.parse(new TextDecoder().decode(aad))).toEqual([
    1,
    "bot",
    "owner",
    "owner",
    "opaque",
    "session",
    "invocation",
    "conversation",
    null,
    request.requestId,
    "bitwarden",
    request.nonce,
    request.expiresAt,
  ]);
  const aes = await webcrypto.subtle.decrypt(
    { name: "RSA-OAEP", label: aad },
    keys.privateKey,
    Buffer.from(encrypted.wrappedKeyB64, "base64"),
  );
  const key = await webcrypto.subtle.importKey("raw", aes, "AES-GCM", false, [
    "decrypt",
  ]);
  const plain = await webcrypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(encrypted.ivB64, "base64"),
      additionalData: aad,
      tagLength: 128,
    },
    key,
    Buffer.from(encrypted.ciphertextB64, "base64"),
  );
  expect(Buffer.from(plain).equals(Buffer.from(secret, "utf8"))).toBe(true);
  await expect(
    encryptVaultUnlock(
      event,
      request,
      "é".repeat(2049),
      webcrypto as unknown as Crypto,
    ),
  ).rejects.toThrow();
});
