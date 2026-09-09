import { beforeEach, describe, expect, it } from "vitest";
import { usePresenceStore } from "./presence";

describe("presence store", () => {
  beforeEach(() => {
    usePresenceStore.getState().clear();
  });

  it("replaces snapshots and applies incremental status changes", () => {
    usePresenceStore.getState().replaceOnlineUsers(["u-1", "u-2", "u-1"]);
    expect([...usePresenceStore.getState().onlineUserIds].sort()).toEqual([
      "u-1",
      "u-2",
    ]);

    usePresenceStore.getState().setUserOnline("u-2", false);
    usePresenceStore.getState().setUserOnline("u-3", true);

    expect([...usePresenceStore.getState().onlineUserIds].sort()).toEqual([
      "u-1",
      "u-3",
    ]);
  });
});
