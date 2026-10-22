/**
 * Push subscriptions come from the browser, so the endpoint is untrusted input
 * that the worker later POSTs to. Only the browsers' own push services are
 * accepted: this keeps the worker from being used to reach internal hosts.
 */
const EXACT_HOSTS = new Set([
  "fcm.googleapis.com", // Chrome, Edge on Android, Samsung Internet, Brave, Opera
  "android.googleapis.com", // Legacy Chrome (GCM) endpoints
  "updates.push.services.mozilla.com", // Firefox
  "web.push.apple.com", // Safari and Home Screen web apps on iOS/iPadOS
]);
const HOST_SUFFIXES = [
  ".push.services.mozilla.com",
  ".push.apple.com",
  ".notify.windows.com", // Edge on Windows (WNS)
];

export const MAX_PUSH_ENDPOINT_LENGTH = 2048;

export function isAllowedPushEndpoint(value: string): boolean {
  if (value.length > MAX_PUSH_ENDPOINT_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Host only, for logs. The full endpoint is a delivery capability. */
export function pushServiceHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "invalid";
  }
}

/** P-256 public key: 65-byte uncompressed point, base64url. */
export function isValidP256dhKey(value: string): boolean {
  const bytes = decodeBase64Url(value);
  return bytes?.length === 65 && bytes[0] === 0x04;
}

/** 16-byte authentication secret, base64url. */
export function isValidAuthSecret(value: string): boolean {
  return decodeBase64Url(value)?.length === 16;
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
}
