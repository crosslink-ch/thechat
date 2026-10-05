import { describe, test, expect } from "bun:test";
import crypto from "node:crypto";
import {
  vaultUnlockRequestSchema,
  vaultUnlockResponseSchema,
  validateVaultPublicKey,
} from "./vault-unlock";
const { publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 3072,
});
const request = () => ({
  version: 1,
  requestId: crypto.randomUUID(),
  sessionKey: "session",
  profileId: "opaque",
  backend: "bitwarden",
  ownerUserId: "owner",
  requesterUserId: "owner",
  nonce: crypto.randomBytes(32).toString("base64url"),
  expiresAt: Date.now() + 120000,
  algorithm: "RSA-OAEP-3072-SHA256+A256GCM",
  publicKeySpkiB64: publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64"),
});
describe("vault unlock strict contract", () => {
  test("admits exactly metadata and RSA3072 SPKI", () => {
    expect(vaultUnlockRequestSchema.safeParse(request()).success).toBe(true);
    expect(() =>
      validateVaultPublicKey(request().publicKeySpkiB64),
    ).not.toThrow();
    for (const field of ["password", "ciphertextB64", "response"])
      expect(
        vaultUnlockRequestSchema.safeParse({ ...request(), [field]: "secret" })
          .success,
      ).toBe(false);
    const badKey = crypto
      .generateKeyPairSync("rsa", { modulusLength: 2048 })
      .publicKey.export({ format: "der", type: "spki" })
      .toString("base64");
    expect(() => validateVaultPublicKey(badKey)).toThrow();
  });
  test("accepts cancellation and exact canonical encrypted byte sizes only", () => {
    const response = {
      version: 1,
      action: "submit",
      wrappedKeyB64: Buffer.alloc(384).toString("base64"),
      ivB64: Buffer.alloc(12).toString("base64"),
      ciphertextB64: Buffer.alloc(17).toString("base64"),
    };
    expect(vaultUnlockResponseSchema.safeParse(response).success).toBe(true);
    expect(
      vaultUnlockResponseSchema.safeParse({ version: 1, action: "cancel" })
        .success,
    ).toBe(true);
    for (const bad of [
      { ...response, password: "secret" },
      { ...response, ivB64: Buffer.alloc(11).toString("base64") },
      { ...response, ciphertextB64: Buffer.alloc(4113).toString("base64") },
      { ...response, wrappedKeyB64: response.wrappedKeyB64 + "\n" },
      { version: 1, action: "cancel", ivB64: "secret" },
    ])
      expect(vaultUnlockResponseSchema.safeParse(bad).success).toBe(false);
  });
});
