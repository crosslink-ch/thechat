import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
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
import type { ChatMessage } from "@thechat/shared";

const apiMocks = vi.hoisted(() => ({
  messages: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: { messages: apiMocks.messages },
}));

import { setDesktopTracerForTests } from "../lib/telemetry";
import { useChannelChat } from "./useChannelChat";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  setDesktopTracerForTests(provider.getTracer("desktop-message-test"));
});

beforeEach(() => {
  exporter.reset();
  apiMocks.messages.mockReset();
  apiMocks.get.mockReset();
  apiMocks.post.mockReset();
  apiMocks.get.mockResolvedValue({ data: [], error: null });
  apiMocks.messages.mockReturnValue({
    get: apiMocks.get,
    post: apiMocks.post,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  setDesktopTracerForTests(null);
  await provider.shutdown();
});

describe("message send telemetry", () => {
  it("injects its carrier and records a successful REST command without payloads", async () => {
    apiMocks.post.mockResolvedValue({
      data: message("server-message-1", "hello"),
      error: null,
    });
    const wsSendMessage = vi.fn();
    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "conversation-1",
          token: "private-token",
          wsSendMessage,
          selfUser: selfUser(),
        }),
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    let completion: unknown;
    act(() => {
      completion = result.current.sendMessage("hello", ["attachment-1"]);
    });
    await act(async () => {
      await completion;
    });
    await provider.forceFlush();

    const request = exactlyOneSpan("message.send.request");
    expect(request.kind).toBe(SpanKind.CLIENT);
    expect(request.status.code).toBe(SpanStatusCode.UNSET);
    expect(request.attributes["thechat.message.outcome"]).toBe("sent");
    expect(request.attributes["http.response.status_code"]).toBe(200);
    expect(request.attributes["thechat.message.attachment_count"]).toBe(1);
    const options = apiMocks.post.mock.calls[0]?.[1] as {
      headers?: Record<string, string>;
    };
    expect(options.headers?.traceparent).toContain(
      `-${request.spanContext().spanId}-`,
    );
    expect(wsSendMessage).not.toHaveBeenCalled();
    expect(telemetryText()).not.toMatch(
      /private-token|attachment-1|hello|authorization|request.body/i,
    );
  });

  it("keeps an ambiguous failure sanitized and reuses the command id on retry", async () => {
    apiMocks.post
      .mockRejectedValueOnce(
        new Error("postgres://secret:password@db.invalid/thechat"),
      )
      .mockResolvedValueOnce({
        data: message("server-message-2", "retry me"),
        error: null,
      });
    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "conversation-1",
          token: "private-token",
          wsSendMessage: vi.fn(),
          selfUser: selfUser(),
        }),
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    let failed: unknown;
    act(() => {
      failed = result.current.sendMessage("retry me", ["attachment-1"]);
    });
    await act(async () => {
      await failed;
    });
    let retried: unknown;
    act(() => {
      retried = result.current.sendMessage("retry me", ["attachment-1"]);
    });
    await act(async () => {
      await retried;
    });
    await provider.forceFlush();

    const requests = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "message.send.request")
      .sort((left, right) => left.startTime[1] - right.startTime[1]);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(requests[0]!.attributes["thechat.message.outcome"]).toBe("failed");
    expect(requests[0]!.events).toHaveLength(1);
    expect(requests[0]!.events[0]!.attributes).toEqual(
      expect.objectContaining({ "exception.message": "operation_failed" }),
    );
    expect(requests[1]!.status.code).toBe(SpanStatusCode.UNSET);
    expect(requests[1]!.attributes["thechat.message.outcome"]).toBe("sent");
    expect(apiMocks.post.mock.calls[0]![0].clientMessageId).toBe(
      apiMocks.post.mock.calls[1]![0].clientMessageId,
    );
    expect(telemetryText()).not.toMatch(
      /secret|password|db\.invalid|private-token|attachment-1|retry me/i,
    );
  });
});

function createQueryWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function selfUser() {
  return {
    id: "sender-1",
    name: "Sender",
    email: "sender@example.invalid",
    avatar: null,
    type: "human" as const,
  };
}

function message(id: string, content: string): ChatMessage {
  return {
    id,
    conversationId: "conversation-1",
    threadId: null,
    senderId: "sender-1",
    senderName: "Sender",
    senderType: "human",
    content,
    parts: null,
    attachments: [],
    createdAt: new Date().toISOString(),
  };
}

function exactlyOneSpan(name: string): ReadableSpan {
  const matches = exporter.getFinishedSpans().filter((span) => span.name === name);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function telemetryText() {
  return JSON.stringify(
    exporter.getFinishedSpans().map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
      status: span.status,
    })),
  );
}
