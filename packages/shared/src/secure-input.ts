/** Hermes stamps `expiresAt` from its own clock, which can run ahead of TheChat's. */
export const MASKED_PROMPT_LIFETIME_MS = 120_000;
export const MASKED_PROMPT_CLOCK_SKEW_MS = 30_000;
/** Latest acceptable `expiresAt` relative to a local reference time (now, or the event's createdAt). */
export function maskedPromptExpiryTooFar(expiresAt: number, reference: number) {
  return expiresAt > reference + MASKED_PROMPT_LIFETIME_MS + MASKED_PROMPT_CLOCK_SKEW_MS;
}

/** v3 public metadata only. Secret values must never enter a store or message. */
export const SECURE_INPUT_KINDS = {
  "onepassword.unlock": { fields: ["password"], title: "Unlock 1Password", description: "Unlock 1Password for this agent/profile. Owner only." },
  "vault.save_login": { fields: ["identifier", "password"], title: "Save browser login", description: "Save this login in the agent's vault for the displayed origin. Owner only." },
  "vault.code": { fields: ["code"], title: "Enter verification code", description: "Send a one-time or recovery code to the requesting browser session." },
  "sudo.password": { fields: ["password"], title: "Enter sudo password", description: "Provide a password for the displayed command. This does not replace command approval." },
  "skill.secret": { fields: ["value"], title: "Save skill secret", description: "Store this secret in the active agent profile's environment. Owner only." },
} as const;
export type SecureInputKind = keyof typeof SECURE_INPUT_KINDS;
export type SecureInputField = "identifier" | "password" | "code" | "value";
export interface SecureInputRequest {
  version: 3;
  requestId: string;
  sessionKey: string;
  profileId: string;
  requesterUserId: string;
  promptKind: SecureInputKind;
  fields: SecureInputField[];
  target: string;
  nonce: string;
  expiresAt: number;
  algorithm: "RSA-OAEP-3072-SHA256+A256GCM";
  publicKeySpkiB64: string;
}
export interface SecureInputResolved {
  version: 3;
  requestId: string;
  sessionKey: string;
  outcome: "submitted" | "cancelled" | "expired" | "failed";
}
export type SecureInputResponse =
  | { version: 3; action: "submit"; wrappedKeyB64: string; ivB64: string; ciphertextB64: string }
  | { version: 3; action: "cancel" };
