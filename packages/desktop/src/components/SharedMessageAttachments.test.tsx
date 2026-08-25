import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "@thechat/shared";
import { SharedMessageAttachments } from "./SharedMessageAttachments";
import {
  getAttachmentDownloadUrl,
  openSharedAttachmentDownload,
} from "../lib/shared-attachments";
import { setDesktopTracerForTests } from "../lib/telemetry";
import { useAuthStore } from "../stores/auth";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const authorizationParentSpanId = "2222222222222222";
const imageAttachment = {
  id: "attachment-image",
  fileName: "diagram.png",
  name: "diagram.png",
  mediaType: "image/png",
  mimeType: "image/png",
  sizeBytes: 42,
  kind: "image",
  contentPath: "/attachments/attachment-image/content",
} satisfies ChatAttachment;

vi.mock("../lib/shared-attachments", () => ({
  getAttachmentDownloadUrl: vi.fn(),
  openSharedAttachmentDownload: vi.fn(),
}));

function renderImageAttachment() {
  return render(<SharedMessageAttachments attachments={[imageAttachment]} />);
}

async function openImageViewer() {
  renderImageAttachment();
  const thumbnail = await screen.findByRole("button", {
    name: "Open diagram.png",
  });
  thumbnail.focus();
  fireEvent.click(thumbnail);
  await screen.findByRole("dialog", { name: "diagram.png" });
  return thumbnail;
}

describe("SharedMessageAttachments", () => {
  beforeAll(() => {
    setDesktopTracerForTests(provider.getTracer("shared-message-attachments-test"));
  });

  beforeEach(() => {
    exporter.reset();
    vi.clearAllMocks();
    useAuthStore.setState({ token: "test-token" });
    delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;
    vi.mocked(getAttachmentDownloadUrl).mockResolvedValue({
      url: "https://objects.example/image",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      traceContext: {
        traceparent: `00-${"1".repeat(32)}-${authorizationParentSpanId}-01`,
      },
    });
    vi.mocked(openSharedAttachmentDownload).mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      transferredBytes: 42,
    });
  });

  afterAll(async () => {
    setDesktopTracerForTests(null);
    await provider.shutdown();
  });

  it("requests an inline disposition for image previews", async () => {
    renderImageAttachment();

    await waitFor(() =>
      expect(getAttachmentDownloadUrl).toHaveBeenCalledWith(
        "attachment-image",
        "test-token",
        "inline",
      ),
    );
  });

  it("shows that an opaque attachment was saved without opening it", async () => {
    render(
      <SharedMessageAttachments
        attachments={[
          {
            id: "attachment-file",
            fileName: "message.eml",
            name: "message.eml",
            mediaType: "message/rfc822",
            mimeType: "message/rfc822",
            sizeBytes: 42,
            kind: "file",
            contentPath: "/attachments/attachment-file/content",
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /message\.eml/i }));

    await waitFor(() =>
      expect(openSharedAttachmentDownload).toHaveBeenCalledWith(
        "attachment-file",
        "test-token",
        "attachment",
        "message.eml",
      ),
    );
    expect(await screen.findByText("Saved to Downloads")).toBeInTheDocument();
    expect(screen.getByTitle("Downloaded message.eml")).toBeInTheDocument();
  });

  it("renders recognizable icon controls with accessible names and tooltips", async () => {
    await openImageViewer();

    const download = screen.getByRole("button", {
      name: "Download diagram.png",
    });
    const close = screen.getByRole("button", {
      name: "Close image viewer",
    });

    expect(download).toHaveAttribute("title", "Download diagram.png");
    expect(close).toHaveAttribute("title", "Close image viewer");
    await waitFor(() => expect(close).toHaveFocus());
    expect(download).not.toHaveTextContent("Download");
    expect(close).not.toHaveTextContent("Close");
    expect(download).toHaveClass("size-[44px]");
    expect(close).toHaveClass("size-[44px]");
    expect(download.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(close.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("reserves a normal-flow toolbar strip outside the expanded image", async () => {
    await openImageViewer();

    const toolbar = screen.getByTestId("image-viewer-toolbar");
    const media = screen.getByTestId("image-viewer-media");
    const image = screen.getByTestId("image-viewer-expanded-image");

    expect(toolbar).toHaveClass("h-[44px]", "shrink-0");
    expect(media).toHaveClass("min-h-0", "flex-1");
    expect(media).toContainElement(image);
    expect(image).toHaveClass("max-h-full", "max-w-full");
    expect(
      toolbar.compareDocumentPosition(media) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("downloads through the authorized attachment helper", async () => {
    await openImageViewer();

    fireEvent.click(
      screen.getByRole("button", { name: "Download diagram.png" }),
    );

    await waitFor(() =>
      expect(openSharedAttachmentDownload).toHaveBeenCalledWith(
        "attachment-image",
        "test-token",
        "attachment",
        "diagram.png",
      ),
    );
  });

  it("coalesces repeated download activation while a transfer is in flight", async () => {
    let finishDownload: (() => void) | undefined;
    vi.mocked(openSharedAttachmentDownload).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDownload = () =>
            resolve({
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              transferredBytes: 42,
            });
        }),
    );
    await openImageViewer();
    const download = screen.getByRole("button", {
      name: "Download diagram.png",
    });

    fireEvent.click(download);
    fireEvent.click(download);

    expect(openSharedAttachmentDownload).toHaveBeenCalledTimes(1);
    finishDownload?.();
    await waitFor(() => expect(download).toBeEnabled());
  });

  it("keeps download failures handled and visible in the viewer", async () => {
    vi.mocked(openSharedAttachmentDownload).mockRejectedValueOnce(
      new Error("Download service unavailable"),
    );
    await openImageViewer();

    fireEvent.click(
      screen.getByRole("button", { name: "Download diagram.png" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Download failed. Download service unavailable",
    );
    expect(
      screen.getByRole("button", { name: "Download diagram.png" }),
    ).toBeEnabled();
  });

  it("closes on Escape and restores focus to the image thumbnail", async () => {
    const ui = userEvent.setup();
    const thumbnail = await openImageViewer();

    await ui.keyboard("{Escape}");

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "diagram.png" }),
      ).not.toBeInTheDocument(),
    );
    expect(thumbnail).toHaveFocus();
  });

  it("activates the close icon from the keyboard", async () => {
    const ui = userEvent.setup();
    const thumbnail = await openImageViewer();
    const close = screen.getByRole("button", { name: "Close image viewer" });
    await waitFor(() => expect(close).toHaveFocus());

    await ui.keyboard("{Enter}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(thumbnail).toHaveFocus();
  });

  it("closes when the viewer backdrop is activated", async () => {
    const thumbnail = await openImageViewer();

    fireEvent.click(screen.getByRole("dialog", { name: "diagram.png" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(thumbnail).toHaveFocus();
  });

  it("records image render and open outcomes under the authorization span", async () => {
    renderImageAttachment();

    const image = await screen.findByRole("img", { name: "diagram.png" });
    fireEvent.load(image);
    fireEvent.click(screen.getByRole("button", { name: "Open diagram.png" }));

    await waitFor(() => {
      expect(
        exporter
          .getFinishedSpans()
          .filter((span) => span.name.startsWith("attachment.image.")),
      ).toHaveLength(2);
    });
    const renderSpan = exporter
      .getFinishedSpans()
      .find((span) => span.name === "attachment.image.render");
    const openSpan = exporter
      .getFinishedSpans()
      .find((span) => span.name === "attachment.image.open");
    expect(renderSpan?.kind).toBe(SpanKind.INTERNAL);
    expect(renderSpan?.status.code).toBe(SpanStatusCode.UNSET);
    expect(renderSpan?.attributes["thechat.attachment.outcome"]).toBe("loaded");
    expect(renderSpan?.attributes["thechat.attachment.image_view"]).toBe(
      "thumbnail",
    );
    expect(renderSpan?.parentSpanContext?.spanId).toBe(
      authorizationParentSpanId,
    );
    expect(openSpan?.kind).toBe(SpanKind.INTERNAL);
    expect(openSpan?.status.code).toBe(SpanStatusCode.UNSET);
    expect(openSpan?.attributes["thechat.attachment.outcome"]).toBe("opened");
    expect(openSpan?.parentSpanContext?.spanId).toBe(authorizationParentSpanId);
  });

  it("re-authorizes a fresh image URL after a render failure", async () => {
    renderImageAttachment();

    const image = await screen.findByRole("img", { name: "diagram.png" });
    fireEvent.error(image);
    await waitFor(() => {
      expect(
        exporter
          .getFinishedSpans()
          .filter(
            (span) =>
              span.name === "attachment.image.render" &&
              span.attributes["thechat.attachment.outcome"] === "failed",
          ),
      ).toHaveLength(1);
    });
    const failureSpan = exporter
      .getFinishedSpans()
      .find(
        (span) =>
          span.name === "attachment.image.render" &&
          span.attributes["thechat.attachment.outcome"] === "failed",
      );
    expect(failureSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(failureSpan?.parentSpanContext?.spanId).toBe(
      authorizationParentSpanId,
    );
    const retry = await screen.findByRole("button", {
      name: /Image unavailable.*retry/i,
    });

    fireEvent.click(retry);
    await waitFor(() => {
      expect(getAttachmentDownloadUrl).toHaveBeenCalledTimes(2);
    });
  });
});
