import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  attachments: vi.fn(),
  reserveAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));

vi.mock("./api", () => ({
  api: {
    attachments: Object.assign(apiMocks.attachments, {
      post: apiMocks.reserveAttachment,
    }),
  },
}));

import {
  cancelSharedAttachment,
  uploadSharedAttachment,
} from "./shared-attachments";

const attachment = {
  id: "attachment-1",
  fileName: "report.txt",
  name: "report.txt",
  mediaType: "text/plain",
  mimeType: "text/plain",
  sizeBytes: 6,
  kind: "file" as const,
  status: "pending_upload" as const,
  contentPath: "/attachments/attachment-1/content",
};

describe("cancelSharedAttachment", () => {
  beforeEach(() => {
    apiMocks.attachments.mockReset();
    apiMocks.reserveAttachment.mockReset();
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

  it("deletes a reservation that completes after the user already cancelled", async () => {
    let resolveReservation!: (value: unknown) => void;
    apiMocks.reserveAttachment.mockReturnValue(
      new Promise((resolve) => {
        resolveReservation = resolve;
      }),
    );
    const controller = new AbortController();
    const upload = uploadSharedAttachment(
      {
        conversationId: "conversation-1",
        token: "token-1",
        file: new File(["report"], "report.txt", { type: "text/plain" }),
        signal: controller.signal,
      },
      vi.fn(),
    );
    await vi.waitFor(() =>
      expect(apiMocks.reserveAttachment).toHaveBeenCalledOnce(),
    );

    controller.abort();
    resolveReservation({
      data: {
        attachment,
        upload: {
          method: "PUT",
          url: "http://unused.invalid",
          headers: {},
        },
      },
      error: null,
    });

    await expect(upload).rejects.toMatchObject({ name: "AbortError" });
    expect(apiMocks.deleteAttachment).toHaveBeenCalledWith(undefined, {
      headers: { authorization: "Bearer token-1" },
    });
  });
});
