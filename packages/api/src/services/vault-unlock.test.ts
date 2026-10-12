import { describe, test, expect } from "bun:test";
import crypto from "node:crypto";
import {
  vaultUnlockRequestSchema,
  vaultUnlockResponseSchema,
  vaultUnlockResolvedSchema,
  validateVaultPublicKey,
} from "./vault-unlock";
const { publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 3072,
});
const request = () => ({
  version: 2,
  requestId: crypto.randomUUID(),
  sessionKey: "session",
  profileId: "opaque",
  backend: "bitwarden",
  requesterUserId: "requester",
  nonce: crypto.randomBytes(32).toString("base64url"),
  expiresAt: Date.now() + 120000,
  algorithm: "RSA-OAEP-3072-SHA256+A256GCM",
  publicKeySpkiB64: publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64"),
});
describe("vault unlock strict contract", () => {
  test("admits exactly v2 requester metadata and RSA3072 SPKI", () => {
    expect(vaultUnlockRequestSchema.safeParse(request()).success).toBe(true);
    expect(() => validateVaultPublicKey(request().publicKeySpkiB64)).not.toThrow();
    expect(vaultUnlockRequestSchema.safeParse({ ...request(), version: 1 }).success).toBe(false);
    for (const field of ["password", "ciphertextB64", "response", "ownerUserId"])
      expect(vaultUnlockRequestSchema.safeParse({ ...request(), [field]: "secret" }).success).toBe(false);
    const badKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
      .publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(() => validateVaultPublicKey(badKey)).toThrow();
  });
  test("accepts v2 cancellation and exact canonical encrypted byte sizes only", () => {
    const response = {
      version: 2,
      action: "submit",
      wrappedKeyB64: Buffer.alloc(384).toString("base64"),
      ivB64: Buffer.alloc(12).toString("base64"),
      ciphertextB64: Buffer.alloc(17).toString("base64"),
    };
    expect(vaultUnlockResponseSchema.safeParse(response).success).toBe(true);
    expect(vaultUnlockResponseSchema.safeParse({ version: 2, action: "cancel" }).success).toBe(true);
    for (const bad of [
      { ...response, password: "secret" },
      { ...response, ivB64: Buffer.alloc(11).toString("base64") },
      { ...response, ciphertextB64: Buffer.alloc(4113).toString("base64") },
      { ...response, wrappedKeyB64: response.wrappedKeyB64 + "\n" },
      { version: 2, action: "cancel", ivB64: "secret" },
      { ...response, version: 1 },
      { version: 1, action: "cancel" },
    ]) expect(vaultUnlockResponseSchema.safeParse(bad).success).toBe(false);
  });
  test("accepts v2 metadata resolution and rejects legacy envelopes", () => {
    const resolution = { version: 2, requestId: request().requestId, sessionKey: "session", outcome: "cancelled" };
    expect(vaultUnlockResolvedSchema.safeParse(resolution).success).toBe(true);
    expect(vaultUnlockResolvedSchema.safeParse({ ...resolution, version: 1 }).success).toBe(false);
    expect(vaultUnlockResolvedSchema.safeParse({ ...resolution, ownerUserId: "owner" }).success).toBe(false);
  });
});
