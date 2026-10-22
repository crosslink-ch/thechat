import { beforeEach, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  notifications: {
    permitDelivery: vi.fn(async () => true),
    send: vi.fn(),
    backgroundPushActive: vi.fn(() => false),
  },
}));
vi.mock("#platform-services", () => ({ services }));

import { fireNotification } from "./notifications";

beforeEach(() => vi.clearAllMocks());

it("skips the page notification when background push already covers this device", async () => {
  services.notifications.backgroundPushActive.mockReturnValue(true);
  await fireNotification("Ana", "hi", { dedupeKey: "push-covered-1", coveredByBackgroundPush: true });
  expect(services.notifications.send).not.toHaveBeenCalled();

  // Events the server does not push (e.g. workspace invites) still show.
  await fireNotification("Invite", "join", { dedupeKey: "push-covered-2" });
  expect(services.notifications.send).toHaveBeenCalledWith("Invite", "join");
});

it("shows the page notification when this device has no background push", async () => {
  services.notifications.backgroundPushActive.mockReturnValue(false);
  await fireNotification("Ana", "hi", { dedupeKey: "push-covered-3", coveredByBackgroundPush: true });
  expect(services.notifications.send).toHaveBeenCalledWith("Ana", "hi");
});
