import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
} from "@thechat/shared";
import { botRuntimeQueryKey } from "../hooks/useBotRuntime";
import { wsEvents } from "../lib/ws-events";
import { useAuthStore } from "../stores/auth";
import { useHermesApprovalsStore } from "../stores/hermes-approvals";
import { useHermesIndicatorsStore } from "../stores/hermes-indicators";
import { createTestQueryClient } from "../test-utils/query";

const routeMocks = vi.hoisted(() => ({
  createThread: vi.fn(),
  renameThread: vi.fn(),
  touchThread: vi.fn(),
  loadMoreThreads: vi.fn(),
  sendMessage: vi.fn(),
  addMessage: vi.fn(),
  addOptimisticSentMessage: vi.fn(),
}));

vi.mock("../hooks/useConversationDetail", () => ({
  useConversationDetail: () => ({
    data: {
      id: "conversation-1",
      type: "direct",
      workspaceId: "workspace-1",
      name: null,
      title: null,
      participants: [
        {
          userId: "user-1",
          role: "member",
          joinedAt: "2026-01-01T00:00:00.000Z",
          user: {
            id: "user-1",
            name: "Current user",
            email: "user@example.com",
            avatar: null,
            type: "human",
          },
          bot: null,
        },
        {
          userId: "bot-user-1",
          role: "member",
          joinedAt: "2026-01-01T00:00:00.000Z",
          user: {
            id: "bot-user-1",
            name: "Koda",
            email: null,
            avatar: null,
            type: "bot",
          },
          bot: { id: "bot-1", kind: "hermes", commands: [] },
        },
      ],
    },
    isLoading: false,
    error: null,
  }),
}));

vi.mock("../hooks/useConversationThreads", () => ({
  useConversationThreads: () => ({
    threads: [
      {
        id: "thread-1",
        conversationId: "conversation-1",
        botId: "bot-1",
        title: "Route task",
        status: "active",
        createdById: "user-1",
        lastActivityAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    loading: false,
    loadingMore: false,
    hasMore: false,
    loadMore: routeMocks.loadMoreThreads,
    createThread: routeMocks.createThread,
    renameThread: routeMocks.renameThread,
    touchThread: routeMocks.touchThread,
  }),
}));

vi.mock("../hooks/useChannelChat", () => ({
  useChannelChat: () => ({
    messages: [],
    loading: false,
    loadingOlder: false,
    hasOlderMessages: false,
    sendError: null,
    sendMessage: routeMocks.sendMessage,
    addMessage: routeMocks.addMessage,
    addOptimisticSentMessage: routeMocks.addOptimisticSentMessage,
    loadOlderMessages: vi.fn(),
  }),
}));

vi.mock("../hooks/useScopedCommands", () => ({
  useScopedCommands: vi.fn(),
}));

vi.mock("../components/HermesDmChatView", () => ({
  HermesDmChatView: () => <div>Hermes chat</div>,
}));

vi.mock("../components/ChannelChatView", () => ({
  ChannelChatView: () => <div>Channel chat</div>,
}));

vi.mock("../CommandPalette", () => ({
  closePaletteAndRefocus: vi.fn(),
}));

import { DmRoute } from "./dm";

describe("DmRoute Hermes progress WebSocket handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      token: "token-1",
      loading: false,
      user: {
        id: "user-1",
        name: "Current user",
        email: "user@example.com",
        avatar: null,
        type: "human",
      },
    });
    useHermesApprovalsStore.getState().resetForTests();
    useHermesIndicatorsStore.getState().resetForTests();
  });

  it("forwards claimed progress metadata into the runtime cache and correct scopes", async () => {
    const client = createTestQueryClient();
    client.setQueryData<BotRuntimeSnapshot>(
      botRuntimeQueryKey("conversation-1"),
      runtime(),
    );
    const view = await renderDmRoute(client);

    await waitFor(() => {
      expect(screen.getByText("No active runs")).toBeInTheDocument();
    });

    act(() => {
      emitProgress(
        invocation({
          id: "task-invocation",
          threadId: "thread-1",
          requestJson: { text: "Claimed route task" },
        }),
        progressEvent({
          id: "task-progress",
          invocationId: "task-invocation",
          threadId: "thread-1",
        }),
      );
      emitProgress(
        invocation({
          id: "general-invocation",
          requestJson: { text: "Claimed General route work" },
        }),
        progressEvent({
          id: "general-progress",
          invocationId: "general-invocation",
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Claimed route task")).toBeInTheDocument();
      expect(screen.getByText("Claimed General route work")).toBeInTheDocument();
    });
    expect(within(
      screen.getByRole("button", { name: /Route task/ }),
    ).getByText("1")).toBeInTheDocument();
    expect(within(
      screen.getByRole("button", { name: /General\s*Inbox/ }),
    ).getByText("1")).toBeInTheDocument();
    expect(client.getQueryData<BotRuntimeSnapshot>(
      botRuntimeQueryKey("conversation-1"),
    )?.invocations.map((item) => item.id).sort()).toEqual([
      "general-invocation",
      "task-invocation",
    ]);

    view.unmount();
  });

  it("removes its progress listener on unmount", async () => {
    const client = createTestQueryClient();
    client.setQueryData<BotRuntimeSnapshot>(
      botRuntimeQueryKey("conversation-1"),
      runtime(),
    );
    const view = await renderDmRoute(client);

    view.unmount();
    act(() => {
      emitProgress(
        invocation({
          id: "late-invocation",
          requestJson: { text: "Late route event" },
        }),
        progressEvent({
          id: "late-progress",
          invocationId: "late-invocation",
        }),
      );
    });

    expect(client.getQueryData<BotRuntimeSnapshot>(
      botRuntimeQueryKey("conversation-1"),
    )).toEqual(runtime());
  });
});

async function renderDmRoute(client: ReturnType<typeof createTestQueryClient>) {
  const rootRoute = createRootRoute();
  const dmRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/dm/$id",
    component: DmRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([dmRoute]),
    history: createMemoryHistory({ initialEntries: ["/dm/conversation-1"] }),
  });

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as any} />
      </QueryClientProvider>,
    );
  });
  return view;
}

function emitProgress(
  invocationValue: BotInvocationPublic,
  event: BotInvocationProgressEventPublic,
) {
  wsEvents.emit("ws:bot_invocation_progress", {
    conversationId: invocationValue.conversationId,
    invocationId: invocationValue.id,
    event,
    invocation: invocationValue,
  });
}

function runtime(overrides: Partial<BotRuntimeSnapshot> = {}): BotRuntimeSnapshot {
  return {
    invocations: [],
    events: [],
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
    status: "claimed",
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
  const now = "2026-01-01T00:00:01.000Z";
  return {
    id: "progress-1",
    invocationId: "invocation-1",
    botId: "bot-1",
    conversationId: "conversation-1",
    threadId: null,
    sequence: 1,
    type: "tool.started",
    status: "running",
    toolCallId: "call-1",
    toolName: "shell",
    label: "Running command",
    preview: null,
    payload: null,
    occurredAt: now,
    createdAt: now,
    ...overrides,
  };
}
