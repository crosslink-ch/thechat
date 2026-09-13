import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  settingsSecondaryButton,
  settingsValue,
} from "@thechat/client/components/SettingsSection";
import { BrowserNotificationSettings } from "./BrowserNotificationSettings";

afterEach(() => vi.unstubAllGlobals());

function stubNotification(
  permission: NotificationPermission,
  requestPermission = vi.fn(),
) {
  const NotificationMock = Object.assign(vi.fn(function () {}), {
    permission,
    requestPermission,
  });
  vi.stubGlobal("Notification", NotificationMock);
  return NotificationMock;
}

describe("BrowserNotificationSettings", () => {
  it("renders a Settings section with the shared row and button styling", () => {
    stubNotification("default");
    render(<BrowserNotificationSettings />);

    const heading = screen.getByRole("heading", {
      level: 2,
      name: "Browser notifications",
    });
    expect(heading.closest("section")).toHaveAccessibleName(
      "Browser notifications",
    );
    const enable = screen.getByRole("button", {
      name: "Enable browser notifications",
    });
    expect(enable).toHaveClass(...settingsSecondaryButton.split(" "));
  });

  it("describes granted, denied and unavailable permission without the request action", () => {
    stubNotification("granted");
    const granted = render(<BrowserNotificationSettings />);
    expect(
      granted.getByText("Notifications enabled while TheChat is open."),
    ).toHaveClass(...settingsValue.split(" "));
    expect(granted.queryByRole("button")).not.toBeInTheDocument();
    granted.unmount();

    stubNotification("denied");
    const denied = render(<BrowserNotificationSettings />);
    expect(
      denied.getByText(/Notifications are blocked\. Change this site's permission/),
    ).toBeInTheDocument();
    expect(denied.queryByRole("button")).not.toBeInTheDocument();
    denied.unmount();

    vi.stubGlobal("Notification", undefined);
    const unavailable = render(<BrowserNotificationSettings />);
    expect(
      unavailable.getByText("This browser does not support page notifications."),
    ).toBeInTheDocument();
    expect(unavailable.queryByRole("button")).not.toBeInTheDocument();
  });

  it("requests permission only from the explicit action and reflects the result", async () => {
    const NotificationMock = stubNotification(
      "default",
      vi.fn().mockResolvedValue("granted"),
    );
    render(<BrowserNotificationSettings />);
    expect(NotificationMock.requestPermission).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Enable browser notifications" }),
    );
    await waitFor(() =>
      expect(NotificationMock.requestPermission).toHaveBeenCalledOnce(),
    );
    expect(
      await screen.findByText("Notifications enabled while TheChat is open."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
