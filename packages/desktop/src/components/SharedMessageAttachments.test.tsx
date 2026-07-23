import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharedMessageAttachments } from "./SharedMessageAttachments";
import { getAttachmentDownloadUrl } from "../lib/shared-attachments";
import { useAuthStore } from "../stores/auth";

vi.mock("../lib/shared-attachments", () => ({
  getAttachmentDownloadUrl: vi.fn(),
}));

describe("SharedMessageAttachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ token: "test-token" });
    delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;
    vi.mocked(getAttachmentDownloadUrl).mockResolvedValue({
      url: "https://objects.example/image",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  });

  it("requests an inline disposition for image previews", async () => {
    render(
      <SharedMessageAttachments
        attachments={[
          {
            id: "attachment-image",
            fileName: "diagram.png",
            name: "diagram.png",
            mediaType: "image/png",
            mimeType: "image/png",
            sizeBytes: 42,
            kind: "image",
            contentPath: "/attachments/attachment-image/content",
          },
        ]}
      />,
    );

    await waitFor(() =>
      expect(getAttachmentDownloadUrl).toHaveBeenCalledWith(
        "attachment-image",
        "test-token",
        "inline",
      ),
    );
  });
});
