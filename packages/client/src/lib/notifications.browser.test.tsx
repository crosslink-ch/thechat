import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../platform/environment", () => ({ isWeb: true }));
vi.mock("../routes/settings-api-access", () => ({ ApiAccessSettings: () => null }));
import { fireNotification } from "./notifications";
import { SettingsRoute } from "../routes/settings";
import { useAuthStore } from "../stores/auth";
afterEach(() => vi.unstubAllGlobals());
it("delivers page-lifetime notifications through the browser capability only when granted", async () => {
  const NotificationMock = Object.assign(vi.fn(function() {}), { permission: "granted", requestPermission: vi.fn() });
  vi.stubGlobal("Notification", NotificationMock);
  await fireNotification("Browser message", "Body", { dedupeKey: "browser-granted" });
  expect(NotificationMock).toHaveBeenCalledWith("Browser message", expect.objectContaining({ body: "Body" }));
  NotificationMock.permission = "default";
  await fireNotification("Browser message", "Body", { dedupeKey: "browser-default" });
  expect(NotificationMock).toHaveBeenCalledTimes(1);
  expect(NotificationMock.requestPermission).not.toHaveBeenCalled();
});
it("shows the browser Notifications section without asking for permission on its own", async () => {
  const NotificationMock = Object.assign(vi.fn(function() {}), { permission: "default", requestPermission: vi.fn() });
  vi.stubGlobal("Notification", NotificationMock);
  useAuthStore.setState({ user: { id: "a", name: "Alice", email: "a@example.invalid" } as never, token: null });
  const view = render(<SettingsRoute />);
  expect(await view.findByRole("heading", { level: 2, name: "Notifications" })).toBeVisible();
  expect(view.getByText("This device")).toBeVisible();
  expect(NotificationMock.requestPermission).not.toHaveBeenCalled();
});
