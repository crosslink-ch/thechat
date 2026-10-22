import { describe, expect, it, vi } from "vitest";
import {
  OPEN_CONVERSATION_MESSAGE,
  appHash,
  installServiceWorker,
  openFromNotification,
  parsePushPayload,
  showPushNotification,
  type ServiceWorkerScopeLike,
  type WindowClientLike,
} from "./service-worker";

function scope(options: { windows?: WindowClientLike[]; showing?: { data: unknown }[] } = {}) {
  const listeners = new Map<string, (event: any) => void>();
  const value = {
    location: { origin: "https://thechat.example" },
    registration: {
      scope: "https://thechat.example/",
      showNotification: vi.fn(async () => undefined),
      getNotifications: vi.fn(async () => options.showing ?? []),
    },
    clients: {
      matchAll: vi.fn(async () => options.windows ?? []),
      openWindow: vi.fn(async () => null),
      claim: vi.fn(async () => undefined),
    },
    navigator: { setAppBadge: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(async () => undefined),
    addEventListener: vi.fn((type: string, listener: (event: any) => void) => {
      listeners.set(type, listener);
    }),
  };
  return { value: value as unknown as ServiceWorkerScopeLike & typeof value, listeners };
}

const payload = {
  v: 1,
  id: "message:1",
  kind: "direct_message",
  title: "Ana",
  body: "Lunch?",
  tag: "conversation:c1:main",
  url: "#/open?conversationId=c1&type=direct",
  timestamp: 1_700_000_000_000,
  badge: 3,
};

describe("service worker", () => {
  it("only follows in-app hash routes", () => {
    expect(appHash("#/open?conversationId=c1")).toBe("#/open?conversationId=c1");
    for (const bad of ["https://evil.example", "javascript:alert(1)", "//evil.example", "#x", 42, null]) {
      expect(appHash(bad)).toBe("#/");
    }
    expect(parsePushPayload({ ...payload, url: "https://evil.example" })?.url).toBe("#/");
    expect(parsePushPayload({ ...payload, v: 2 })).toBeNull();
    expect(parsePushPayload({ ...payload, tag: "" })).toBeNull();
  });

  it("always shows a notification, even for an unreadable push", async () => {
    const { value } = scope();
    await showPushNotification(value, { json: () => payload });
    expect(value.registration.showNotification).toHaveBeenCalledWith("Ana", expect.objectContaining({
      body: "Lunch?",
      tag: "conversation:c1:main",
      renotify: true,
      data: { id: "message:1", url: payload.url },
    }));
    expect(value.navigator.setAppBadge).toHaveBeenCalledWith(3);

    await showPushNotification(value, { json: () => { throw new SyntaxError("bad"); } });
    await showPushNotification(value, null);
    expect(value.registration.showNotification).toHaveBeenCalledTimes(3);
    expect(value.registration.showNotification).toHaveBeenLastCalledWith(
      "TheChat",
      expect.objectContaining({ body: "You have a new notification" }),
    );
  });

  it("a redelivered push replaces itself without buzzing again", async () => {
    const { value } = scope({ showing: [{ data: { id: "message:1" } }] });
    await showPushNotification(value, { json: () => payload });
    expect(value.registration.showNotification).toHaveBeenCalledWith(
      "Ana",
      expect.objectContaining({ renotify: false }),
    );
  });

  it("a tap focuses an open TheChat window and switches conversation", async () => {
    const focus = vi.fn(async () => undefined);
    const postMessage = vi.fn();
    const other = { url: "https://elsewhere.example/", focus: vi.fn(), postMessage: vi.fn() };
    const mine = { url: "https://thechat.example/#/channel/x", focus, postMessage };
    const { value } = scope({ windows: [other, mine] });
    await openFromNotification(value, "#/open?conversationId=c1&type=direct");
    expect(focus).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({
      type: OPEN_CONVERSATION_MESSAGE,
      hash: "#/open?conversationId=c1&type=direct",
    });
    expect(other.postMessage).not.toHaveBeenCalled();
    expect(value.clients.openWindow).not.toHaveBeenCalled();
  });

  it("a tap opens TheChat at the conversation when nothing is open", async () => {
    const { value } = scope();
    await openFromNotification(value, "#/open?conversationId=c1&type=group");
    expect(value.clients.openWindow).toHaveBeenCalledWith(
      "https://thechat.example/#/open?conversationId=c1&type=group",
    );
  });

  it("wires push and click events through waitUntil", async () => {
    const { value, listeners } = scope();
    installServiceWorker(value);
    const waits: Promise<unknown>[] = [];
    listeners.get("push")!({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    const close = vi.fn();
    listeners.get("notificationclick")!({
      notification: { close, data: { url: payload.url } },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
    expect(close).toHaveBeenCalledOnce();
    expect(value.registration.showNotification).toHaveBeenCalledOnce();
    expect(value.clients.openWindow).toHaveBeenCalledOnce();
  });
});
