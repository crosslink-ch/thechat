import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Update } from "@tauri-apps/plugin-updater";
import { RootView } from "./__root";
import { useUpdaterStore } from "../stores/updater";

vi.mock("../components/WindowTitlebar", () => ({
  WindowTitlebar: () => <div data-testid="window-titlebar" />,
}));

vi.mock("../components/AuthModal", () => ({
  AuthModal: () => null,
  AuthOnboarding: () => <div>Logged out</div>,
}));

vi.mock("../lib/updater", () => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  installAndRelaunch: vi.fn(),
  disposeUpdate: vi.fn(),
}));

vi.mock("../log", () => ({
  info: vi.fn(),
  error: vi.fn(),
  formatError: (error: unknown) => String(error),
}));

function createMockUpdate(): Update {
  return {
    version: "2.0.0",
    currentVersion: "1.0.0",
    body: "Bug fixes",
    available: true,
    rawJson: {},
    close: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
    downloadAndInstall: vi.fn(),
  } as unknown as Update;
}

beforeEach(() => {
  useUpdaterStore.setState({
    update: null,
    checking: false,
    downloading: false,
    downloaded: false,
    progress: null,
    error: null,
    statusMessage: null,
  });
});

describe("RootView", () => {
  it("keeps the restart-to-update action available while logged out", async () => {
    const restartToUpdate = vi.fn();
    useUpdaterStore.setState({
      update: createMockUpdate(),
      downloaded: true,
      restartToUpdate,
    });

    render(<RootView authLoading={false} authenticated={false} />);

    expect(screen.getByText("Logged out")).toBeInTheDocument();
    expect(screen.getByText("Update ready: 2.0.0")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(restartToUpdate).toHaveBeenCalledOnce();
  });
});
