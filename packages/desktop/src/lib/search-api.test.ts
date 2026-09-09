import { beforeEach, expect, it, vi } from "vitest";
import { searchJump, searchMessages, getMessageContext } from "./search-api";
const { jump, messages, context, messageRoute } = vi.hoisted(() => {
  const context = vi.fn();
  return {
    jump: vi.fn(),
    messages: vi.fn(),
    context,
    messageRoute: vi.fn(() => ({ context: { get: context } })),
  };
});
vi.mock("./api", () => ({
  api: {
    search: {
      jump: { get: jump },
      messages: Object.assign(messageRoute, { get: messages }),
    },
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  jump.mockResolvedValue({ data: { items: [], hasMore: false }, error: null });
  messages.mockResolvedValue({
    data: { items: [], hasMore: false },
    error: null,
  });
  context.mockResolvedValue({
    data: {
      conversationId: "dm",
      threadId: null,
      messages: [],
      hasOlder: true,
      hasNewer: true,
    },
    error: null,
  });
});
it("uses Treaty for empty/all-workspace destinations with optional ranking hint", async () => {
  expect(
    await searchJump(
      { q: "", kind: "all", workspaceId: "beta", limit: 30, offset: 0 },
      "token",
    ),
  ).toEqual({ items: [], hasMore: false });
  expect(jump).toHaveBeenCalledWith({
    query: { q: "", kind: "all", workspaceId: "beta", limit: 30, offset: 0 },
    headers: { authorization: "Bearer token" },
  });
});
it("uses Treaty pagination and preserves cookie auth with a null bearer", async () => {
  await searchMessages({ q: "launch", limit: 20, offset: 20 }, null);
  expect(messages).toHaveBeenCalledWith({
    query: { q: "launch", limit: 20, offset: 20 },
    headers: {},
  });
});
it("uses the exact message context endpoint and surfaces revoked access instead of fabricated results", async () => {
  await getMessageContext("old", "token");
  expect(messageRoute).toHaveBeenCalledWith({ messageId: "old" });
  expect(context).toHaveBeenCalledWith({
    headers: { authorization: "Bearer token" },
  });
  context.mockResolvedValue({
    data: null,
    error: { value: { error: "Not found" } },
  });
  await expect(getMessageContext("old", "token")).rejects.toThrow("Not found");
  jump.mockResolvedValue({
    data: null,
    error: { value: { error: "Forbidden" } },
  });
  await expect(searchJump({ q: "Koda", kind: "dm" }, "token")).rejects.toThrow(
    "Forbidden",
  );
});

it("rejects typed middleware error bodies even when Treaty does not populate its error slot", async () => {
  jump.mockResolvedValue({ data: { error: "Access removed" }, error: null });
  messages.mockResolvedValue({
    data: { error: "Access removed" },
    error: null,
  });
  context.mockResolvedValue({ data: { error: "Access removed" }, error: null });
  await expect(searchJump({ q: "", kind: "all" }, "token")).rejects.toThrow(
    "Access removed",
  );
  await expect(searchMessages({ q: "launch" }, "token")).rejects.toThrow(
    "Access removed",
  );
  await expect(getMessageContext("old", "token")).rejects.toThrow(
    "Access removed",
  );
});

it("preserves the optional terminal truncation state through both API wrappers", async () => {
  const page = { items: [], hasMore: false, truncated: true };
  jump.mockResolvedValue({ data: page, error: null });
  messages.mockResolvedValue({ data: page, error: null });
  expect(await searchJump({ q: "", kind: "all", offset: 10000 }, null)).toEqual(page);
  expect(await searchMessages({ q: "needle", offset: 10000 }, null)).toEqual(page);
});
