import crypto from "node:crypto";

const ENVELOPE_VERSION = "v1";

function encryptionKey(): Buffer {
  const source = process.env.THECHAT_SECRET_KEY?.trim() ||
    process.env.BETTER_AUTH_SECRET?.trim();
  if (!source) {
    throw new Error(
      "THECHAT_SECRET_KEY or BETTER_AUTH_SECRET is required for credential encryption",
    );
  }
  return crypto.createHash("sha256").update(source, "utf8").digest();
}

/** AES-256-GCM envelope for server-side control-plane credentials. */
export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

export function decryptSecret(envelope: string): string {
  const [version, ivValue, tagValue, encryptedValue, ...extra] =
    envelope.split(":");
  if (
    version !== ENVELOPE_VERSION ||
    !ivValue ||
    !tagValue ||
    !encryptedValue ||
    extra.length > 0
  ) {
    throw new Error("Invalid encrypted credential envelope");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
