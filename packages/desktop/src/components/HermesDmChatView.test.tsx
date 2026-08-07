import { describe, expect, it, beforeAll, beforeEach, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  ChatMessage,
} from "@thechat/shared";
import { HermesDmChatView } from "./HermesDmChatView";
import { selectHermesConversationProgress } from "../lib/hermes-progress";
import { useHermesApprovalsStore } from "../stores/hermes-approvals";
import { useHermesClarificationsStore } from "../stores/hermes-clarifications";
import {
  cancelSharedAttachment,
  uploadSharedAttachment,
} from "../lib/shared-attachments";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  onDragDropEvent: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: tauriMocks.onDragDropEvent,
  }),
}));

vi.mock("../lib/shared-attachments", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../lib/shared-attachments")>();
  return {
    ...original,
    uploadSharedAttachment: vi.fn(),
    cancelSharedAttachment: vi.fn(() => Promise.resolve()),
  };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

let scrollToMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useHermesApprovalsStore.getState().resetForTests();
  useHermesClarificationsStore.getState().resetForTests();
  vi.mocked(uploadSharedAttachment).mockReset();
  vi.mocked(cancelSharedAttachment).mockReset();
  vi.mocked(cancelSharedAttachment).mockResolvedValue();
  tauriMocks.invoke.mockReset();
  tauriMocks.onDragDropEvent.mockReset();
  tauriMocks.unlisten.mockReset();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  vi.mocked(Element.prototype.scrollIntoView).mockClear();
  scrollToMock = vi.fn(function scrollTo(
    this: Element,
    options?: ScrollToOptions | number,
    y?: number,
  ) {
    const top = typeof options === "object" ? options.top : y;
    if (typeof top === "number") {
      this.scrollTop = top;
    }
  });
  Element.prototype.scrollTo =
    scrollToMock as unknown as typeof Element.prototype.scrollTo;
});

describe("HermesDmChatView", () => {
  it("hides the generic typing indicator while Hermes progress is active", () => {
    render(
      <HermesDmChatView
        messages={[]}
        loading={false}
        typingUsers={new Map([["bot-user-1", "Koda"]])}
        progressInvocations={[{ invocation: invocation({ status: "running" }), events: [] }]}
        typingSuppressedUserIds={[]}
        onSend={() => {}}
      />,
    );

    expect(screen.getByText("Koda is working")).toBeInTheDocument();
    expect(screen.queryByText("Koda is typing...")).toBeNull();
  });

  it("accepts native file drops anywhere in a Hermes workspace DM", async () => {
    const attachment = {
      id: "attachment-1",
      fileName: "workspace-note.txt",
      name: "workspace-note.txt",
      mediaType: "text/plain",
      mimeType: "text/plain",
      sizeBytes: 9,
      kind: "file" as const,
      status: "ready" as const,
      contentPath: "/attachments/attachment-1/content",
    };
    vi.mocked(uploadSharedAttachment).mockImplementation(
      async (_input, update) => {
        update({ phase: "ready", progress: 100, attachment });
        return attachment;
      },
    );
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const droppedPath = "C:\\Users\\Bruno\\workspace-note.txt";
    tauriMocks.invoke.mockResolvedValue(
      new TextEncoder().encode("workspace").buffer,
    );
    type NativeDropHandler = (event: {
      payload:
        | { type: "enter"; paths: string[] }
        | { type: "drop"; paths: string[] };
    }) => void | Promise<void>;
    let nativeDropHandler: NativeDropHandler | undefined;
    tauriMocks.onDragDropEvent.mockImplementation(
      async (handler: NativeDropHandler) => {
        nativeDropHandler = handler;
        return tauriMocks.unlisten;
      },
    );

    const onSend = vi.fn(() => true);
    const { container } = render(
      <HermesDmChatView
        messages={[]}
        loading={false}
        typingUsers={new Map()}
        progressInvocations={[]}
        typingSuppressedUserIds={[]}
        onSend={onSend}
        conversationId="conversation-1"
        token="token-1"
      />,
    );
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    if (!fileInput?.parentElement) throw new Error("File drop zone not found");
    const dropZone = fileInput.parentElement;
    await waitFor(() => expect(nativeDropHandler).toBeDefined());

    await act(async () => {
      await nativeDropHandler?.({
        payload: { type: "enter", paths: [droppedPath] },
      });
    });
    expect(dropZone).toHaveClass("border-accent");
    await act(async () => {
      await nativeDropHandler?.({
        payload: { type: "drop", paths: [droppedPath] },
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("attachment-draft")).toHaveAttribute(
        "data-attachment-phase",
        "ready",
      ),
    );
    expect(tauriMocks.invoke).toHaveBeenCalledWith("read_dropped_file", {
      filePath: droppedPath,
    });
    const uploadInput = vi.mocked(uploadSharedAttachment).mock.calls[0][0];
    expect(uploadInput).toMatchObject({
      conversationId: "conversation-1",
      token: "token-1",
    });
    expect(uploadInput.file.name).toBe("workspace-note.txt");
    expect(uploadInput.file.type).toBe("text/plain");
    expect(uploadInput.file.size).toBe(9);

    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("", ["attachment-1"]),
    );
  });

  it("shows typing before mounting the progress UI", () => {
    const baseProps = {
      messages: [],
      loading: false,
      typingUsers: new Map([["bot-user-1", "Koda"]]),
      onSend: () => {},
    };
    const queued = selectHermesConversationProgress({
      invocations: [invocation({ status: "queued" })],
      events: [],
    });
    const { rerender } = render(
      <HermesDmChatView
        {...baseProps}
        progressInvocations={queued.invocations}
        typingSuppressedUserIds={queued.typingSuppressedUserIds}
      />,
    );

    expect(screen.getByText("Koda is typing...")).toBeInTheDocument();
    expect(screen.queryByText("Koda is queued")).toBeNull();
    expect(screen.queryByText("Koda is working")).toBeNull();

    const active = selectHermesConversationProgress({
      invocations: [invocation({ status: "running" })],
      events: [progressEvent()],
    });

    rerender(
      <HermesDmChatView
        {...baseProps}
        progressInvocations={active.invocations}
        typingSuppressedUserIds={active.typingSuppressedUserIds}
      />,
    );

    expect(screen.getByText("Koda is working")).toBeInTheDocument();
    expect(screen.queryByText("Koda is typing...")).toBeNull();
  });

  it("defers markdown formatting for large Hermes histories", () => {
    vi.useFakeTimers();
    const messages = Array.from({ length: 41 }, (_, index) =>
      message({
        id: `message-${index}`,
        content: `$$x_${index}^2 + y_${index}^2 = z_${index}^2$$`,
      }),
    );

    const { container, unmount } = render(
      <HermesDmChatView
        messages={messages}
        loading={false}
        typingUsers={new Map()}
        progressInvocations={[]}
        typingSuppressedUserIds={[]}
        onSend={() => {}}
        scrollKey="conversation-1:general"
      />,
    );

    try {
      expect(screen.getByRole("status")).toHaveTextContent("Formatting message history...");
      expect(container.querySelector(".katex")).toBeNull();
      expect(screen.getByText("$$x_40^2 + y_40^2 = z_40^2$$")).toBeInTheDocument();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("can suppress generic typing even when visible progress is scoped out", () => {
    render(
      <HermesDmChatView
        messages={[]}
        loading={false}
        typingUsers={new Map([["bot-user-1", "Koda"]])}
        progressInvocations={[]}
        typingSuppressedUserIds={["bot-user-1"]}
        onSend={() => {}}
      />,
    );

    expect(screen.queryByText("Koda is typing...")).toBeNull();
  });

  it("routes approval buttons directly without sending a slash message", async () => {
    const onSend = vi.fn();
    const onInteraction = vi.fn().mockResolvedValue(undefined);
    const approval = progressEvent({
      id: "approval-1",
      type: "approval.request",
      status: "waiting",
      toolCallId: null,
      toolName: null,
      label: "Command approval required",
      preview: "rm -rf /important",
      payload: {
        requestId: "approval-request-1",
        sessionKey: "session-1",
        command: "rm -rf /important",
        description: "recursive delete",
        choices: ["once", "deny"],
      },
    });
    render(
      <HermesDmChatView
        messages={[]}
        loading={false}
        typingUsers={new Map()}
        progressInvocations={[
          {
            invocation: invocation({ status: "running" }),
            events: [approval],
          },
        ]}
        typingSuppressedUserIds={[]}
        onSend={onSend}
        onInteraction={onInteraction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(onInteraction).toHaveBeenCalledWith(approval, "once"),
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not jump for Hermes progress props with unchanged visible content", () => {
    const activeInvocation = invocation({ updatedAt: "2026-01-01T00:00:00.000Z" });
    const activeEvent = progressEvent({
      id: "event-active-1",
      invocationId: activeInvocation.id,
      label: "Reading files",
    });
    const firstMessage = message();
    const props = {
      messages: [firstMessage],
      loading: false,
      typingUsers: new Map<string, string>(),
      typingSuppressedUserIds: [],
      onSend: () => {},
    };

    const { rerender } = render(
      <HermesDmChatView
        {...props}
        progressInvocations={[{ invocation: activeInvocation, events: [activeEvent] }]}
      />,
    );
    const scroller = screen.getByTestId("hermes-dm-chat-scroll");
    makeScrollable(scroller);
    fireEvent.wheel(scroller, { deltaY: -80 });
    fireEvent.scroll(scroller);
    scrollToMock.mockClear();

    rerender(
      <HermesDmChatView
        {...props}
        progressInvocations={[
          { invocation: { ...activeInvocation }, events: [{ ...activeEvent }] },
        ]}
      />,
    );

    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("leaves scroll position alone when visible Hermes progress updates after the user scrolls up", () => {
    const activeInvocation = invocation({ updatedAt: "2026-01-01T00:00:00.000Z" });
    const firstMessage = message();
    const props = {
      messages: [firstMessage],
      loading: false,
      typingUsers: new Map<string, string>(),
      typingSuppressedUserIds: [],
      onSend: () => {},
    };

    const { rerender } = render(
      <HermesDmChatView
        {...props}
        progressInvocations={[
          {
            invocation: activeInvocation,
            events: [
              progressEvent({
                id: "event-active-1",
                invocationId: activeInvocation.id,
                label: "Reading files",
              }),
            ],
          },
        ]}
      />,
    );
    const scroller = screen.getByTestId("hermes-dm-chat-scroll");
    makeScrollable(scroller);
    fireEvent.wheel(scroller, { deltaY: -80 });
    fireEvent.scroll(scroller);
    scrollToMock.mockClear();

    rerender(
      <HermesDmChatView
        {...props}
        progressInvocations={[
          {
            invocation: activeInvocation,
            events: [
              progressEvent({
                id: "event-active-1",
                invocationId: activeInvocation.id,
                label: "Reading files",
              }),
              progressEvent({
                id: "event-active-2",
                invocationId: activeInvocation.id,
                label: "Running command",
                sequence: 2,
              }),
            ],
          },
        ]}
      />,
    );

    expect(scrollToMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /jump to bottom/i })).toBeInTheDocument();
  });

  it("loads older messages when the user scrolls near the top", async () => {
    const onLoadOlderMessages = vi.fn(() => Promise.resolve());
    render(
      <HermesDmChatView
        messages={[message()]}
        loading={false}
        hasOlderMessages
        typingUsers={new Map()}
        progressInvocations={[]}
        typingSuppressedUserIds={[]}
        onSend={() => {}}
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    );
    const scroller = screen.getByTestId("hermes-dm-chat-scroll");
    makeScrollable(scroller);
    scroller.scrollTop = 0;

    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
    });
  });
});

function makeScrollable(element: HTMLElement) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: 300,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    writable: true,
    value: 200,
  });
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    threadId: null,
    senderId: "bot-user-1",
    senderName: "Koda",
    senderType: "bot",
    content: "Message content",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function invocation(
  overrides: Partial<BotInvocationPublic> = {},
): BotInvocationPublic {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "invocation-1",
    botId: "bot-1",
    botUserId: "bot-user-1",
    botName: "Koda",
    botKind: "hermes",
    conversationId: "conversation-1",
    threadId: null,
    triggerMessageId: "message-1",
    responseMessageId: null,
    adapterKind: "hermes",
    status: "running",
    externalRunId: null,
    requestJson: null,
    responseJson: null,
    error: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function progressEvent(
  overrides: Partial<BotInvocationProgressEventPublic> = {},
): BotInvocationProgressEventPublic {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "event-1",
    invocationId: "invocation-1",
    botId: "bot-1",
    conversationId: "conversation-1",
    threadId: null,
    sequence: 1,
    type: "tool.running",
    status: "running",
    toolCallId: null,
    toolName: null,
    label: "Working",
    preview: null,
    payload: null,
    occurredAt: now,
    createdAt: now,
    ...overrides,
  };
}
