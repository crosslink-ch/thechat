import crypto from "crypto";

const ENVELOPE_VERSION = "v1";

function encryptionKey(): Buffer {
  const secret = process.env.THECHAT_SECRET_KEY ?? process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("THECHAT_SECRET_KEY or BETTER_AUTH_SECRET is required for secret encryption");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

/** Repository-compatible AES-256-GCM envelope used for control-plane secrets. */
export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function decryptSecret(envelope: string): string {
  const [version, ivValue, tagValue, encryptedValue, ...extra] = envelope.split(":");
  if (
    version !== ENVELOPE_VERSION ||
    !ivValue ||
    !tagValue ||
    encryptedValue === undefined ||
    extra.length > 0
  ) {
    throw new Error("Encrypted secret has an unsupported format");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivValue, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
