import crypto from "node:crypto";
import { z } from "zod";
import { ServiceError } from "./errors";

const token = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v === v.trim());
const base64 = (min: number, max = min) =>
  z
    .string()
    .max(Math.ceil(max / 3) * 4)
    .refine((value) => {
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          value,
        )
      )
        return false;
      const bytes = Buffer.from(value, "base64");
      return (
        bytes.length >= min &&
        bytes.length <= max &&
        bytes.toString("base64") === value
      );
    });
export const vaultUnlockRequestSchema = z
  .object({
    version: z.literal(2),
    requestId: z.string().uuid(),
    sessionKey: token(1000),
    profileId: token(255),
    backend: z.literal("bitwarden"),
    requesterUserId: token(255),
    nonce: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .refine(
        (v) =>
          Buffer.from(v, "base64url").length === 32 &&
          Buffer.from(v, "base64url").toString("base64url") === v,
      ),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    algorithm: z.literal("RSA-OAEP-3072-SHA256+A256GCM"),
    publicKeySpkiB64: base64(1, 1024),
  })
  .strict();
export const vaultUnlockResolvedSchema = z
  .object({
    version: z.literal(2),
    requestId: z.string().uuid(),
    sessionKey: token(1000),
    outcome: z.enum(["submitted", "cancelled", "expired", "failed"]),
  })
  .strict();
export const vaultUnlockResponseSchema = z.discriminatedUnion("action", [
  z
    .object({
      version: z.literal(2),
      action: z.literal("submit"),
      wrappedKeyB64: base64(384),
      ivB64: base64(12),
      ciphertextB64: base64(17, 4112),
    })
    .strict(),
  z.object({ version: z.literal(2), action: z.literal("cancel") }).strict(),
]);
export function validateVaultPublicKey(value: string) {
  try {
    const der = Buffer.from(value, "base64");
    const key = crypto.createPublicKey({
      key: der,
      format: "der",
      type: "spki",
    });
    if (
      key.asymmetricKeyType !== "rsa" ||
      key.asymmetricKeyDetails?.modulusLength !== 3072 ||
      !Buffer.from(key.export({ format: "der", type: "spki" })).equals(der)
    )
      throw new Error();
  } catch {
    throw new ServiceError("Invalid vault unlock request", 400);
  }
}
export const VAULT_UNLOCK_PREVIEW =
  "Unlocking gives all users of this agent/profile access to Bitwarden.";
