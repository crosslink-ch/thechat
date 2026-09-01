import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcpPermissionRequest,
  AppConfig,
  Conversation,
} from "@thechat/shared";
import { ChatHeader, setAgentChatHeaderContext } from "../components/ChatHeader";
import { usePermissionModeStore } from "../stores/permission-mode";
import {
  composerDraftKey,
  useComposerDraftsStore,
} from "../stores/composer-drafts";

const { invokeMock, useAcpChatMock, inputProps } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  useAcpChatMock: vi.fn(),
  inputProps: { current: null as Record<string, unknown> | null },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../hooks/useAcpChat", () => ({ useAcpChat: useAcpChatMock }));
vi.mock("../components/InputBar", async () => {
  const React = await import("react");
  return {
    InputBar: (props: Record<string, unknown>) => {
      inputProps.current = props;
      const [initialDraftKey] = React.useState(String(props.draftKey));
      return React.createElement(
        "div",
        {
          "data-testid": "acp-input",
          "data-initial-draft-key": initialDraftKey,
          "data-current-draft-key": String(props.draftKey),
        },
        props.disabledReason
          ? React.createElement("span", null, String(props.disabledReason))
          : null,
        React.createElement(
          "button",
          {
            type: "button",
            disabled: Boolean(props.disabled),
            onClick: () =>
              (props.onSend as (content: string) => Promise<boolean>)("hello ACP"),
          },
          "Test send",
        ),
        props.isStreamingOverride
          ? React.createElement(
              "button",
              { type: "button", onClick: props.onStop as () => void },
              "Test stop",
            )
          : null,
      );
    },
  };
});

import { AgentChatRoute } from "./agent-chat";

const profiles: AppConfig["acpProfiles"] = [
  {
    id: "profile-codex",
    name: "Codex",
    executable: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.7.0"],
    inheritEnv: [],
  },
  {
    id: "profile-opencode",
    name: "OpenCode",
    executable: "opencode",
    args: ["acp"],
    inheritEnv: ["PATH"],
  },
];

const config: AppConfig = {
  api_key: "",
  providers: {
    openrouter: { model: "model" },
    codex: { model: "model" },
    glm: { model: "model" },
    featherless: { model: "model" },
  },
  acpProfiles: profiles,
  defaultAcpProfileId: "profile-codex",
};

const existingConversation: Conversation = {
  id: "conversation-1",
  title: "Existing ACP chat",
  project_dir: "/workspace/project",
  agent_profile_id: "profile-opencode",
  created_at: "2026-08-31T10:00:00Z",
  updated_at: "2026-08-31T10:00:00Z",
};

function hookResult(overrides: Record<string, unknown> = {}) {
  return {
    conversation: null,
    messages: [],
    loadingMessages: false,
    loadingOlderMessages: false,
    hasOlderMessages: false,
    error: null,
    isBusy: false,
    capabilities: null,
    status: "idle",
    pendingPermission: null,
    sendMessage: vi.fn().mockResolvedValue(true),
    stopStreaming: vi.fn().mockResolvedValue(undefined),
    respondToPermission: vi.fn().mockResolvedValue(true),
    loadConversation: vi.fn().mockResolvedValue(undefined),
    loadOlderMessages: vi.fn().mockResolvedValue(undefined),
    startNewConversation: vi.fn(),
    ...overrides,
  };
}

async function renderRoute(initialEntry: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <ChatHeader />
        <Outlet />
      </>
    ),
  });
  const chatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat",
    component: AgentChatRoute,
    validateSearch: (search: Record<string, unknown>) => ({
      projectDir:
        typeof search.projectDir === "string" ? search.projectDir : undefined,
    }),
  });
  const chatIdRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat/$id",
    component: AgentChatRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([chatRoute, chatIdRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  await act(async () => {
    render(<RouterProvider router={router as never} />);
  });
  return router;
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "get_config") return structuredClone(config);
    if (command === "get_conversation") return existingConversation;
    if (command === "list_conversations") return [];
    throw new Error(`Unexpected command ${command}`);
  });
  useAcpChatMock.mockReset();
  useAcpChatMock.mockReturnValue(hookResult());
  inputProps.current = null;
  useComposerDraftsStore.setState({
    drafts: {},
    revisions: {},
    imageDrafts: {},
    attachmentDrafts: {},
    sendingAttachments: {},
  });
  usePermissionModeStore.setState({ mode: "allow-edits" });
  setAgentChatHeaderContext(null);
});

afterEach(() => {
  cleanup();
  setAgentChatHeaderContext(null);
});

describe("AgentChatRoute ACP integration", () => {
  it("selects the configured default and supplies an ACP-only prompt contract", async () => {
    await renderRoute("/chat?projectDir=%2Fworkspace%2Fproject");

    await waitFor(() =>
      expect(useAcpChatMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          profileId: "profile-codex",
          projectDir: "/workspace/project",
          permissionMode: "allow-edits",
          profileAvailable: true,
        }),
      ),
    );
    for (const picker of screen.getAllByRole("combobox", {
      name: "Agent profile",
    })) {
      expect(picker).toHaveValue("profile-codex");
    }
    expect(inputProps.current).toMatchObject({
      allowQueueWhileStreaming: false,
      allowImages: false,
      disabled: false,
    });
    expect(invokeMock).not.toHaveBeenCalledWith("start_mcp_server", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("check_codex_cli");
  });

  it("remounts the composer when a new conversation is promoted to its persisted route", async () => {
    useAcpChatMock.mockReturnValue(
      hookResult({ conversation: existingConversation, isBusy: false }),
    );
    const router = await renderRoute("/chat?projectDir=%2Fworkspace%2Fproject");

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/chat/conversation-1"),
    );
    const input = screen.getByTestId("acp-input");
    expect(input).toHaveAttribute("data-current-draft-key", "agent:conversation-1");
    expect(input).toHaveAttribute("data-initial-draft-key", "agent:conversation-1");
  });

  it("clears the promoted draft after a successful first send", async () => {
    let currentConversation: Conversation | null = null;
    const sendMessage = vi.fn().mockResolvedValue(true);
    useAcpChatMock.mockImplementation(() =>
      hookResult({ conversation: currentConversation, sendMessage }),
    );
    useComposerDraftsStore
      .getState()
      .setDraft(composerDraftKey.agent(undefined), "first ACP turn");
    const router = await renderRoute("/chat?projectDir=%2Frepo");

    await waitFor(() => expect(inputProps.current).not.toBeNull());
    const onSend = inputProps.current?.onSend as (
      content: string,
    ) => Promise<boolean>;
    await act(async () => {
      expect(await onSend("first ACP turn")).toBe(true);
    });
    currentConversation = existingConversation;
    act(() => {
      usePermissionModeStore.setState({ mode: "request" });
    });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/chat/conversation-1"),
    );
    expect(
      useComposerDraftsStore.getState().drafts[composerDraftKey.agent(undefined)],
    ).toBeUndefined();
    expect(
      useComposerDraftsStore.getState().drafts[
        composerDraftKey.agent("conversation-1")
      ],
    ).toBeUndefined();
  });

  it("preserves a newer provisional draft when an older turn completes in the background", async () => {
    let currentConversation: Conversation | null = null;
    let resolveSend!: (accepted: boolean) => void;
    const sendMessage = vi.fn(
      () => new Promise<boolean>((resolve) => {
        resolveSend = resolve;
      }),
    );
    useAcpChatMock.mockImplementation(() =>
      hookResult({ conversation: currentConversation, sendMessage }),
    );
    const router = await renderRoute("/chat?projectDir=%2Fworkspace%2Fproject");
    const provisionalKey = composerDraftKey.agent(undefined);
    const durableKey = composerDraftKey.agent("conversation-1");
    useComposerDraftsStore.getState().setDraft(provisionalKey, "submitted text");
    const onSend = inputProps.current?.onSend as (content: string) => Promise<boolean>;
    let pendingSend!: Promise<boolean>;
    act(() => {
      pendingSend = onSend("submitted text");
    });
    useComposerDraftsStore.getState().setDraft(provisionalKey, "newer draft");

    await act(async () => {
      resolveSend(true);
      expect(await pendingSend).toBe(true);
    });
    currentConversation = existingConversation;
    act(() => {
      usePermissionModeStore.getState().setMode("bypass");
    });

    await waitFor(() => expect(router.state.location.pathname).toBe("/chat/conversation-1"));
    expect(useComposerDraftsStore.getState().drafts[durableKey]).toBe("newer draft");
  });

  it("locks existing conversations to their persisted ACP profile and project", async () => {
    const result = hookResult({ conversation: existingConversation });
    useAcpChatMock.mockReturnValue(result);
    await renderRoute("/chat/conversation-1");

    await waitFor(() =>
      expect(result.loadConversation).toHaveBeenCalledWith(existingConversation),
    );
    expect(screen.getByRole("combobox", { name: "Agent profile" })).toHaveValue(
      "profile-opencode",
    );
    expect(screen.getByRole("combobox", { name: "Agent profile" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Project: /workspace/project" }),
    ).toBeDisabled();
    expect(useAcpChatMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profileId: "profile-opencode",
        projectDir: "/workspace/project",
      }),
    );
  });

  it("keeps a deleted bound profile visible and refuses to silently fall back", async () => {
    const missingProfileConversation = {
      ...existingConversation,
      agent_profile_id: "deleted-profile",
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_config") return structuredClone(config);
      if (command === "get_conversation") return missingProfileConversation;
      throw new Error(`Unexpected command ${command}`);
    });
    const result = hookResult({ conversation: missingProfileConversation });
    useAcpChatMock.mockReturnValue(result);

    await renderRoute("/chat/conversation-1");

    expect(
      await screen.findByText(/profile deleted-profile is unavailable/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Agent profile" })).toHaveValue(
      "deleted-profile",
    );
    expect(inputProps.current).toMatchObject({ disabled: true });
    expect(useAcpChatMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profileId: "deleted-profile",
        profileAvailable: false,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Test send" }));
    expect(result.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects hidden legacy conversations that have no ACP metadata", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_config") return structuredClone(config);
      if (command === "get_conversation") {
        return { ...existingConversation, agent_profile_id: null };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    await renderRoute("/chat/conversation-1");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /legacy conversation is not an ACP session/i,
    );
    expect(inputProps.current).toMatchObject({ disabled: true });
  });

  it("renders exact ACP permission choices and returns the selected option ID", async () => {
    const pendingPermission: AcpPermissionRequest = {
      id: "permission-1",
      title: "Approve adapter action?",
      options: [
        {
          id: "custom-choice",
          kind: "allow_once",
          label: "Ask the team",
        },
      ],
    };
    const result = hookResult({
      conversation: existingConversation,
      isBusy: true,
      status: "awaiting_permission",
      pendingPermission,
      capabilities: { loadSession: true, modes: true },
    });
    useAcpChatMock.mockReturnValue(result);

    await renderRoute("/chat/conversation-1");
    await waitFor(() => expect(result.loadConversation).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ask the team" }));
      await Promise.resolve();
    });

    expect(result.respondToPermission).toHaveBeenCalledWith("custom-choice");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Awaiting Permission")).toBeInTheDocument();
    expect(screen.getByText("Session resume")).toBeInTheDocument();
    expect(screen.getByText("Modes")).toBeInTheDocument();
  });

  it("shows stop-only busy state and surfaces hook errors without queueing", async () => {
    const result = hookResult({
      conversation: existingConversation,
      isBusy: true,
      status: "running",
      error: { message: "Adapter exited", code: "adapter_exit", retryable: true },
    });
    useAcpChatMock.mockReturnValue(result);

    await renderRoute("/chat/conversation-1");

    expect(await screen.findByRole("alert")).toHaveTextContent("Adapter exited");
    expect(inputProps.current).toMatchObject({
      isStreamingOverride: true,
      allowQueueWhileStreaming: false,
      allowImages: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Test stop" }));
    expect(result.stopStreaming).toHaveBeenCalledOnce();
  });

  it("enables image input only when the connected adapter advertises it", async () => {
    useAcpChatMock.mockReturnValue(
      hookResult({
        conversation: existingConversation,
        capabilities: { prompt: { image: true, audio: false, embeddedContext: false } },
      }),
    );

    await renderRoute("/chat/conversation-1");

    await waitFor(() => expect(inputProps.current?.allowImages).toBe(true));
    expect(inputProps.current).toMatchObject({ allowQueueWhileStreaming: false });
  });
});
