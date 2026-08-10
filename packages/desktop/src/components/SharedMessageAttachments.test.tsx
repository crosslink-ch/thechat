import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../lib/shared-attachments", () => ({
  getAttachmentDownloadUrl: vi.fn(),
  openSharedAttachmentDownload: vi.fn(),
}));

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

  it("records image render and open outcomes under the authorization span", async () => {
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
