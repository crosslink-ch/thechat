import { beforeAll, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { SECURE_INPUT_KINDS, type SecureInputKind, type SecureInputRequest } from "@thechat/shared";
import { encryptSecureInput, secureInputContext } from "./hermes-secure-input";
let keys: CryptoKeyPair;
let publicKeySpkiB64: string;
const event = { botId: "bot", invocationId: "run", conversationId: "conversation", threadId: "thread" };
const api = webcrypto as unknown as Crypto;
const bytes = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
beforeAll(async () => {
  keys = await api.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  publicKeySpkiB64 = Buffer.from(await api.subtle.exportKey("spki", keys.publicKey)).toString("base64");
});
function request(kind: SecureInputKind): SecureInputRequest {
  return { version: 3, requestId: "11111111-1111-4111-a111-111111111111", sessionKey: "session", profileId: "profile", requesterUserId: "requester", promptKind: kind, fields: [...SECURE_INPUT_KINDS[kind].fields], target: kind === "onepassword.unlock" ? "1Password" : kind === "skill.secret" ? "TEST_SECRET" : "https://example.test", nonce: Buffer.alloc(32).toString("base64url"), expiresAt: Date.now() + 120000, algorithm: "RSA-OAEP-3072-SHA256+A256GCM", publicKeySpkiB64 };
}
it.each(Object.keys(SECURE_INPUT_KINDS) as SecureInputKind[])("decrypts exact %s values and binds every context position with OAEP and AES AAD", async kind => {
  const r = request(kind);
  const values = Object.fromEntries(r.fields.map(field => [field, "  päss🔒e\u0301\tAB12-recovery  "]));
  const encrypted = await encryptSecureInput(event, r, values, api);
  const context = new TextEncoder().encode(secureInputContext(event, r));
  const rawKey = await api.subtle.decrypt({ name: "RSA-OAEP", label: context }, keys.privateKey, bytes(encrypted.wrappedKeyB64));
  const key = await api.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const plain = await api.subtle.decrypt({ name: "AES-GCM", iv: bytes(encrypted.ivB64), additionalData: context, tagLength: 128 }, key, bytes(encrypted.ciphertextB64));
  expect(new TextDecoder().decode(plain)).toBe(JSON.stringify(values));
  const expected = [3, "bot", "requester", "profile", "session", "run", "conversation", "thread", r.requestId, kind, r.fields, r.target, r.nonce, r.expiresAt];
  expect(secureInputContext(event, r)).toBe(JSON.stringify(expected));
  for (let index = 0; index < expected.length; index++) {
    const changed = [...expected]; changed[index] = "tampered";
    const aad = new TextEncoder().encode(JSON.stringify(changed));
    await expect(api.subtle.decrypt({ name: "RSA-OAEP", label: aad }, keys.privateKey, bytes(encrypted.wrappedKeyB64))).rejects.toThrow();
    await expect(api.subtle.decrypt({ name: "AES-GCM", iv: bytes(encrypted.ivB64), additionalData: aad }, key, bytes(encrypted.ciphertextB64))).rejects.toThrow();
  }
});
it("fails closed for missing/extra values, byte limits, expiry, bad key, and unavailable WebCrypto", async () => {
  const r = request("vault.save_login");
  const invalid: Record<string, string>[] = [{ identifier: "i" }, { identifier: "i", password: "p", extra: "x" }, { identifier: "i", password: "" }, { identifier: "ü".repeat(513), password: "p" }, { identifier: "i", password: "ü".repeat(2049) }];
  for (const values of invalid) await expect(encryptSecureInput(event, r, values, api)).rejects.toThrow("Could not encrypt the secure input response.");
  const values = { identifier: "i", password: "p" };
  for (const bad of [{ ...r, expiresAt: Date.now() - 1 }, { ...r, publicKeySpkiB64: "AAAA" }, { ...r, fields: ["password", "identifier"] }]) await expect(encryptSecureInput(event, bad as SecureInputRequest, values, api)).rejects.toThrow();
  await expect(encryptSecureInput(event, r, values, {} as Crypto)).rejects.toThrow();
  await expect(encryptSecureInput(event, r, { identifier: "i", password: "\u0001".repeat(4096) }, api)).rejects.toThrow();
});
