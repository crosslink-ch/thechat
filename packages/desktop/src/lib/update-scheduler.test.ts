import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdaterStore } from "../stores/updater";
import { startUpdateChecks } from "./update-scheduler";
import { checkForUpdates } from "./updater";
import type { Update } from "@tauri-apps/plugin-updater";

vi.mock("./updater", () => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(async () => {}),
  installAndRelaunch: vi.fn(async () => {}),
  disposeUpdate: vi.fn(async () => {}),
}));
vi.mock("@thechat/client/log", () => ({ error: vi.fn(), formatError: String }));

const HOUR = 60 * 60 * 1000;
const THROTTLE = 5 * 60 * 1000;
const realCheckForUpdates = useUpdaterStore.getState().checkForUpdates;
let cleanup: (() => void) | undefined;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  await useUpdaterStore.getState().reset();
  vi.clearAllMocks();
  vi.mocked(checkForUpdates).mockReset().mockResolvedValue(null);
  useUpdaterStore.setState({ checkForUpdates: vi.fn(realCheckForUpdates) });
});

afterEach(async () => {
  cleanup?.();
  cleanup = undefined;
  await useUpdaterStore.getState().reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useUpdaterStore.setState({ checkForUpdates: realCheckForUpdates });
});

describe("startUpdateChecks", () => {
  it("allows one early online retry after an initial offline failure without an event retry storm", async () => {
    vi.mocked(checkForUpdates).mockRejectedValue(new Error("Offline"));
    cleanup = startUpdateChecks();
    await vi.advanceTimersByTimeAsync(0);
    expect(useUpdaterStore.getState().error).toBe("Failed to check for updates");
    window.dispatchEvent(new Event("focus"));
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(checkForUpdates).toHaveBeenCalledTimes(2);

    vi.mocked(checkForUpdates).mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(THROTTLE);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(checkForUpdates).toHaveBeenCalledTimes(3);
    expect(useUpdaterStore.getState().error).toBeNull();
  });

  it("contains an unexpected rejected check and keeps scheduled discovery alive", async () => {
    vi.mocked(useUpdaterStore.getState().checkForUpdates).mockRejectedValueOnce(new Error("Unexpected failure"));
    cleanup = startUpdateChecks();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(useUpdaterStore.getState().checkForUpdates).toHaveBeenCalledTimes(2);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it.each(["focus", "online"])("checks on %s with a shared five-minute throttle and removes listeners", async (event) => {
    const removeListener = vi.spyOn(window, "removeEventListener");
    cleanup = startUpdateChecks();
    await vi.advanceTimersByTimeAsync(THROTTLE - 1);
    window.dispatchEvent(new Event(event));
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    window.dispatchEvent(new Event(event));
    await vi.advanceTimersByTimeAsync(0);
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    expect(checkForUpdates).toHaveBeenCalledTimes(2);

    cleanup();
    expect(removeListener).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("online", expect.any(Function));
    await vi.advanceTimersByTimeAsync(HOUR);
    window.dispatchEvent(new Event(event));
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    removeListener.mockRestore();
  });

  it.each(["update", "checking", "downloading", "installing"] as const)("skips discovery when %s is already present", async (field) => {
    const value = field === "update" ? { version: "2.0.0" } as Update : true;
    useUpdaterStore.setState({ [field]: value });
    cleanup = startUpdateChecks();
    await vi.advanceTimersByTimeAsync(HOUR);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    expect(useUpdaterStore.getState().checkForUpdates).not.toHaveBeenCalled();
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it("does not recheck an update found after startup", async () => {
    cleanup = startUpdateChecks();
    await vi.advanceTimersByTimeAsync(0);
    useUpdaterStore.setState({ update: { version: "2.0.0" } as Update, error: "Failed to download update" });
    await vi.advanceTimersByTimeAsync(HOUR);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    expect(useUpdaterStore.getState().checkForUpdates).toHaveBeenCalledTimes(1);
    expect(useUpdaterStore.getState().error).toBe("Failed to download update");
  });

  it("checks immediately and hourly, then stops on cleanup", async () => {
    cleanup = startUpdateChecks();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    cleanup();
    await vi.advanceTimersByTimeAsync(HOUR * 2);
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
