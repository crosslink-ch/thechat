import webpush from "web-push";

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
  /**
   * Wait this long before notifying, so a message read on another device in
   * the meantime (or followed by a newer one) does not buzz the phone.
   */
  delayMs: number;
  ttlSeconds: number;
}

const DEFAULT_DELAY_MS = 3_000;
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

let override: WebPushConfig | null | undefined;
let cached: { env: string; config: WebPushConfig | null } | undefined;

/**
 * Background push is optional: without a VAPID key pair the API reports it as
 * unavailable and the worker sends nothing. Invalid configuration fails fast.
 */
export function loadWebPushConfig(
  env: NodeJS.ProcessEnv = process.env,
): WebPushConfig | null {
  const publicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = env.WEB_PUSH_SUBJECT?.trim() ?? "";
  if (!publicKey && !privateKey) return null;
  if (!publicKey || !privateKey || !subject) {
    throw new Error(
      "Web Push needs WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_SUBJECT",
    );
  }
  // Throws on malformed keys or a subject that is not mailto:/https:.
  webpush.getVapidHeaders("https://fcm.googleapis.com", subject, publicKey, privateKey, "aes128gcm");
  return {
    publicKey,
    privateKey,
    subject,
    delayMs: nonNegativeInteger(env.WEB_PUSH_DELAY_MS, DEFAULT_DELAY_MS),
    ttlSeconds: positiveInteger(env.WEB_PUSH_TTL_SECONDS, DEFAULT_TTL_SECONDS),
  };
}

export function webPushConfig(): WebPushConfig | null {
  if (override !== undefined) return override;
  const key = [
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY,
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY,
    process.env.WEB_PUSH_SUBJECT,
    process.env.WEB_PUSH_DELAY_MS,
    process.env.WEB_PUSH_TTL_SECONDS,
  ].join("\u0000");
  if (cached?.env !== key) cached = { env: key, config: loadWebPushConfig() };
  return cached.config;
}

export function setWebPushConfigForTests(config: WebPushConfig | null | undefined) {
  override = config;
}

function nonNegativeInteger(value: string | undefined, fallback: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = nonNegativeInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}
