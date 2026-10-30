import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => {
  let status: { state: string; message?: string } = { state: "off" };
  const listeners = new Set<() => void>();
  return {
    set(next: { state: string; message?: string }) {
      status = next;
      for (const listener of listeners) listener();
    },
    get: () => status,
    listeners,
    enablePush: vi.fn(async () => true),
    disablePush: vi.fn(async () => undefined),
    sendTestPush: vi.fn(async () => "sent"),
  };
});

const api = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("@thechat/client/platform/environment", () => ({ isWeb: true }));
vi.mock("@thechat/client/lib/api", () => ({
  api: { push: { preferences: { get: api.get, patch: api.patch } } },
}));
vi.mock("./push", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePushStatus: () =>
      useSyncExternalStore(
        (listener) => {
          push.listeners.add(listener);
          return () => push.listeners.delete(listener);
        },
        push.get,
      ),
    enablePush: push.enablePush,
    disablePush: push.disablePush,
    sendTestPush: push.sendTestPush,
    isIosDevice: () => false,
  };
});

import { settingsPrimaryButton } from "@thechat/client/components/SettingsSection";
import { BrowserNotificationSettings } from "./BrowserNotificationSettings";

const defaults = {
  directMessages: true,
  mentions: true,
  agentReplies: true,
  agentRequests: true,
  showPreviews: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  push.set({ state: "off" });
  api.get.mockResolvedValue({ data: { ...defaults }, error: null });
  api.patch.mockImplementation(async (changes: object) => ({
    data: { ...defaults, ...changes },
    error: null,
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("BrowserNotificationSettings", () => {
  it("offers to turn on background notifications from an explicit action", async () => {
    render(<BrowserNotificationSettings />);
    const heading = screen.getByRole("heading", { level: 2, name: "Notifications" });
    expect(heading.closest("section")).toHaveAccessibleName("Notifications");
    const enable = screen.getByRole("button", { name: "Turn on notifications" });
    expect(enable).toHaveClass(...settingsPrimaryButton.split(" "));
    expect(push.enablePush).not.toHaveBeenCalled();
    fireEvent.click(enable);
    expect(push.enablePush).toHaveBeenCalledOnce();
  });

  it("explains each state without offering actions that cannot work", () => {
    const view = render(<BrowserNotificationSettings />);
    const cases: [string, RegExp][] = [
      ["blocked", /Blocked\. Allow notifications for this site/],
      ["install-required", /add TheChat to your Home Screen first/],
      ["unavailable", /aren't set up on this server/],
      ["unsupported", /doesn't support background notifications/],
    ];
    for (const [state, text] of cases) {
      act(() => push.set({ state }));
      expect(view.getByText(text)).toBeInTheDocument();
      expect(view.queryByRole("button", { name: "Turn on notifications" })).not.toBeInTheDocument();
    }
  });

  it("when on, sends a test notification and can turn off", async () => {
    push.set({ state: "on" });
    render(<BrowserNotificationSettings />);
    expect(screen.getByText(/On\. You'll get notifications when TheChat is closed\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send test notification" }));
    expect(await screen.findByText(/Sent\. It should appear/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(push.disablePush).toHaveBeenCalledOnce();
  });

  it("loads and saves account-wide choices, reverting on failure", async () => {
    render(<BrowserNotificationSettings />);
    const mentions = await screen.findByRole("checkbox", { name: /Mentions/ });
    await waitFor(() => expect(mentions).toBeChecked());
    fireEvent.click(mentions);
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith({ mentions: false }, expect.anything()));
    expect(mentions).not.toBeChecked();

    api.patch.mockResolvedValueOnce({ data: null, error: { status: 500 } });
    const previews = screen.getByRole("checkbox", { name: /Show message previews/ });
    fireEvent.click(previews);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save. Try again.");
    expect(previews).toBeChecked();
  });

  it("hides the choices where background notifications cannot work", () => {
    push.set({ state: "unsupported" });
    render(<BrowserNotificationSettings />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });
});
