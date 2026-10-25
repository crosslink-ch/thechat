import { SECURE_INPUT_KINDS, maskedPromptExpiryTooFar, type BotInvocationProgressEventPublic, type SecureInputRequest, type SecureInputResolved, type SecureInputResponse } from "@thechat/shared";
export interface SecureInputState {
  event: BotInvocationProgressEventPublic;
  request: SecureInputRequest;
  outcome: SecureInputResolved["outcome"] | null;
}
const requestKeys = ["version", "requestId", "sessionKey", "profileId", "requesterUserId", "promptKind", "fields", "target", "nonce", "expiresAt", "algorithm", "publicKeySpkiB64"];
const safe = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && v === v.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
export function isSecureInputRequest(value: unknown): value is SecureInputRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as SecureInputRequest;
  if (Object.keys(r).length !== requestKeys.length || requestKeys.some(k => !(k in r)) || r.version !== 3 || !Object.hasOwn(SECURE_INPUT_KINDS, r.promptKind) || JSON.stringify(r.fields) !== JSON.stringify(SECURE_INPUT_KINDS[r.promptKind].fields) || r.algorithm !== "RSA-OAEP-3072-SHA256+A256GCM") return false;
  if (!safe(r.requestId, 36) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.requestId) || !safe(r.sessionKey, 1000) || !safe(r.profileId, 255) || !safe(r.requesterUserId, 255) || !safe(r.target, 2000) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= 0 || typeof r.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(r.nonce)) return false;
  if (r.promptKind === "onepassword.unlock" && r.target !== "1Password") return false;
  if (r.promptKind === "skill.secret" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.target)) return false;
  if (r.promptKind === "vault.save_login") {
    try { const u = new URL(r.target); if (!["https:", "http:"].includes(u.protocol) || u.origin !== r.target) return false; } catch { return false; }
  }
  try {
    fromBase64(r.publicKeySpkiB64, 1, 1024);
    const nonce = r.nonce.replace(/-/g, "+").replace(/_/g, "/") + "=";
    return fromBase64(nonce, 32, 32).length === 32;
  } catch { return false; }
}
export function deriveSecureInputStates(events: BotInvocationProgressEventPublic[], now = Date.now()): SecureInputState[] {
  const states: SecureInputState[] = [];
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type === "secure.input.request" && isSecureInputRequest(event.payload)) {
      const request = event.payload;
      if (states.some(s => s.event.invocationId === event.invocationId && s.request.requestId === request.requestId)) continue;
      states.push({ event, request, outcome: request.expiresAt <= now ? "expired" : null });
    } else if (event.type === "secure.input.resolved") {
      const p = event.payload;
      if (!p || p.version !== 3 || Object.keys(p).length !== 4 || !["submitted", "cancelled", "expired", "failed"].includes(String(p.outcome))) continue;
      const state = states.find(s => s.event.invocationId === event.invocationId && s.event.botId === event.botId && s.event.conversationId === event.conversationId && s.event.threadId === event.threadId && s.request.requestId === p.requestId && s.request.sessionKey === p.sessionKey);
      if (state) state.outcome = p.outcome as SecureInputResolved["outcome"];
    }
  }
  return states;
}
type ContextEvent = Pick<BotInvocationProgressEventPublic, "botId" | "invocationId" | "conversationId" | "threadId">;
export function secureInputContext(event: ContextEvent, r: SecureInputRequest) {
  return JSON.stringify([3, event.botId, r.requesterUserId, r.profileId, r.sessionKey, event.invocationId, event.conversationId, event.threadId, r.requestId, r.promptKind, r.fields, r.target, r.nonce, r.expiresAt]);
}
function toBase64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)); }
function fromBase64(value: string, min: number, max: number) {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4) throw new Error();
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (bytes.length < min || bytes.length > max || toBase64(bytes) !== value) throw new Error();
  return bytes;
}
/** Validate exact keys and byte limits without normalizing any user value. */
export function secureInputValuesValid(request: SecureInputRequest, values: Record<string, string>) {
  if (Object.keys(values).length !== request.fields.length) return false;
  const encoder = new TextEncoder();
  return request.fields.every(field => typeof values[field] === "string" && encoder.encode(values[field]).length >= 1 && encoder.encode(values[field]).length <= (field === "identifier" ? 1024 : 4096)) && encoder.encode(JSON.stringify(values)).length <= 16384;
}
export async function encryptSecureInput(event: ContextEvent, request: SecureInputRequest, values: Record<string, string>, cryptoApi: Crypto = globalThis.crypto): Promise<Extract<SecureInputResponse, { action: "submit" }>> {
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  let aesBytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    if (!cryptoApi?.subtle || !isSecureInputRequest(request) || request.expiresAt <= Date.now() || maskedPromptExpiryTooFar(request.expiresAt, Date.now()) || !secureInputValuesValid(request, values)) throw new Error();
    // Take the plaintext copy synchronously, so callers can immediately clear their local fields.
    const plaintext = new Uint8Array(new TextEncoder().encode(JSON.stringify(Object.fromEntries(request.fields.map(field => [field, values[field]])))));
    bytes = plaintext;
    const publicKey = await cryptoApi.subtle.importKey("spki", fromBase64(request.publicKeySpkiB64, 1, 1024), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    if ((publicKey.algorithm as RsaHashedKeyAlgorithm).modulusLength !== 3072) throw new Error();
    aesBytes = cryptoApi.getRandomValues(new Uint8Array(32));
    const aesKey = await cryptoApi.subtle.importKey("raw", aesBytes, "AES-GCM", false, ["encrypt"]);
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const context = new TextEncoder().encode(secureInputContext(event, request));
    const ciphertext = await cryptoApi.subtle.encrypt({ name: "AES-GCM", iv, additionalData: context, tagLength: 128 }, aesKey, plaintext);
    const wrapped = await cryptoApi.subtle.encrypt({ name: "RSA-OAEP", label: context }, publicKey, aesBytes);
    return { version: 3, action: "submit", wrappedKeyB64: toBase64(new Uint8Array(wrapped)), ivB64: toBase64(iv), ciphertextB64: toBase64(new Uint8Array(ciphertext)) };
  } catch { throw new Error("Could not encrypt the secure input response."); }
  finally { bytes?.fill(0); aesBytes?.fill(0); }
}
