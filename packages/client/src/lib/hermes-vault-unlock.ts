import type {
  BotInvocationProgressEventPublic,
  VaultUnlockRequest,
  VaultUnlockResponse,
} from "@thechat/shared";
export interface VaultUnlockState {
  event: BotInvocationProgressEventPublic;
  request: VaultUnlockRequest;
  outcome: "submitted" | "cancelled" | "expired" | "failed" | null;
}
export function deriveVaultUnlockStates(
  events: BotInvocationProgressEventPublic[],
  now = Date.now(),
): VaultUnlockState[] {
  const states: VaultUnlockState[] = [];
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type === "vault.unlock.request") {
      const p = event.payload;
      const keys = [
        "version",
        "requestId",
        "sessionKey",
        "profileId",
        "backend",
        "requesterUserId",
        "nonce",
        "expiresAt",
        "algorithm",
        "publicKeySpkiB64",
      ];
      if (
        !p ||
        Object.keys(p).length !== keys.length ||
        keys.some((k) => !(k in p)) ||
        p.version !== 2 ||
        p.backend !== "bitwarden" ||
        p.algorithm !== "RSA-OAEP-3072-SHA256+A256GCM" ||
        typeof p.expiresAt !== "number" ||
        !Number.isSafeInteger(p.expiresAt) ||
        [
          "requestId",
          "sessionKey",
          "profileId",
          "requesterUserId",
          "nonce",
          "publicKeySpkiB64",
        ].some((k) => typeof p[k] !== "string" || !(p[k] as string).length)
      )
        continue;
      if (
        states.some(
          (s) =>
            s.event.invocationId === event.invocationId &&
            s.request.requestId === p.requestId,
        )
      )
        continue;
      states.push({
        event,
        request: p as unknown as VaultUnlockRequest,
        outcome: p.expiresAt <= now ? "expired" : null,
      });
    } else if (event.type === "vault.unlock.resolved") {
      const p = event.payload;
      if (
        !p ||
        p.version !== 2 ||
        !["submitted", "cancelled", "expired", "failed"].includes(
          String(p.outcome),
        ) ||
        Object.keys(p).length !== 4
      )
        continue;
      const state = states.find(
        (s) =>
          s.event.invocationId === event.invocationId &&
          s.event.botId === event.botId &&
          s.request.requestId === p.requestId &&
          s.request.sessionKey === p.sessionKey,
      );
      if (state) state.outcome = p.outcome as VaultUnlockState["outcome"];
    }
  }
  return states;
}
type ContextEvent = Pick<
  BotInvocationProgressEventPublic,
  "botId" | "invocationId" | "conversationId" | "threadId"
>;
export function vaultUnlockContext(
  event: ContextEvent,
  request: VaultUnlockRequest,
) {
  return JSON.stringify([
    2,
    event.botId,
    request.requesterUserId,
    request.profileId,
    request.sessionKey,
    event.invocationId,
    event.conversationId,
    event.threadId,
    request.requestId,
    "bitwarden",
    request.nonce,
    request.expiresAt,
  ]);
}
function fromBase64(value: string) {
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (toBase64(bytes) !== value)
    throw new Error("Invalid vault unlock request");
  return bytes;
}
function toBase64(value: Uint8Array) {
  return btoa(String.fromCharCode(...value));
}
export async function encryptVaultUnlock(
  event: ContextEvent,
  request: VaultUnlockRequest,
  password: string,
  cryptoApi: Crypto = globalThis.crypto,
): Promise<Extract<VaultUnlockResponse, { action: "submit" }>> {
  const bytes = new TextEncoder().encode(password);
  let aesBytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    if (
      !cryptoApi?.subtle ||
      bytes.length === 0 ||
      bytes.length > 4096 ||
      request.version !== 2 ||
      request.backend !== "bitwarden" ||
      request.expiresAt <= Date.now() ||
      request.algorithm !== "RSA-OAEP-3072-SHA256+A256GCM"
    )
      throw new Error();
    const publicKey = await cryptoApi.subtle.importKey(
      "spki",
      fromBase64(request.publicKeySpkiB64),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    if ((publicKey.algorithm as RsaHashedKeyAlgorithm).modulusLength !== 3072)
      throw new Error();
    aesBytes = cryptoApi.getRandomValues(new Uint8Array(32));
    const aesKey = await cryptoApi.subtle.importKey(
      "raw",
      aesBytes,
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const context = new TextEncoder().encode(
      vaultUnlockContext(event, request),
    );
    const ciphertext = await cryptoApi.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: context, tagLength: 128 },
      aesKey,
      bytes,
    );
    const wrapped = await cryptoApi.subtle.encrypt(
      { name: "RSA-OAEP", label: context },
      publicKey,
      aesBytes,
    );
    return {
      version: 2,
      action: "submit",
      wrappedKeyB64: toBase64(new Uint8Array(wrapped)),
      ivB64: toBase64(iv),
      ciphertextB64: toBase64(new Uint8Array(ciphertext)),
    };
  } catch {
    throw new Error("Could not encrypt the vault unlock response.");
  } finally {
    bytes.fill(0);
    aesBytes?.fill(0);
  }
}
