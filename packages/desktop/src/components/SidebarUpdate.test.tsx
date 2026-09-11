import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Update } from "@tauri-apps/plugin-updater";
import { SidebarUpdate } from "./SidebarUpdate";
import { UpdateToast } from "./UpdateToast";
import { useUpdaterStore } from "../stores/updater";
import { checkForUpdates, downloadUpdate, installAndRelaunch } from "../lib/updater";

vi.mock("../lib/updater", () => ({
  checkForUpdates: vi.fn(), downloadUpdate: vi.fn(),
  installAndRelaunch: vi.fn(), disposeUpdate: vi.fn(),
}));
vi.mock("@thechat/client/log", () => ({ error: vi.fn(), formatError: String }));

const update = { version: "2.0.0", currentVersion: "1.0.0" } as Update;
beforeEach(() => {
  useUpdaterStore.setState(useUpdaterStore.getInitialState(), true);
  vi.resetAllMocks();
});
afterEach(() => {
  cleanup();
  useUpdaterStore.setState(useUpdaterStore.getInitialState(), true);
});

describe("SidebarUpdate", () => {
  it("installs from the keyboard and shares the single-flight action with the toast", async () => {
    useUpdaterStore.setState({ update, downloaded: true });
    let finish!: () => void;
    vi.mocked(installAndRelaunch).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<><SidebarUpdate /><UpdateToast /></>);
    const toastButton = screen.getByRole("button", { name: "Restart to update" });
    const keyboard = userEvent.setup();
    await keyboard.tab();
    expect(screen.getByRole("button", { name: /Update available/ })).toHaveFocus();
    await keyboard.keyboard("{Enter}");
    try {
      fireEvent.click(toastButton);
      expect(installAndRelaunch).toHaveBeenCalledExactlyOnceWith(update);
      for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    } finally {
      await act(async () => finish());
    }
  });

  it("retries a failed installation using the already downloaded artifact", async () => {
    useUpdaterStore.setState({ update, downloaded: true });
    vi.mocked(installAndRelaunch).mockRejectedValueOnce(new Error("Install failed"));
    render(<SidebarUpdate />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Update available/ })));
    expect(screen.getByText(/Failed to install update/)).toBeVisible();
    expect(useUpdaterStore.getState().downloaded).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Retry update/ })));
    expect(installAndRelaunch).toHaveBeenCalledTimes(2);
    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(useUpdaterStore.getState().error).toBeNull();
  });

  it("offers a download retry without losing the available version", async () => {
    useUpdaterStore.setState({ update, error: "Failed to download update" });
    vi.mocked(downloadUpdate).mockResolvedValue(undefined);
    render(<SidebarUpdate />);
    const retry = screen.getByRole("button", { name: /Retry update/ });
    expect(screen.getByText(/Failed to download update/)).toBeVisible();
    await act(async () => fireEvent.click(retry));
    expect(downloadUpdate).toHaveBeenCalledWith(update, expect.any(Function));
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(installAndRelaunch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Update available/ })).toBeEnabled();
  });

  it("renders nothing when up to date", () => {
    const { container } = render(<SidebarUpdate />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not invent a percentage for an unknown download size", () => {
    useUpdaterStore.setState({ update, downloading: true, progress: null });
    render(<SidebarUpdate />);
    expect(screen.getByRole("button", { name: /Downloading update/ })).toBeDisabled();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("keeps an available update after the sidebar remounts", () => {
    useUpdaterStore.setState({ update, downloaded: true });
    const first = render(<SidebarUpdate />);
    first.unmount();
    render(<SidebarUpdate />);
    expect(screen.getByRole("button", { name: /Update available/ })).toBeEnabled();
    expect(installAndRelaunch).not.toHaveBeenCalled();
  });

  it("disables both install controls during installation", () => {
    useUpdaterStore.setState({ update, downloaded: true, installing: true });
    render(<><section aria-label="Sidebar"><SidebarUpdate /></section><UpdateToast /></>);
    const sidebar = within(screen.getByRole("region", { name: "Sidebar" }));
    expect(sidebar.getByRole("button", { name: /Installing update/ })).toBeDisabled();
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
  it("stays visible while downloading, then enables installation without remounting", () => {
    useUpdaterStore.setState({ update, downloading: true, progress: 42 });
    render(<SidebarUpdate />);
    expect(screen.getByRole("button", { name: /Downloading update/ })).toBeDisabled();
    expect(screen.getByText(/42%/)).toBeVisible();
    act(() => useUpdaterStore.setState({ downloading: false, downloaded: true, progress: 100 }));
    expect(screen.getByRole("button", { name: /Update available/ })).toBeEnabled();
    expect(screen.getByText(/2\.0\.0.*Restart to install/)).toBeVisible();
  });
});
