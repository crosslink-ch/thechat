import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { SECURE_INPUT_KINDS } from "@thechat/shared";
import { secureInputRequestSchema, secureInputResolvedSchema, secureInputResponseSchema } from "./secure-input";
const key = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
const request = () => ({ version: 3, requestId: crypto.randomUUID(), sessionKey: "session", profileId: "opaque", requesterUserId: "requester", promptKind: "vault.code", fields: ["code"], target: "https://example.test", nonce: crypto.randomBytes(32).toString("base64url"), expiresAt: Date.now() + 120000, algorithm: "RSA-OAEP-3072-SHA256+A256GCM", publicKeySpkiB64: key });
describe("secure input v3 strict wire", () => {
  test("validates every fixed shape and rejects secret, actor, custom-field, unsafe target and noncanonical inputs", () => {
    for (const [kind, spec] of Object.entries(SECURE_INPUT_KINDS)) {
      const value = { ...request(), promptKind: kind, fields: [...spec.fields], target: kind === "onepassword.unlock" ? "1Password" : kind === "skill.secret" ? "MY_SECRET" : "https://example.test" };
      expect(secureInputRequestSchema.safeParse(value).success).toBe(true);
    }
    for (const change of [
      { password: "DO_NOT_REFLECT" }, { actorUserId: "forged" }, { fields: ["password"] }, { fields: ["code", "code"] }, { fields: [{ name: "code", type: "text" }] }, { promptKind: "other" }, { version: 2 }, { requestId: request().requestId.toUpperCase() }, { nonce: "_".repeat(43) }, { profileId: "invisible\u0000" }, { publicKeySpkiB64: key + "\n" }, { publicKeySpkiB64: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64") }, { target: " " }, { target: "https://example.test\nsecret" },
      { promptKind: "vault.save_login", fields: ["password", "identifier"] }, { promptKind: "vault.save_login", fields: ["identifier", "password"], target: "https://example.test/path" },
      { promptKind: "skill.secret", fields: ["value"], target: "KEY=value" }, { promptKind: "onepassword.unlock", fields: ["password"], target: "Other" },
    ]) expect(secureInputRequestSchema.safeParse({ ...request(), ...change }).success).toBe(false);
  });
  test("bounds standard canonical base64 ciphertext and admits no routing/plaintext properties", () => {
    const response = { version: 3, action: "submit", wrappedKeyB64: Buffer.alloc(384).toString("base64"), ivB64: Buffer.alloc(12).toString("base64"), ciphertextB64: Buffer.alloc(16400).toString("base64") };
    expect(secureInputResponseSchema.safeParse(response).success).toBe(true);
    expect(secureInputResponseSchema.safeParse({ version: 3, action: "cancel" }).success).toBe(true);
    for (const change of [{ version: 2 }, { password: "secret" }, { requestId: "forged" }, { actorUserId: "forged" }, { ciphertextB64: Buffer.alloc(16401).toString("base64") }, { ciphertextB64: Buffer.alloc(16).toString("base64") }, { ivB64: Buffer.alloc(13).toString("base64") }, { wrappedKeyB64: response.wrappedKeyB64 + "\n" }, { action: "cancel" }]) expect(secureInputResponseSchema.safeParse({ ...response, ...change }).success).toBe(false);
    const resolved = { version: 3, requestId: request().requestId, sessionKey: "session", outcome: "expired" };
    expect(secureInputResolvedSchema.safeParse(resolved).success).toBe(true);
    expect(secureInputResolvedSchema.safeParse({ ...resolved, value: "secret" }).success).toBe(false);
  });
});
