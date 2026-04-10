import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Update } from "@tauri-apps/plugin-updater";
import { UpdateToast } from "./UpdateToast";
import { useUpdaterStore } from "../stores/updater";

// Mock the updater lib so the store doesn't try to actually call Tauri
vi.mock("../lib/updater", () => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  installAndRelaunch: vi.fn(),
  disposeUpdate: vi.fn(),
}));

vi.mock("../log", () => ({
  info: vi.fn(),
  error: vi.fn(),
  formatError: (e: unknown) => String(e),
}));

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
});

describe("UpdateToast", () => {
  it("renders nothing when no update is available", () => {
    const { container } = render(<UpdateToast />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing while update is downloading", () => {
    useUpdaterStore.setState({
      update: createMockUpdate(),
      downloading: true,
      downloaded: false,
    });

    const { container } = render(<UpdateToast />);
    expect(container.innerHTML).toBe("");
  });

  it("shows restart prompt when update is downloaded", () => {
    useUpdaterStore.setState({
      update: createMockUpdate("2.0.0"),
      downloaded: true,
    });

    render(<UpdateToast />);

    expect(screen.getByText("Update ready: 2.0.0")).toBeInTheDocument();
    expect(screen.getByText("Restart the app to apply the update.")).toBeInTheDocument();
    expect(screen.getByText("Restart to update")).toBeInTheDocument();
  });

  it("shows error when download failed", () => {
    useUpdaterStore.setState({
      update: createMockUpdate(),
      downloaded: false,
      error: "Failed to download update",
    });

    render(<UpdateToast />);

    expect(screen.getByText("Update failed")).toBeInTheDocument();
    expect(screen.getByText("Failed to download update")).toBeInTheDocument();
    // No restart button when not downloaded
    expect(screen.queryByText("Restart to update")).not.toBeInTheDocument();
  });

  it("calls restartToUpdate when restart button is clicked", async () => {
    const restartToUpdate = vi.fn();
    useUpdaterStore.setState({
      update: createMockUpdate(),
      downloaded: true,
      restartToUpdate,
    });

    render(<UpdateToast />);

    await userEvent.click(screen.getByText("Restart to update"));
    expect(restartToUpdate).toHaveBeenCalled();
  });

  it("does not show subtitle text when there is an error", () => {
    useUpdaterStore.setState({
      update: createMockUpdate(),
      downloaded: false,
      error: "Something went wrong",
    });

    render(<UpdateToast />);

    expect(screen.queryByText("Restart the app to apply the update.")).not.toBeInTheDocument();
  });
});
