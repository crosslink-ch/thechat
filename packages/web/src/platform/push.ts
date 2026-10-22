import { useSyncExternalStore } from "react";
import { api } from "@thechat/client/lib/api";
import { authHeaders } from "@thechat/client/lib/eden";

/**
 * Background (Web Push) notifications for this browser.
 *
 * A device is "on" only when the browser holds a push subscription and the
 * server has it registered for the current signed-in session. Notification
 * permission alone is not enough.
 */
export type PushStatus =
  | { state: "checking" }
  | { state: "unsupported" }
  /** iPhone/iPad Safari: push needs the Home Screen app. */
  | { state: "install-required" }
  /** The server has no VAPID keys configured. */
  | { state: "unavailable" }
  | { state: "blocked" }
  | { state: "off" }
  | { state: "working" }
  | { state: "on" }
  | { state: "error"; message: string };

export const SERVICE_WORKER_URL = "/sw.js";
const OWNER_KEY = "thechat:push-owner";

let status: PushStatus = { state: "checking" };
let currentUserId: string | null = null;
let prepared: { registration: ServiceWorkerRegistration; publicKey: string } | null = null;
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
let syncGeneration = 0;
/** True while enablePush runs; a concurrent sync could otherwise drop its new subscription. */
let enabling = false;
const listeners = new Set<() => void>();

function setStatus(next: PushStatus) {
  status = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePushStatus(): PushStatus {
  return useSyncExternalStore(subscribe, () => status, () => status);
}

export function getPushStatus() {
  return status;
}

/** While true, background push owns message notifications on this device. */
export function pushDeliveryActive() {
  return status.state === "on";
}

// -- Environment -----------------------------------------------------------

export function isIosDevice(nav: Navigator = navigator) {
  return (
    /iP(hone|ad|od)/.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1)
  );
}

export function isStandaloneApp() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function pushSupport(): "supported" | "unsupported" | "install-required" {
  if (typeof window === "undefined" || !window.isSecureContext) return "unsupported";
  const capable =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isIosDevice() && !isStandaloneApp()) return "install-required";
  return capable ? "supported" : "unsupported";
}

/** Registered on every web start so page notifications work on phones too. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !window.isSecureContext) {
    return Promise.resolve(null);
  }
  registrationPromise ??= navigator.serviceWorker
    .register(SERVICE_WORKER_URL, { scope: "/" })
    .then(() => navigator.serviceWorker.ready)
    .catch(() => {
      registrationPromise = null;
      return null;
    });
  return registrationPromise;
}

// -- Encoding ---------------------------------------------------------------

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64Url(buffer: ArrayBuffer | null | undefined): string | null {
  if (!buffer) return null;
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function subscriptionKey(subscription: PushSubscription) {
  return bytesToBase64Url(subscription.options?.applicationServerKey);
}

function readOwner() {
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}

function writeOwner(userId: string | null) {
  try {
    if (userId) localStorage.setItem(OWNER_KEY, userId);
    else localStorage.removeItem(OWNER_KEY);
  } catch {
    // Storage denied: ownership falls back to the server status check.
  }
}

// -- Server calls -----------------------------------------------------------

async function fetchPublicKey(): Promise<string | null> {
  const { data, error } = await api.push.config.get(authHeaders(null));
  if (error || !data || !("enabled" in data)) throw new Error("Could not load notification settings");
  return data.enabled ? data.publicKey : null;
}

async function registerWithServer(subscription: PushSubscription, publicKey: string) {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("The browser returned an incomplete subscription");
  }
  const { error } = await api.push.subscriptions.post(
    {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      applicationServerKey: subscriptionKey(subscription) ?? publicKey,
    },
    authHeaders(null),
  );
  if (error) throw new Error("The server did not accept this device");
}

async function serverStatus(endpoint: string) {
  const { data, error } = await api.push.subscriptions.status.post({ endpoint }, authHeaders(null));
  if (error || !data || !("registered" in data)) throw new Error("Could not check notification status");
  return data;
}

// -- Lifecycle ----------------------------------------------------------------

/**
 * Reconcile this browser with the signed-in account. Called when the account
 * changes and when the page becomes visible again.
 */
export async function syncPushState(userId: string | null) {
  // Turning on is in progress for this account: it sets the final state.
  if (enabling && userId === currentUserId) return;
  const generation = ++syncGeneration;
  const current = () => generation === syncGeneration;
  currentUserId = userId;
  prepared = null;
  if (!userId) {
    setStatus({ state: "checking" });
    return;
  }
  const support = pushSupport();
  if (support !== "supported") {
    setStatus({ state: support });
    return;
  }
  try {
    const [registration, publicKey] = await Promise.all([registerServiceWorker(), fetchPublicKey()]);
    if (!current()) return;
    if (!registration) return setStatus({ state: "unsupported" });
    if (!publicKey) return setStatus({ state: "unavailable" });
    prepared = { registration, publicKey };

    let subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const key = subscriptionKey(subscription);
      let keep = (key === null || key === publicKey) && Notification.permission === "granted";
      let registered = false;
      if (keep) {
        const status = await serverStatus(subscription.endpoint);
        registered = status.registered && status.current;
        // Another account (or cleared storage) owned it: keep it only if the
        // server already has it for this session.
        if (!registered && readOwner() !== userId) keep = false;
      }
      if (!current()) return;
      if (keep) {
        // Same account signed in again: bind the device to the new session.
        if (!registered) await registerWithServer(subscription, publicKey);
        writeOwner(userId);
      } else {
        await subscription.unsubscribe().catch(() => false);
        writeOwner(null);
        subscription = null;
      }
    }
    if (!current()) return;
    if (subscription) setStatus({ state: "on" });
    else setStatus({ state: Notification.permission === "denied" ? "blocked" : "off" });
  } catch {
    if (current()) setStatus({ state: "error", message: "Couldn't check notifications on this device." });
  }
}

/** Call directly from the tap/click handler: Safari requires it. */
export async function enablePush(): Promise<boolean> {
  const ready = prepared;
  const userId = currentUserId;
  if (!ready || !userId || enabling) return false;
  enabling = true;
  // Any sync already in flight is now stale and must not touch the subscription.
  syncGeneration += 1;
  try {
    return await subscribeAndRegister(ready, userId);
  } finally {
    enabling = false;
  }
}

async function subscribeAndRegister(
  ready: { registration: ServiceWorkerRegistration; publicKey: string },
  userId: string,
): Promise<boolean> {
  setStatus({ state: "working" });
  let subscription: PushSubscription;
  try {
    // First await in the gesture handler. Subscribing also asks for permission.
    subscription = await ready.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(ready.publicKey),
    });
  } catch {
    const permission = typeof Notification === "undefined" ? "default" : Notification.permission;
    setStatus(
      permission === "denied"
        ? { state: "blocked" }
        : permission === "default"
          ? { state: "off" }
          : { state: "error", message: "Couldn't turn on notifications. Try again." },
    );
    return false;
  }
  try {
    await registerWithServer(subscription, ready.publicKey);
    if (currentUserId !== userId) return false;
    writeOwner(userId);
    setStatus({ state: "on" });
    return true;
  } catch {
    await subscription.unsubscribe().catch(() => false);
    setStatus({ state: "error", message: "Couldn't register this device. Try again." });
    return false;
  }
}

export async function disablePush(): Promise<void> {
  const registration = prepared?.registration ?? (await registerServiceWorker());
  setStatus({ state: "working" });
  try {
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await api.push.subscriptions.delete({ endpoint: subscription.endpoint }, authHeaders(null));
      await subscription.unsubscribe();
    }
    writeOwner(null);
    setStatus({ state: "off" });
  } catch {
    setStatus({ state: "error", message: "Couldn't turn off notifications. Try again." });
  }
}

export type TestPushResult = "sent" | "invalid" | "failed" | "rate-limited";

export async function sendTestPush(): Promise<TestPushResult> {
  const subscription = await prepared?.registration.pushManager.getSubscription();
  if (!subscription) return "invalid";
  const { data, error } = await api.push.test.post({ endpoint: subscription.endpoint }, authHeaders(null));
  if (error) return error.status === 429 ? "rate-limited" : error.status === 404 ? "invalid" : "failed";
  const result = data && "result" in data ? data.result : null;
  if (result === "accepted") return "sent";
  if (result === "gone" || result === "rejected") {
    await subscription.unsubscribe().catch(() => false);
    writeOwner(null);
    setStatus({ state: "off" });
    return "invalid";
  }
  return "failed";
}

export function resetPushStateForTests() {
  syncGeneration += 1;
  enabling = false;
  status = { state: "checking" };
  currentUserId = null;
  prepared = null;
  registrationPromise = null;
}
