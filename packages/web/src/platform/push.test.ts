import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  config: vi.fn(),
  subscribe: vi.fn(),
  status: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
}));

vi.mock("@thechat/client/lib/api", () => ({
  api: {
    push: {
      config: { get: api.config },
      subscriptions: Object.assign(
        { post: api.subscribe, delete: api.remove },
        { status: { post: api.status } },
      ),
      test: { post: api.test },
    },
  },
}));

import {
  base64UrlToBytes,
  bytesToBase64Url,
  disablePush,
  enablePush,
  getPushStatus,
  pushDeliveryActive,
  pushSupport,
  resetPushStateForTests,
  sendTestPush,
  syncPushState,
} from "./push";

const PUBLIC_KEY = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
const OTHER_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

class FakeSubscription {
  options: { applicationServerKey: ArrayBuffer };
  unsubscribed = false;
  constructor(
    public endpoint: string,
    key: string,
  ) {
    this.options = { applicationServerKey: base64UrlToBytes(key).buffer as ArrayBuffer };
  }
  toJSON() {
    return { endpoint: this.endpoint, keys: { p256dh: "p256dh-key", auth: "auth-secret" } };
  }
  unsubscribe = vi.fn(async () => {
    this.unsubscribed = true;
    manager.current = null;
    return true;
  });
}

const manager = {
  current: null as FakeSubscription | null,
  getSubscription: vi.fn(async () => manager.current),
  subscribe: vi.fn(async (options: { applicationServerKey: Uint8Array }) => {
    manager.current = new FakeSubscription(
      "https://fcm.googleapis.com/fcm/send/new",
      bytesToBase64Url(options.applicationServerKey.buffer as ArrayBuffer)!,
    );
    return manager.current;
  }),
};

function setPermission(permission: NotificationPermission) {
  vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission }));
}

beforeEach(() => {
  resetPushStateForTests();
  vi.clearAllMocks();
  localStorage.clear();
  manager.current = null;
  setPermission("default");
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  vi.stubGlobal("PushManager", function PushManager() {});
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn(async () => ({})),
      ready: Promise.resolve({ pushManager: manager, scope: "https://thechat.example/" }),
    },
  });
  api.config.mockResolvedValue({ data: { enabled: true, publicKey: PUBLIC_KEY }, error: null });
  api.subscribe.mockResolvedValue({ data: { registered: true, id: "s1" }, error: null });
  api.status.mockResolvedValue({ data: { registered: true, current: true }, error: null });
  api.remove.mockResolvedValue({ data: { removed: true }, error: null });
  api.test.mockResolvedValue({ data: { result: "accepted" }, error: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("push manager", () => {
  it("round-trips VAPID keys between base64url and bytes", () => {
    const bytes = base64UrlToBytes(PUBLIC_KEY);
    expect(bytes).toHaveLength(65);
    expect(bytesToBase64Url(bytes.buffer)).toBe(PUBLIC_KEY);
  });

  it("asks iPhone Safari users to add TheChat to the Home Screen first", () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1",
    );
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(pushSupport()).toBe("install-required");
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    expect(pushSupport()).toBe("supported");
    userAgent.mockRestore();
  });

  it("is off until the user turns it on, and never asks for permission by itself", async () => {
    await syncPushState("alice");
    expect(getPushStatus()).toEqual({ state: "off" });
    expect(manager.subscribe).not.toHaveBeenCalled();
  });

  it("reports when the server has no keys configured", async () => {
    api.config.mockResolvedValue({ data: { enabled: false, publicKey: null }, error: null });
    await syncPushState("alice");
    expect(getPushStatus()).toEqual({ state: "unavailable" });
  });

  it("subscribes with the server key on a tap and registers the device", async () => {
    await syncPushState("alice");
    setPermission("granted");
    expect(await enablePush()).toBe(true);
    expect(manager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(PUBLIC_KEY),
    });
    expect(api.subscribe).toHaveBeenCalledWith(
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/new",
        keys: { p256dh: "p256dh-key", auth: "auth-secret" },
        applicationServerKey: PUBLIC_KEY,
      },
      expect.anything(),
    );
    expect(getPushStatus()).toEqual({ state: "on" });
    expect(pushDeliveryActive()).toBe(true);
  });

  it("a sync that overlaps turning on never drops the new subscription", async () => {
    await syncPushState("alice");
    setPermission("granted");
    let finishSubscribe!: () => void;
    manager.subscribe.mockImplementationOnce(
      (options: { applicationServerKey: Uint8Array }) =>
        new Promise<FakeSubscription>((resolve) => {
          finishSubscribe = () => {
            manager.current = new FakeSubscription(
              "https://fcm.googleapis.com/fcm/send/new",
              bytesToBase64Url(options.applicationServerKey.buffer as ArrayBuffer)!,
            );
            resolve(manager.current);
          };
        }),
    );
    // Not registered on the server yet, and no owner written yet.
    api.status.mockResolvedValue({ data: { registered: false, current: false }, error: null });
    const enabling = enablePush();
    const overlapping = syncPushState("alice");
    finishSubscribe();
    expect(await enabling).toBe(true);
    await overlapping;
    await syncPushState("alice"); // e.g. the tab regains focus right after
    expect(manager.current?.unsubscribed).toBe(false);
    expect(getPushStatus()).toEqual({ state: "on" });
  });

  it("reports a denied permission as blocked", async () => {
    await syncPushState("alice");
    manager.subscribe.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    setPermission("denied");
    expect(await enablePush()).toBe(false);
    expect(getPushStatus()).toEqual({ state: "blocked" });
  });

  it("drops the browser subscription if the server refuses it", async () => {
    await syncPushState("alice");
    setPermission("granted");
    api.subscribe.mockResolvedValueOnce({ data: null, error: { status: 400 } });
    expect(await enablePush()).toBe(false);
    expect(manager.current).toBeNull();
    expect(getPushStatus().state).toBe("error");
  });

  it("re-binds this browser after signing in again", async () => {
    manager.current = new FakeSubscription("https://fcm.googleapis.com/fcm/send/old", PUBLIC_KEY);
    setPermission("granted");
    localStorage.setItem("thechat:push-owner", "alice");
    api.status.mockResolvedValue({ data: { registered: false, current: false }, error: null });
    await syncPushState("alice");
    expect(api.subscribe).toHaveBeenCalledOnce();
    expect(getPushStatus()).toEqual({ state: "on" });
  });

  it("does not re-register an already registered device when the tab regains focus", async () => {
    manager.current = new FakeSubscription("https://fcm.googleapis.com/fcm/send/old", PUBLIC_KEY);
    setPermission("granted");
    localStorage.setItem("thechat:push-owner", "alice");
    await syncPushState("alice");
    await syncPushState("alice");
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(api.subscribe).not.toHaveBeenCalled();
    expect(getPushStatus()).toEqual({ state: "on" });
  });

  it("turns off when notification permission was revoked in system settings", async () => {
    manager.current = new FakeSubscription("https://fcm.googleapis.com/fcm/send/old", PUBLIC_KEY);
    localStorage.setItem("thechat:push-owner", "alice");
    setPermission("denied");
    const previous = manager.current;
    await syncPushState("alice");
    expect(previous.unsubscribed).toBe(true);
    expect(getPushStatus()).toEqual({ state: "blocked" });
  });

  it("never hands another account's subscription to the next person", async () => {
    manager.current = new FakeSubscription("https://fcm.googleapis.com/fcm/send/old", PUBLIC_KEY);
    setPermission("granted");
    localStorage.setItem("thechat:push-owner", "alice");
    api.status.mockResolvedValue({ data: { registered: false, current: false }, error: null });
    const previous = manager.current;
    await syncPushState("bob");
    expect(previous.unsubscribed).toBe(true);
    expect(api.subscribe).not.toHaveBeenCalled();
    expect(getPushStatus()).toEqual({ state: "off" });
  });

  it("replaces a subscription made with an old server key", async () => {
    manager.current = new FakeSubscription("https://fcm.googleapis.com/fcm/send/old", OTHER_KEY);
    setPermission("granted");
    localStorage.setItem("thechat:push-owner", "alice");
    const previous = manager.current;
    await syncPushState("alice");
    expect(previous.unsubscribed).toBe(true);
    expect(getPushStatus()).toEqual({ state: "off" });
  });

  it("turning off removes the device from the server and the browser", async () => {
    manager.current = new FakeSubscription("https://fcm.googleapis.com/fcm/send/old", PUBLIC_KEY);
    setPermission("granted");
    localStorage.setItem("thechat:push-owner", "alice");
    await syncPushState("alice");
    const previous = manager.current;
    await disablePush();
    expect(api.remove).toHaveBeenCalledWith({ endpoint: previous.endpoint }, expect.anything());
    expect(previous.unsubscribed).toBe(true);
    expect(getPushStatus()).toEqual({ state: "off" });
  });

  it("a test that finds the device gone turns it off", async () => {
    manager.current = new FakeSubscription("https://fcm.googleapis.com/fcm/send/old", PUBLIC_KEY);
    setPermission("granted");
    localStorage.setItem("thechat:push-owner", "alice");
    await syncPushState("alice");
    expect(await sendTestPush()).toBe("sent");
    api.test.mockResolvedValueOnce({ data: { result: "gone" }, error: null });
    expect(await sendTestPush()).toBe("invalid");
    expect(getPushStatus()).toEqual({ state: "off" });
  });
});
