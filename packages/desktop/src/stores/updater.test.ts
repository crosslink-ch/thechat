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
vi.mock("../log", () => ({
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
    progress: null,
    error: null,
    statusMessage: null,
  });
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
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

  describe("restartToUpdate", () => {
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
