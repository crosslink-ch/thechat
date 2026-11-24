import { expect, it, vi } from "vitest";
import type { SearchDestination } from "@thechat/shared";
import { wsEvents } from "../lib/ws-events";
import { registerSearchDirectoryInvalidation, useSearchDirectoryStore } from "./search-directory";

vi.mock("../lib/search-api", () => ({ fetchSearchDirectory: vi.fn() }));

it("refreshes pictures in an already open quick switcher, including removal", () => {
  const person: SearchDestination = {
    kind: "person", userId: "jane", name: "Jane", userType: "human",
    avatar: null, botAvatar: null, botKind: null, conversationId: null,
    workspaceId: "w1", workspaceName: "Test",
  };
  useSearchDirectoryStore.setState({ destinations: [person], loadedAt: 100, loaded: true });
  const cleanup = registerSearchDirectoryInvalidation();
  try {
    for (const avatar of ["data:image/png;base64,cGljdHVyZQ==", null]) {
      wsEvents.emit("ws:member_updated", { workspaceId: "w1", userId: "jane", name: "Jane Updated", avatar });
      expect(useSearchDirectoryStore.getState().destinations[0]).toMatchObject({ avatar, name: "Jane Updated" });
      expect(useSearchDirectoryStore.getState().loadedAt).toBe(0);
    }
  } finally {
    cleanup();
    useSearchDirectoryStore.getState().reset();
  }
});
