import type { PushNotificationPayload } from "@thechat/shared";

/**
 * TheChat's service worker. It only shows push notifications and opens the
 * right conversation when one is tapped. It has no fetch handler and caches
 * nothing, so private chat data never lands in a worker cache.
 *
 * Compiled to a classic script (see pwa/vite-plugin.ts). The web package
 * type-checks against the DOM library, so the worker globals it uses are
 * declared below instead of pulling in the conflicting WebWorker library.
 */

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}
interface PushEventLike extends ExtendableEventLike {
  data: { json(): unknown } | null;
}
interface NotificationEventLike extends ExtendableEventLike {
  notification: Pick<Notification, "close" | "data">;
}
export interface WindowClientLike {
  url: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}
export interface ServiceWorkerScopeLike {
  location: { origin: string };
  registration: Pick<ServiceWorkerRegistration, "scope" | "showNotification" | "getNotifications">;
  clients: {
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
    claim(): Promise<void>;
  };
  navigator?: { setAppBadge?(count?: number): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "push", listener: (event: PushEventLike) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationEventLike) => void): void;
}

/** Message the worker posts to an open window to switch conversation. */
export const OPEN_CONVERSATION_MESSAGE = "thechat:open";

const ICON = "/icons/icon-192.png";
const BADGE = "/icons/badge-96.png";

/** Only in-app hash routes, never another origin or a javascript: URL. */
export function appHash(url: unknown): string {
  return typeof url === "string" && url.startsWith("#/") && url.length <= 2048 ? url : "#/";
}

export function parsePushPayload(raw: unknown): PushNotificationPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (
    value.v !== 1 ||
    typeof value.id !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    typeof value.tag !== "string" ||
    !value.tag ||
    typeof value.timestamp !== "number"
  ) {
    return null;
  }
  return {
    v: 1,
    id: value.id,
    kind: value.kind as PushNotificationPayload["kind"],
    title: value.title,
    body: value.body,
    tag: value.tag,
    url: appHash(value.url),
    timestamp: value.timestamp,
    ...(typeof value.badge === "number" ? { badge: value.badge } : {}),
  };
}

function readPayload(data: PushEventLike["data"]): PushNotificationPayload {
  try {
    const parsed = parsePushPayload(data?.json());
    if (parsed) return parsed;
  } catch {
    // Malformed payload: a notification must still be shown (Safari revokes
    // push permission for silent pushes).
  }
  return {
    v: 1,
    id: "fallback",
    kind: "test",
    title: "TheChat",
    body: "You have a new notification",
    tag: "thechat",
    url: "#/activity",
    timestamp: Date.now(),
  };
}

export async function showPushNotification(
  scope: ServiceWorkerScopeLike,
  data: PushEventLike["data"],
) {
  const payload = readPayload(data);
  const showing = await scope.registration
    .getNotifications({ tag: payload.tag })
    .catch(() => [] as Notification[]);
  // A redelivered push replaces itself silently; a newer message buzzes again.
  const duplicate = showing.some(
    (notification) => (notification.data as { id?: unknown } | null)?.id === payload.id,
  );
  await scope.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    icon: ICON,
    badge: BADGE,
    timestamp: payload.timestamp,
    renotify: !duplicate,
    data: { id: payload.id, url: payload.url },
  } as NotificationOptions);
  if (typeof payload.badge === "number") {
    await scope.navigator?.setAppBadge?.(payload.badge).catch(() => undefined);
  }
}

export async function openFromNotification(scope: ServiceWorkerScopeLike, url: unknown) {
  const hash = appHash(url);
  const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = windows.find((candidate) => {
    try {
      return new URL(candidate.url).origin === scope.location.origin;
    } catch {
      return false;
    }
  });
  if (client) {
    await client.focus().catch(() => undefined);
    client.postMessage({ type: OPEN_CONVERSATION_MESSAGE, hash });
    return;
  }
  await scope.clients.openWindow(new URL(hash, scope.registration.scope).href);
}

export function installServiceWorker(scope: ServiceWorkerScopeLike) {
  scope.addEventListener("install", () => {
    void scope.skipWaiting();
  });
  scope.addEventListener("activate", (event) => {
    event.waitUntil(scope.clients.claim());
  });
  scope.addEventListener("push", (event) => {
    event.waitUntil(showPushNotification(scope, event.data));
  });
  scope.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data as { url?: unknown } | null;
    event.waitUntil(openFromNotification(scope, data?.url));
  });
}

if (typeof self !== "undefined" && "registration" in self && "clients" in self) {
  installServiceWorker(self as unknown as ServiceWorkerScopeLike);
}
