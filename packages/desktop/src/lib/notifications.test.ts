import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDesktopNotificationsEnabled } from "./notification-preferences";
import { fireNotification } from "./notifications";
import { useAuthStore } from "../stores/auth";

const { isPermissionGrantedMock, requestPermissionMock, sendNotificationMock } =
  vi.hoisted(() => ({
    isPermissionGrantedMock: vi.fn(),
    requestPermissionMock: vi.fn(),
    sendNotificationMock: vi.fn(),
  }));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: isPermissionGrantedMock,
  requestPermission: requestPermissionMock,
  sendNotification: sendNotificationMock,
}));

const notificationGlobals = globalThis as typeof globalThis & {
  __thechatNotificationDeduper?: Map<string, number>;
  __thechatNotificationLastAttemptAt?: number;
  __thechatNotificationLastSentAt?: number;
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  delete notificationGlobals.__thechatNotificationDeduper;
  delete notificationGlobals.__thechatNotificationLastAttemptAt;
  delete notificationGlobals.__thechatNotificationLastSentAt;
  isPermissionGrantedMock.mockResolvedValue(true);
  requestPermissionMock.mockResolvedValue("granted");
  useAuthStore.setState({
    token: "token-1",
    loading: false,
    user: {
      id: "user-1",
      email: "person@example.com",
      name: "Person",
      type: "human",
      avatar: null,
    },
  });
});

describe("desktop notifications", () => {
  it("does not contact the OS notification plugin when the current user disabled alerts", async () => {
    setDesktopNotificationsEnabled("user-1", false);

    await fireNotification("New message", "Hello", {
      dedupeKey: "message:1",
    });

    expect(isPermissionGrantedMock).not.toHaveBeenCalled();
    expect(requestPermissionMock).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("keeps a disabled preference effective for the session when device storage fails", async () => {
    useAuthStore.setState((state) => ({
      user: state.user
        ? { ...state.user, id: "storage-failure-user" }
        : null,
    }));
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("Storage unavailable");
      });

    try {
      setDesktopNotificationsEnabled("storage-failure-user", false);
    } finally {
      setItemSpy.mockRestore();
    }

    await fireNotification("New message", "Hello", {
      dedupeKey: "message:storage-failure",
    });

    expect(isPermissionGrantedMock).not.toHaveBeenCalled();
    expect(requestPermissionMock).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("allows at most one notification in each five-second window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T10:00:00.000Z"));

    try {
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          fireNotification(`Message ${index}`, `Body ${index}`, {
            dedupeKey: `message:${index}`,
          }),
        ),
      );

      expect(sendNotificationMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(4_999);
      await fireNotification("Still too soon", "Body", {
        dedupeKey: "message:too-soon",
      });
      expect(sendNotificationMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      await fireNotification("Next window", "Body", {
        dedupeKey: "message:next-window",
      });
      expect(sendNotificationMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps asynchronous permission checks from releasing a notification burst", async () => {
    let now = 0;
    let resolvePermission!: (permitted: boolean) => void;
    const permission = new Promise<boolean>((resolve) => {
      resolvePermission = resolve;
    });
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    isPermissionGrantedMock.mockReturnValue(permission);

    try {
      const first = fireNotification("First", "Body", {
        dedupeKey: "message:first",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(isPermissionGrantedMock).toHaveBeenCalledTimes(1);

      now = 5_000;
      const second = fireNotification("Second", "Body", {
        dedupeKey: "message:second",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(isPermissionGrantedMock).toHaveBeenCalledTimes(2);

      resolvePermission(true);
      await Promise.all([first, second]);

      expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
