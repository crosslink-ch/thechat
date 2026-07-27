import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

const apiMocks = vi.hoisted(() => ({
  attachments: vi.fn(),
  reserveAttachment: vi.fn(),
  completeAttachment: vi.fn(),
  getAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  downloadAttachment: vi.fn(),
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
  openSharedAttachmentDownload,
  uploadSharedAttachment,
} from "./shared-attachments";
import { setDesktopTracerForTests, withDesktopSpan } from "./telemetry";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  setDesktopTracerForTests(provider.getTracer("desktop-attachment-test"));
});

beforeEach(() => {
  exporter.reset();
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  apiMocks.attachments.mockReturnValue({
    complete: { post: apiMocks.completeAttachment },
    get: apiMocks.getAttachment,
    delete: apiMocks.deleteAttachment,
    download: { get: apiMocks.downloadAttachment },
  });
  apiMocks.deleteAttachment.mockResolvedValue({
    data: { ok: true },
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  setDesktopTracerForTests(null);
  await provider.shutdown();
});

describe("desktop attachment telemetry", () => {
  it("records reserve, object PUT, completion, and each status request truthfully", async () => {
    const pending = attachment("pending_upload");
    const processing = attachment("processing");
    const ready = attachment("ready");
    apiMocks.reserveAttachment.mockResolvedValue({
      data: {
        attachment: pending,
        upload: {
          method: "PUT",
          url: "https://storage.invalid/upload?token=never-export",
          headers: { "content-type": "text/plain" },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
      error: null,
    });
    apiMocks.completeAttachment.mockResolvedValue({
      data: processing,
      error: null,
    });
    apiMocks.getAttachment.mockResolvedValue({ data: ready, error: null });
    vi.stubGlobal("XMLHttpRequest", SuccessfulXmlHttpRequest);

    const result = await uploadSharedAttachment(
      {
        conversationId: "conversation-1",
        token: "token-1",
        file: new File(["report"], "private-report.txt", {
          type: "text/plain",
        }),
        signal: new AbortController().signal,
      },
      vi.fn(),
    );
    expect(result.status).toBe("ready");
    await provider.forceFlush();

    expectClientSpan("attachment.reserve.request", "reserved");
    expectClientSpan("attachment.s3.upload", "uploaded");
    expectClientSpan("attachment.complete.request", "completed");
    expectClientSpan("attachment.status.request", "loaded");
    expect(
      span("attachment.s3.upload").attributes["http.response.status_code"],
    ).toBe(200);
    expect(
      span("attachment.status.request").attributes["thechat.attachment.status"],
    ).toBe("ready");
    for (const child of [
      "attachment.hash",
      "attachment.reserve.request",
      "attachment.s3.upload",
      "attachment.complete.request",
      "attachment.validation.wait",
    ]) {
      expectDirectParent("attachment.prepare", child);
    }
    expectDirectParent(
      "attachment.validation.wait",
      "attachment.status.request",
    );
    expectInjectedTraceparent(
      apiMocks.reserveAttachment,
      1,
      "attachment.reserve.request",
    );
    expectInjectedTraceparent(
      apiMocks.completeAttachment,
      1,
      "attachment.complete.request",
    );
    expectInjectedTraceparent(
      apiMocks.getAttachment,
      0,
      "attachment.status.request",
    );
    expect(telemetryText()).not.toMatch(
      /private-report|never-export|checksum|authorization|presigned/i,
    );
  });

  it("records reserve failures with bounded HTTP and business outcomes", async () => {
    apiMocks.reserveAttachment.mockResolvedValue({
      data: null,
      error: { status: 429, value: { error: "quota exceeded" } },
    });

    await expect(
      uploadSharedAttachment(uploadInput(), vi.fn()),
    ).rejects.toThrow("quota exceeded");
    await provider.forceFlush();

    const request = span("attachment.reserve.request");
    expect(request.kind).toBe(SpanKind.CLIENT);
    expect(request.status.code).toBe(SpanStatusCode.ERROR);
    expect(request.attributes["http.response.status_code"]).toBe(429);
    expect(request.attributes["thechat.attachment.outcome"]).toBe(
      "reserve_failed",
    );
  });

  it("records completion failures before the request span closes", async () => {
    mockReservation();
    apiMocks.completeAttachment.mockResolvedValue({
      data: null,
      error: { status: 409, value: { error: "completion conflict" } },
    });
    vi.stubGlobal("XMLHttpRequest", SuccessfulXmlHttpRequest);

    await expect(
      uploadSharedAttachment(uploadInput(), vi.fn()),
    ).rejects.toThrow("completion conflict");
    await provider.forceFlush();

    const request = span("attachment.complete.request");
    expect(request.kind).toBe(SpanKind.CLIENT);
    expect(request.status.code).toBe(SpanStatusCode.ERROR);
    expect(request.attributes["http.response.status_code"]).toBe(409);
    expect(request.attributes["thechat.attachment.outcome"]).toBe(
      "complete_failed",
    );
  });

  it("records each failed status request under the validation wait span", async () => {
    mockReservation();
    apiMocks.completeAttachment.mockResolvedValue({
      data: attachment("processing"),
      error: null,
    });
    apiMocks.getAttachment.mockResolvedValue({
      data: null,
      error: { status: 503, value: { error: "temporarily unavailable" } },
    });
    vi.stubGlobal("XMLHttpRequest", SuccessfulXmlHttpRequest);

    await expect(
      uploadSharedAttachment(uploadInput(), vi.fn()),
    ).rejects.toThrow("temporarily unavailable");
    await provider.forceFlush();

    const request = span("attachment.status.request");
    expect(request.kind).toBe(SpanKind.CLIENT);
    expect(request.status.code).toBe(SpanStatusCode.ERROR);
    expect(request.attributes["http.response.status_code"]).toBe(503);
    expect(request.attributes["thechat.attachment.outcome"]).toBe(
      "status_failed",
    );
    expectDirectParent("attachment.validation.wait", "attachment.status.request");
    expect(span("attachment.validation.wait").events).toHaveLength(0);
    expect(exceptionEventCount()).toBe(1);
  });

  it("traces normal draft cancellation in the reusable helper", async () => {
    await withDesktopSpan("test.cancel", {}, (_span, parentContext) =>
      cancelSharedAttachment("attachment-1", "token-1", { parentContext }),
    );
    await provider.forceFlush();

    expectClientSpan(
      "attachment.cancel.request",
      "cancellation_requested",
    );
    expectDirectParent("test.cancel", "attachment.cancel.request");
    expectInjectedTraceparent(
      apiMocks.deleteAttachment,
      1,
      "attachment.cancel.request",
    );
  });

  it("observes the actual object GET before launching the downloaded bytes", async () => {
    apiMocks.downloadAttachment.mockResolvedValue({
      data: {
        url: "https://storage.invalid/download?token=never-export",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      error: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("downloaded bytes", { status: 200 })),
    );
    stubBlobLaunch();

    const result = await openSharedAttachmentDownload(
      "attachment-1",
      "token-1",
      "attachment",
      "private-report.txt",
    );
    expect(result.transferredBytes).toBeGreaterThan(0);
    await provider.forceFlush();

    expectClientSpan("attachment.download.authorize.request", "authorized");
    expectClientSpan("attachment.s3.download", "downloaded");
    const download = span("attachment.download");
    expect(download.attributes["thechat.attachment.transfer_observed"]).toBe(
      true,
    );
    expect(download.attributes["thechat.attachment.outcome"]).toBe("completed");
    expect(telemetryText()).not.toMatch(
      /private-report|never-export|storage\.invalid/i,
    );
  });

  it("records an active-content rejection as a bounded policy outcome", async () => {
    apiMocks.reserveAttachment.mockResolvedValue({
      data: {
        attachment: attachment("pending_upload"),
        upload: {
          method: "PUT",
          url: "https://storage.invalid/upload?token=never-export",
          headers: {},
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
      error: null,
    });
    apiMocks.completeAttachment.mockResolvedValue({
      data: attachment("processing"),
      error: null,
    });
    apiMocks.getAttachment.mockResolvedValue({
      data: { ...attachment("ready"), status: "rejected" },
      error: null,
    });
    vi.stubGlobal("XMLHttpRequest", SuccessfulXmlHttpRequest);

    await expect(
      uploadSharedAttachment(
        {
          conversationId: "conversation-1",
          token: "token-1",
          file: new File(["blocked"], "blocked.txt", {
            type: "text/plain",
          }),
          signal: new AbortController().signal,
        },
        vi.fn(),
      ),
    ).rejects.toThrow("rejected during validation");
    await provider.forceFlush();

    const validation = span("attachment.validation.wait");
    expect(validation.attributes["thechat.attachment.outcome"]).toBe(
      "rejected",
    );
    expect(validation.status.code).toBe(SpanStatusCode.UNSET);
    expect(validation.events).toHaveLength(0);
  });

  it("marks transfer failures as errors without exporting raw exception text", async () => {
    apiMocks.downloadAttachment.mockResolvedValue({
      data: {
        url: "https://storage.invalid/download?token=never-export",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      error: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          "https://storage.invalid/private-report.txt?token=never-export",
        );
      }),
    );
    stubBlobLaunch();

    await expect(
      openSharedAttachmentDownload("attachment-1", "token-1"),
    ).rejects.toThrow();
    await provider.forceFlush();

    const transfer = span("attachment.s3.download");
    expect(transfer.status.code).toBe(SpanStatusCode.ERROR);
    expect(transfer.attributes["thechat.attachment.outcome"]).toBe(
      "transfer_failed",
    );
    expect(transfer.events).toHaveLength(1);
    expect(span("attachment.download").events).toHaveLength(0);
    expect(exceptionEventCount()).toBe(1);
    expect(telemetryText()).not.toMatch(
      /private-report|never-export|storage\.invalid/i,
    );
  });

  it("records non-2xx object responses as transfer failures", async () => {
    mockDownloadAuthorization();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 })),
    );
    stubBlobLaunch();

    await expect(
      openSharedAttachmentDownload("attachment-1", "token-1"),
    ).rejects.toThrow();
    await provider.forceFlush();

    const transfer = span("attachment.s3.download");
    expect(transfer.status.code).toBe(SpanStatusCode.ERROR);
    expect(transfer.attributes["http.response.status_code"]).toBe(403);
    expect(transfer.attributes["thechat.attachment.outcome"]).toBe(
      "transfer_failed",
    );
  });

  it("records response body-read failures inside the object transfer span", async () => {
    mockDownloadAuthorization();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            blob: vi.fn(async () => {
              throw new Error(
                "https://storage.invalid/private-report.txt?token=never-export",
              );
            }),
          }) as unknown as Response,
      ),
    );
    stubBlobLaunch();

    await expect(
      openSharedAttachmentDownload("attachment-1", "token-1"),
    ).rejects.toThrow();
    await provider.forceFlush();

    const transfer = span("attachment.s3.download");
    expect(transfer.status.code).toBe(SpanStatusCode.ERROR);
    expect(transfer.attributes["http.response.status_code"]).toBe(200);
    expect(transfer.attributes["thechat.attachment.outcome"]).toBe(
      "transfer_failed",
    );
    expect(telemetryText()).not.toMatch(
      /private-report|never-export|storage\.invalid/i,
    );
  });

  it("distinguishes local launch failure after a successful byte transfer", async () => {
    mockDownloadAuthorization();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("downloaded bytes", { status: 200 })),
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => {
        throw new Error("local launcher failed for private-report.txt");
      }),
    });

    await expect(
      openSharedAttachmentDownload(
        "attachment-1",
        "token-1",
        "attachment",
        "private-report.txt",
      ),
    ).rejects.toThrow();
    await provider.forceFlush();

    expectClientSpan("attachment.s3.download", "downloaded");
    const download = span("attachment.download");
    expect(download.status.code).toBe(SpanStatusCode.ERROR);
    expect(download.attributes["thechat.attachment.outcome"]).toBe(
      "launch_failed",
    );
    expect(download.attributes["thechat.attachment.transfer_observed"]).toBe(
      true,
    );
    expect(download.events.map((event) => event.name)).toEqual([
      "attachment.download.transfer_completed",
      "exception",
    ]);
    expect(exceptionEventCount()).toBe(1);
    expect(telemetryText()).not.toMatch(/private-report|launcher failed/i);
  });
});

function attachment(status: "pending_upload" | "processing" | "ready") {
  return {
    id: "attachment-1",
    fileName: "private-report.txt",
    name: "private-report.txt",
    mediaType: "text/plain",
    mimeType: "text/plain",
    sizeBytes: 6,
    kind: "file" as const,
    status,
    contentPath: "/attachments/attachment-1/content",
  };
}

function uploadInput() {
  return {
    conversationId: "conversation-1",
    token: "token-1",
    file: new File(["secret"], "private-report.txt", {
      type: "text/plain",
    }),
    signal: new AbortController().signal,
  };
}

function mockReservation() {
  apiMocks.reserveAttachment.mockResolvedValue({
    data: {
      attachment: attachment("pending_upload"),
      upload: {
        method: "PUT",
        url: "https://storage.invalid/upload?token=never-export",
        headers: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    error: null,
  });
}

function mockDownloadAuthorization() {
  apiMocks.downloadAttachment.mockResolvedValue({
    data: {
      url: "https://storage.invalid/download?token=never-export",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    error: null,
  });
}

class SuccessfulXmlHttpRequest {
  status = 200;
  upload: { onprogress?: (event: ProgressEvent) => void } = {};
  onerror?: () => void;
  onabort?: () => void;
  onload?: () => void;

  open() {}
  setRequestHeader() {}
  abort() {
    this.onabort?.();
  }
  send() {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded: 6,
      total: 6,
    } as ProgressEvent);
    queueMicrotask(() => this.onload?.());
  }
}

function stubBlobLaunch() {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:thechat-attachment"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
}

function expectClientSpan(name: string, outcome: string) {
  const item = span(name);
  expect(item.kind).toBe(SpanKind.CLIENT);
  expect(item.status.code).toBe(SpanStatusCode.UNSET);
  expect(item.attributes["thechat.attachment.outcome"]).toBe(outcome);
  expect(item.attributes["http.response.status_code"]).toBe(200);
}

function expectDirectParent(parentName: string, childName: string) {
  const parent = span(parentName);
  const child = span(childName);
  expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
  expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
}

function expectInjectedTraceparent(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  optionsArgumentIndex: number,
  requestSpanName: string,
) {
  const options = mock.mock.calls[0]?.[optionsArgumentIndex] as
    | { headers?: Record<string, string> }
    | undefined;
  const traceparent = options?.headers?.traceparent;
  expect(traceparent).toMatch(
    /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
  );
  expect(traceparent).toContain(`-${span(requestSpanName).spanContext().spanId}-`);
}

function span(name: string) {
  const matches = exporter
    .getFinishedSpans()
    .filter((item) => item.name === name);
  expect(matches, `expected exactly one ${name} span`).toHaveLength(1);
  return matches[0]!;
}

function exceptionEventCount() {
  return exporter
    .getFinishedSpans()
    .flatMap((item) => item.events)
    .filter((event) => event.name === "exception").length;
}

function telemetryText() {
  return JSON.stringify(
    exporter.getFinishedSpans().map((item) => ({
      name: item.name,
      attributes: item.attributes,
      events: item.events,
      status: item.status,
    })),
  );
}
