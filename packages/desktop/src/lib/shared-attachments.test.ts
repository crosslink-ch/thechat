import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  attachments: vi.fn(),
  deleteAttachment: vi.fn(),
}));

vi.mock("./api", () => ({
  api: {
    attachments: apiMocks.attachments,
  },
}));

import { cancelSharedAttachment } from "./shared-attachments";

describe("cancelSharedAttachment", () => {
  beforeEach(() => {
    apiMocks.attachments.mockReset();
    apiMocks.deleteAttachment.mockReset();
    apiMocks.attachments.mockReturnValue({
      delete: apiMocks.deleteAttachment,
    });
    apiMocks.deleteAttachment.mockResolvedValue({ data: { ok: true }, error: null });
  });

  it("sends authentication as Eden request options rather than DELETE body", async () => {
    await cancelSharedAttachment("attachment-1", "token-1");

    expect(apiMocks.attachments).toHaveBeenCalledWith({ id: "attachment-1" });
    expect(apiMocks.deleteAttachment).toHaveBeenCalledWith(undefined, {
      headers: { authorization: "Bearer token-1" },
    });
  });
});
