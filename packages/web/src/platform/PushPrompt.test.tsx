import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  };
});

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
    getPushStatus: push.get,
    enablePush: push.enablePush,
    pushDeliveryActive: () => false,
  };
});

import { useAuthStore } from "@thechat/client/stores/auth";
import { PushPrompt } from "./PushPrompt";

const BRAVE_HINT = "Brave blocks this by default. Turn on “Use Google services for push messaging” in brave://settings/privacy, restart Brave, then try again.";
const TITLE = "Get notified when TheChat is closed";

function signIn(id = "u-me") {
  act(() =>
    useAuthStore.setState({
      token: null,
      loading: false,
      user: { id, name: "Me", email: "me@example.com", avatar: null, type: "human" },
    }),
  );
}

/** A fresh page load: the component state is gone, only localStorage remains. */
function reload() {
  cleanup();
  push.set({ state: "off" });
  return render(<PushPrompt />);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  signIn();
  push.set({ state: "off" });
  vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default" }));
});
afterEach(() => vi.unstubAllGlobals());

describe("PushPrompt", () => {
  it("is shown once and stays gone after Turn on succeeds", async () => {
    push.enablePush.mockImplementationOnce(async () => {
      push.set({ state: "on" });
      return true;
    });
    render(<PushPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    reload();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not come back on reload when turning on failed, and explains why", async () => {
    // Brave with "Use Google services for push messaging" off: permission is
    // granted but the push service refuses the subscription.
    push.enablePush.mockImplementationOnce(async () => {
      push.set({ state: "error", message: BRAVE_HINT });
      return false;
    });
    render(<PushPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));

    const dialog = await screen.findByRole("dialog", { name: "Couldn't turn on notifications" });
    expect(screen.getByRole("alert")).toHaveTextContent(BRAVE_HINT);
    expect(dialog).toHaveAccessibleDescription(BRAVE_HINT);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Every refresh used to show the prompt again, because the push state is
    // back to "off" and only a successful Turn on was remembered.
    reload();
    expect(screen.queryByRole("dialog", { name: TITLE })).not.toBeInTheDocument();
  });

  it("does not come back when the browser's own permission dialog is dismissed", async () => {
    push.enablePush.mockImplementationOnce(async () => {
      push.set({ state: "off" });
      return false;
    });
    render(<PushPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    reload();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows progress while turning on and ignores a second tap", async () => {
    let finish!: (value: boolean) => void;
    push.enablePush.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          push.set({ state: "working" });
          finish = resolve;
        }),
    );
    render(<PushPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    const busy = screen.getByRole("button", { name: "Turning on…" });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(push.enablePush).toHaveBeenCalledOnce();
    await act(async () => {
      push.set({ state: "on" });
      finish(true);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Not now is remembered per account", () => {
    render(<PushPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    reload();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    cleanup();
    signIn("u-other");
    reload();
    expect(screen.getByRole("dialog", { name: TITLE })).toBeInTheDocument();
  });

  it("is not offered when notifications are on, blocked or still being checked", () => {
    const view = render(<PushPrompt />);
    expect(screen.getByRole("dialog", { name: TITLE })).toBeInTheDocument();
    for (const state of ["on", "checking", "blocked", "unsupported", "unavailable"]) {
      act(() => push.set({ state }));
      expect(view.queryByRole("dialog")).not.toBeInTheDocument();
    }
    act(() => push.set({ state: "off" }));
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "denied" }));
    view.rerender(<PushPrompt />);
    expect(view.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
