import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    pushDeliveryActive: () => false,
    isIosDevice: () => false,
  };
});

import { settingsPrimaryButton } from "@thechat/client/components/SettingsSection";
import { useAuthStore } from "@thechat/client/stores/auth";
import { useNotificationPreferencesStore } from "@thechat/client/stores/notification-preferences";
import { BrowserNotificationSettings } from "./BrowserNotificationSettings";

const defaults = {
  directMessages: true,
  mentions: true,
  agentReplies: true,
  agentRequests: true,
  agentProgress: false,
  showPreviews: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  useNotificationPreferencesStore.getState().reset();
  useAuthStore.setState({
    token: null,
    loading: false,
    user: { id: "u-me", name: "Me", email: "me@example.com", avatar: null, type: "human" },
  });
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

  it("defaults agent updates to final results only and saves every update account-wide", async () => {
    render(<BrowserNotificationSettings />);
    const group = await screen.findByRole("radiogroup", { name: "Agent updates" });
    const finalOnly = screen.getByRole("radio", { name: /Final results only/ });
    const everyUpdate = screen.getByRole("radio", { name: /Every update/ });
    expect(group).toContainElement(finalOnly);
    await waitFor(() => expect(finalOnly).toBeChecked());
    expect(everyUpdate).not.toBeChecked();

    fireEvent.click(everyUpdate);
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith({ agentProgress: true }, expect.anything()));
    expect(everyUpdate).toBeChecked();
    // The same choice drives in-app notifications, not only this browser's push.
    expect(useNotificationPreferencesStore.getState().preferences?.agentProgress).toBe(true);

    api.patch.mockResolvedValueOnce({ data: null, error: { status: 500 } });
    fireEvent.click(finalOnly);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save. Try again.");
    expect(everyUpdate).toBeChecked();
  });

  it("disables agent updates while agent replies are off", async () => {
    api.get.mockResolvedValue({ data: { ...defaults, agentReplies: false }, error: null });
    render(<BrowserNotificationSettings />);
    expect(await screen.findByText("Agent replies are off")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Every update/ })).toBeDisabled();
  });

  it("hides the push choices where background notifications cannot work but keeps agent updates", async () => {
    push.set({ state: "unsupported" });
    render(<BrowserNotificationSettings />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    // Agent updates also gate in-app notifications in open tabs, so they stay choosable.
    const group = await screen.findByRole("radiogroup", { name: "Agent updates" });
    expect(await within(group).findByRole("radio", { name: /Final results only/ })).toBeChecked();
    expect(within(group).getByRole("radio", { name: /Every update/ })).toBeEnabled();
  });
});
