import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Update, DownloadEvent } from "@tauri-apps/plugin-updater";
import { useUpdaterStore } from "./updater";

// Mock the updater lib functions
vi.mock("../lib/updater", () => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  installAndRelaunch: vi.fn(),
  disposeUpdate: vi.fn(),
}));

// Suppress log output in tests
vi.mock("@thechat/client/log", () => ({
  info: vi.fn(),
  error: vi.fn(),
  formatError: (e: unknown) => String(e),
}));

import {
  checkForUpdates as checkForUpdatesMock,
  downloadUpdate as downloadUpdateMock,
  installAndRelaunch as installAndRelaunchMock,
  disposeUpdate as disposeUpdateMock,
} from "../lib/updater";

function createMockUpdate(version = "2.0.0", currentVersion = "1.0.0"): Update {
  return {
    version,
    currentVersion,
    body: "Bug fixes",
    available: true,
    rawJson: {},
    close: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
    downloadAndInstall: vi.fn(),
  } as unknown as Update;
}

function resetStore() {
  useUpdaterStore.setState({
    update: null,
    checking: false,
    downloading: false,
    downloaded: false,
    installing: false,
    progress: null,
    error: null,
    statusMessage: null,
  });
}

beforeEach(() => {
  resetStore();
  vi.resetAllMocks();
  vi.mocked(disposeUpdateMock).mockResolvedValue(undefined);
  vi.mocked(downloadUpdateMock).mockResolvedValue(undefined);
});

describe("updater store", () => {
  describe("checkForUpdates", () => {
    it("sets statusMessage when no update is available", async () => {
      vi.mocked(checkForUpdatesMock).mockResolvedValue(null);

      await useUpdaterStore.getState().checkForUpdates();

      const state = useUpdaterStore.getState();
      expect(state.update).toBeNull();
      expect(state.statusMessage).toBe("You're on the latest version");
      expect(state.checking).toBe(false);
    });

    it("auto-downloads when update is available", async () => {
      const mockUpdate = createMockUpdate();
      vi.mocked(checkForUpdatesMock).mockResolvedValue(mockUpdate);
      vi.mocked(downloadUpdateMock).mockResolvedValue(undefined);

      await useUpdaterStore.getState().checkForUpdates();

      const state = useUpdaterStore.getState();
      expect(state.update).toBe(mockUpdate);
      expect(state.checking).toBe(false);
      expect(downloadUpdateMock).toHaveBeenCalledWith(mockUpdate, expect.any(Function));
    });

    it("sets downloaded to true after background download completes", async () => {
      const mockUpdate = createMockUpdate();
      vi.mocked(checkForUpdatesMock).mockResolvedValue(mockUpdate);
      vi.mocked(downloadUpdateMock).mockResolvedValue(undefined);

      await useUpdaterStore.getState().checkForUpdates();

      // Wait for the background download promise to settle
      await vi.waitFor(() => {
        expect(useUpdaterStore.getState().downloaded).toBe(true);
      });

      const state = useUpdaterStore.getState();
      expect(state.downloading).toBe(false);
      expect(state.downloaded).toBe(true);
    });

    it("sets error when background download fails", async () => {
      const mockUpdate = createMockUpdate();
      vi.mocked(checkForUpdatesMock).mockResolvedValue(mockUpdate);
      vi.mocked(downloadUpdateMock).mockRejectedValue(new Error("Network error"));

      await useUpdaterStore.getState().checkForUpdates();

      await vi.waitFor(() => {
        expect(useUpdaterStore.getState().error).toBe("Failed to download update");
      });

      const state = useUpdaterStore.getState();
      expect(state.downloading).toBe(false);
      expect(state.downloaded).toBe(false);
      expect(state.progress).toBeNull();
    });

    it("tracks download progress via callbacks", async () => {
      const mockUpdate = createMockUpdate();
      vi.mocked(checkForUpdatesMock).mockResolvedValue(mockUpdate);

      const progressValues: (number | null)[] = [];

      vi.mocked(downloadUpdateMock).mockImplementation(async (_update, onEvent) => {
        onEvent?.({ event: "Started", data: { contentLength: 1000 } });
        progressValues.push(useUpdaterStore.getState().progress);

        onEvent?.({ event: "Progress", data: { chunkLength: 500 } });
        progressValues.push(useUpdaterStore.getState().progress);

        onEvent?.({ event: "Progress", data: { chunkLength: 500 } });
        progressValues.push(useUpdaterStore.getState().progress);

        onEvent?.({ event: "Finished" } as DownloadEvent);
        progressValues.push(useUpdaterStore.getState().progress);
      });

      await useUpdaterStore.getState().checkForUpdates();

      await vi.waitFor(() => {
        expect(useUpdaterStore.getState().downloaded).toBe(true);
      });

      expect(progressValues).toEqual([0, 50, 100, 100]);
    });

    it("disposes previous update when checking again", async () => {
      const oldUpdate = createMockUpdate("1.5.0");
      const newUpdate = createMockUpdate("2.0.0");

      vi.mocked(checkForUpdatesMock).mockResolvedValueOnce(oldUpdate);
      vi.mocked(downloadUpdateMock).mockResolvedValue(undefined);

      await useUpdaterStore.getState().checkForUpdates();
      await vi.waitFor(() => {
        expect(useUpdaterStore.getState().downloaded).toBe(true);
      });

      vi.mocked(checkForUpdatesMock).mockResolvedValueOnce(newUpdate);
      await useUpdaterStore.getState().checkForUpdates();

      expect(disposeUpdateMock).toHaveBeenCalledWith(oldUpdate);
    });

    it.each(["downloading", "installing"] as const)("skips checks while %s without disposing the active handle", async (busy) => {
      const update = createMockUpdate();
      useUpdaterStore.setState({ update, [busy]: true });
      await useUpdaterStore.getState().checkForUpdates();
      expect(checkForUpdatesMock).not.toHaveBeenCalled();
      expect(disposeUpdateMock).not.toHaveBeenCalled();
      expect(useUpdaterStore.getState().update).toBe(update);
    });

    it.each(["no update", "failure"])("keeps a downloaded update after a recheck returns %s", async (outcome) => {
      const update = createMockUpdate();
      useUpdaterStore.setState({ update, downloaded: true, progress: 100 });
      if (outcome === "no update") vi.mocked(checkForUpdatesMock).mockResolvedValueOnce(null);
      else vi.mocked(checkForUpdatesMock).mockRejectedValueOnce(new Error("Offline"));

      await useUpdaterStore.getState().checkForUpdates();

      expect(useUpdaterStore.getState()).toMatchObject({ update, downloaded: true, progress: 100, checking: false, statusMessage: null });
      expect(disposeUpdateMock).not.toHaveBeenCalled();
      expect(downloadUpdateMock).not.toHaveBeenCalled();
    });

    it.each([true, false])("keeps the existing handle for the same version (same object: %s)", async (sameObject) => {
      const update = createMockUpdate();
      const candidate = sameObject ? update : createMockUpdate();
      useUpdaterStore.setState({ update, downloaded: true, progress: 100 });
      vi.mocked(checkForUpdatesMock).mockResolvedValueOnce(candidate);

      await useUpdaterStore.getState().checkForUpdates();

      expect(useUpdaterStore.getState()).toMatchObject({ update, downloaded: true, progress: 100 });
      expect(downloadUpdateMock).not.toHaveBeenCalled();
      expect(disposeUpdateMock).not.toHaveBeenCalledWith(update);
      if (!sameObject) expect(disposeUpdateMock).toHaveBeenCalledWith(candidate);
    });

    it("sets error when check fails", async () => {
      vi.mocked(checkForUpdatesMock).mockRejectedValue(new Error("Network error"));

      await useUpdaterStore.getState().checkForUpdates();

      const state = useUpdaterStore.getState();
      expect(state.error).toBe("Failed to check for updates");
      expect(state.checking).toBe(false);
    });

    it("prevents concurrent checks", async () => {
      vi.mocked(checkForUpdatesMock).mockResolvedValue(null);

      // Start two checks simultaneously
      const p1 = useUpdaterStore.getState().checkForUpdates();
      const p2 = useUpdaterStore.getState().checkForUpdates();
      await Promise.all([p1, p2]);

      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("retryDownload", () => {
    it("ignores late callbacks from a failed attempt during its retry", async () => {
      const update = createMockUpdate();
      let staleCallback!: (event: DownloadEvent) => void;
      vi.mocked(checkForUpdatesMock).mockResolvedValueOnce(update);
      vi.mocked(downloadUpdateMock).mockImplementationOnce(async (_, onEvent) => {
        staleCallback = onEvent!;
        throw new Error("Offline");
      });
      await useUpdaterStore.getState().checkForUpdates();
      await vi.waitFor(() => expect(useUpdaterStore.getState().error).toBe("Failed to download update"));
      let finishDownload!: () => void;
      vi.mocked(downloadUpdateMock).mockImplementationOnce(() => new Promise((resolve) => { finishDownload = resolve; }));
      const retry = useUpdaterStore.getState().retryDownload();
      staleCallback({ event: "Finished" });
      expect(useUpdaterStore.getState().progress).toBe(0);
      finishDownload();
      await retry;
    });

    it("retries the retained handle, clearing errors and ignoring duplicate retries", async () => {
      const update = createMockUpdate();
      vi.mocked(checkForUpdatesMock).mockResolvedValueOnce(update);
      vi.mocked(downloadUpdateMock).mockRejectedValueOnce(new Error("Offline"));
      await useUpdaterStore.getState().checkForUpdates();
      await vi.waitFor(() => expect(useUpdaterStore.getState().error).toBe("Failed to download update"));

      let finishDownload!: () => void;
      vi.mocked(downloadUpdateMock).mockImplementationOnce(() => new Promise((resolve) => {
        finishDownload = resolve;
      }));
      const retry = useUpdaterStore.getState().retryDownload();
      expect(useUpdaterStore.getState()).toMatchObject({ update, downloading: true, error: null, progress: 0 });
      await useUpdaterStore.getState().retryDownload();
      expect(downloadUpdateMock).toHaveBeenCalledTimes(2);
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
      finishDownload();
      await retry;
      expect(useUpdaterStore.getState()).toMatchObject({ downloading: false, downloaded: true });
      await useUpdaterStore.getState().retryDownload();
      expect(downloadUpdateMock).toHaveBeenCalledTimes(2);
    });

    it.each(["checking", "downloading", "installing"] as const)("does not retry while %s", async (busy) => {
      useUpdaterStore.setState({ update: createMockUpdate(), [busy]: true });
      await useUpdaterStore.getState().retryDownload();
      expect(downloadUpdateMock).not.toHaveBeenCalled();
    });

    it("does not retry without an update", async () => {
      await useUpdaterStore.getState().retryDownload();
      expect(downloadUpdateMock).not.toHaveBeenCalled();
    });
  });

  describe("restartToUpdate", () => {
    it.each(["checking", "downloading"] as const)("does not install while %s", async (busy) => {
      useUpdaterStore.setState({ update: createMockUpdate(), downloaded: true, [busy]: true });
      await useUpdaterStore.getState().restartToUpdate();
      expect(installAndRelaunchMock).not.toHaveBeenCalled();
    });

    it("keeps installation single-flight and lets failures retry without stale errors", async () => {
      const update = createMockUpdate();
      let failInstall!: (error: Error) => void;
      vi.mocked(installAndRelaunchMock).mockImplementationOnce(() => new Promise((_, reject) => {
        failInstall = reject;
      }));
      useUpdaterStore.setState({ update, downloaded: true, error: "previous error" });

      const firstInstall = useUpdaterStore.getState().restartToUpdate();
      expect(useUpdaterStore.getState().installing).toBe(true);
      expect(useUpdaterStore.getState().error).toBeNull();
      await useUpdaterStore.getState().restartToUpdate();
      expect(installAndRelaunchMock).toHaveBeenCalledTimes(1);

      failInstall(new Error("Install failed"));
      await firstInstall;
      expect(useUpdaterStore.getState()).toMatchObject({
        update, downloaded: true, installing: false, error: "Failed to install update",
      });

      let finishInstall!: () => void;
      vi.mocked(installAndRelaunchMock).mockImplementationOnce(() => new Promise((resolve) => {
        finishInstall = resolve;
      }));
      const retry = useUpdaterStore.getState().restartToUpdate();
      expect(useUpdaterStore.getState()).toMatchObject({ installing: true, error: null });
      finishInstall();
      await retry;
      expect(useUpdaterStore.getState().installing).toBe(false);
      expect(installAndRelaunchMock).toHaveBeenCalledTimes(2);
    });

    it("calls installAndRelaunch when update is downloaded", async () => {
      const mockUpdate = createMockUpdate();
      vi.mocked(installAndRelaunchMock).mockResolvedValue(undefined);

      useUpdaterStore.setState({ update: mockUpdate, downloaded: true });

      await useUpdaterStore.getState().restartToUpdate();

      expect(installAndRelaunchMock).toHaveBeenCalledWith(mockUpdate);
    });

    it("does nothing when update is not downloaded", async () => {
      const mockUpdate = createMockUpdate();
      useUpdaterStore.setState({ update: mockUpdate, downloaded: false });

      await useUpdaterStore.getState().restartToUpdate();

      expect(installAndRelaunchMock).not.toHaveBeenCalled();
    });

    it("does nothing when no update is available", async () => {
      useUpdaterStore.setState({ update: null, downloaded: true });

      await useUpdaterStore.getState().restartToUpdate();

      expect(installAndRelaunchMock).not.toHaveBeenCalled();
    });

    it("sets error when install fails", async () => {
      const mockUpdate = createMockUpdate();
      vi.mocked(installAndRelaunchMock).mockRejectedValue(new Error("Install failed"));

      useUpdaterStore.setState({ update: mockUpdate, downloaded: true });
      await useUpdaterStore.getState().restartToUpdate();

      expect(useUpdaterStore.getState().error).toBe("Failed to install update");
    });
  });

  describe("reset", () => {
    it.each(["update", "failure"])("ignores a stale check %s without clearing a newer check", async (outcome) => {
      const staleUpdate = createMockUpdate();
      let resolveOld!: (update: Update | null) => void;
      let rejectOld!: (error: Error) => void;
      let resolveNew!: (update: Update | null) => void;
      vi.mocked(checkForUpdatesMock)
        .mockImplementationOnce(() => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));

      const oldCheck = useUpdaterStore.getState().checkForUpdates();
      await useUpdaterStore.getState().reset();
      const newCheck = useUpdaterStore.getState().checkForUpdates();
      if (outcome === "update") resolveOld(staleUpdate);
      else rejectOld(new Error("Offline"));
      await oldCheck;

      expect(useUpdaterStore.getState()).toMatchObject({ update: null, checking: true, error: null, downloaded: false });
      expect(downloadUpdateMock).not.toHaveBeenCalled();
      if (outcome === "update") expect(disposeUpdateMock).toHaveBeenCalledWith(staleUpdate);
      resolveNew(null);
      await newCheck;
    });

    it.each(["success", "failure"])("ignores stale download callbacks and %s, closing only after the operation settles", async (outcome) => {
      const update = createMockUpdate();
      let onEvent!: (event: DownloadEvent) => void;
      let resolveDownload!: () => void;
      let rejectDownload!: (error: Error) => void;
      vi.mocked(checkForUpdatesMock).mockResolvedValueOnce(update);
      vi.mocked(downloadUpdateMock).mockImplementationOnce((_, callback) => {
        onEvent = callback!;
        return new Promise((resolve, reject) => { resolveDownload = resolve; rejectDownload = reject; });
      });
      await useUpdaterStore.getState().checkForUpdates();
      await useUpdaterStore.getState().reset();
      expect(disposeUpdateMock).not.toHaveBeenCalledWith(update);
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 50 } });
      onEvent({ event: "Finished" });
      if (outcome === "success") resolveDownload();
      else rejectDownload(new Error("Offline"));
      await vi.waitFor(() => expect(disposeUpdateMock).toHaveBeenCalledWith(update));
      expect(useUpdaterStore.getState()).toMatchObject({ update: null, downloading: false, downloaded: false, error: null, progress: null });
    });

    it("ignores a stale install failure and defers closing the active handle", async () => {
      const update = createMockUpdate();
      let rejectInstall!: (error: Error) => void;
      vi.mocked(installAndRelaunchMock).mockImplementationOnce(() => new Promise((_, reject) => { rejectInstall = reject; }));
      useUpdaterStore.setState({ update, downloaded: true });
      const install = useUpdaterStore.getState().restartToUpdate();
      await useUpdaterStore.getState().reset();
      expect(useUpdaterStore.getState()).toMatchObject({ update: null, installing: false });
      expect(disposeUpdateMock).not.toHaveBeenCalledWith(update);
      rejectInstall(new Error("Install failed"));
      await install;
      expect(disposeUpdateMock).toHaveBeenCalledWith(update);
      expect(useUpdaterStore.getState().error).toBeNull();
    });

    it("clears state before disposal, without a slow close erasing a newer check", async () => {
      const update = createMockUpdate();
      let finishClose!: () => void;
      vi.mocked(disposeUpdateMock).mockImplementationOnce(() => new Promise((resolve) => { finishClose = resolve; }));
      useUpdaterStore.setState({ update, downloaded: true });
      const reset = useUpdaterStore.getState().reset();
      expect(useUpdaterStore.getState()).toMatchObject({ update: null, downloaded: false });
      vi.mocked(checkForUpdatesMock).mockResolvedValueOnce(null);
      await useUpdaterStore.getState().checkForUpdates();
      finishClose();
      await reset;
      expect(useUpdaterStore.getState().statusMessage).toBe("You're on the latest version");
    });

    it("still resets when disposal fails", async () => {
      useUpdaterStore.setState({ update: createMockUpdate(), downloaded: true });
      vi.mocked(disposeUpdateMock).mockRejectedValueOnce(new Error("Already closed"));
      await useUpdaterStore.getState().reset();
      expect(useUpdaterStore.getState()).toMatchObject({ update: null, downloaded: false, error: null });
    });

    it("disposes update and resets all state", async () => {
      const mockUpdate = createMockUpdate();
      vi.mocked(disposeUpdateMock).mockResolvedValue(undefined);

      useUpdaterStore.setState({
        update: mockUpdate,
        downloading: true,
        downloaded: true,
        progress: 50,
        error: "some error",
        statusMessage: "some message",
      });

      await useUpdaterStore.getState().reset();

      expect(disposeUpdateMock).toHaveBeenCalledWith(mockUpdate);

      const state = useUpdaterStore.getState();
      expect(state.update).toBeNull();
      expect(state.downloading).toBe(false);
      expect(state.downloaded).toBe(false);
      expect(state.progress).toBeNull();
      expect(state.error).toBeNull();
      expect(state.statusMessage).toBeNull();
    });
  });
});
