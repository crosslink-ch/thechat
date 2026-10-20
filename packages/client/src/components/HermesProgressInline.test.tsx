import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotAppearance,
  BotRequestPublic,
  WorkspaceWithDetails,
} from "@thechat/shared";
import { HermesProgressInline } from "./HermesProgressInline";
import { useBotRequestsStore } from "../stores/bot-requests";
import { useHermesIndicatorsStore } from "../stores/hermes-indicators";
import { useWorkspacesStore } from "../stores/workspaces";

describe("HermesProgressInline", () => {
  beforeEach(() => {
    useWorkspacesStore.setState({ activeWorkspace: null });
    useBotRequestsStore.getState().reset();
    useHermesIndicatorsStore.getState().resetForTests();
  });

  it.each(["workspace switch", "mismatched-workspace deep link"])(
    "keeps the conversation's saved Minimal style across a %s", (scenario) => {
      const saved = new Map<string, BotAppearance>([
        ["bot-user-1", { shape: "minimal", color: "#00B894" }],
      ]);
      if (scenario === "workspace switch") {
        selectAppearance({ shape: "minimal", color: "#00B894" });
      }
      const { container } = render(<HermesProgressInline
        invocations={[{ invocation: invocation(), events: [] }]}
        botAppearances={saved}
      />);
      expect(screen.getByTestId("hermes-invocation-indicator").querySelector(".lucide-loader-circle")).not.toBeNull();
      act(() => useWorkspacesStore.setState({
        activeWorkspace: { id: "unrelated-workspace", members: [] } as unknown as WorkspaceWithDetails,
      }));
      expect(screen.getByTestId("hermes-invocation-indicator").querySelector(".lucide-loader-circle")).not.toBeNull();
      expect(container.querySelector("[data-bot-avatar]")).toBeNull();
    },
  );

  it("uses a conventional spinner for an explicitly selected Minimal running bot", () => {
    selectAppearance({ shape: "minimal", color: "#3498DB" });
    const onStop = vi.fn();
    const { container } = render(<HermesProgressInline
      invocations={[{ invocation: invocation(), events: [progressEvent({
        type: "reasoning.delta", toolName: null, toolCallId: null,
        payload: { text: "Plan the next step" },
      })] }]}
      onStop={onStop}
    />);
    const indicator = screen.getByTestId("hermes-invocation-indicator");
    expect(indicator.querySelector(".lucide-loader-circle")).not.toBeNull();
    expect(indicator.querySelector("svg")).toHaveClass("motion-safe:animate-spin");
    expect(container.querySelector("[data-bot-avatar], [data-bot-minimal]")).toBeNull();
    expect(container.querySelector('[data-thinking-orb="solving"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(screen.getByText("Koda is working")).toBeInTheDocument();
  });

  it("shows a static clock for a queued Minimal bot without Stop", () => {
    selectAppearance({ shape: "minimal", color: "#3498DB" });
    render(<HermesProgressInline
      invocations={[{ invocation: invocation({ status: "queued" }), events: [] }]}
      onStop={vi.fn()}
    />);
    const indicator = screen.getByTestId("hermes-invocation-indicator");
    expect(indicator.querySelector(".lucide-clock-3")).not.toBeNull();
    expect(indicator.querySelector(".lucide-loader-circle")).toBeNull();
    expect(screen.getByText("Koda is queued")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it.each(["approval", "question"] as const)(
    "shows a static status marker for a Minimal bot awaiting a %s request", (kind) => {
      selectAppearance({ shape: "minimal", color: "#3498DB" });
      useBotRequestsStore.getState().upsert(botRequest({ kind }));
      render(<HermesProgressInline
        invocations={[{ invocation: invocation(), events: [] }]}
      />);
      const marker = screen.getByTestId("hermes-invocation-indicator");
      expect(marker.querySelector(".lucide-circle-alert")).not.toBeNull();
      expect(marker.querySelector(".lucide-loader-circle")).toBeNull();
      expect(screen.getByText("action needed")).toBeInTheDocument();
      expect(
        screen.getByText(
          kind === "approval"
            ? "Koda is waiting for your approval"
            : "Koda is waiting for your response",
        ),
      ).toBeInTheDocument();
      // The card itself renders from the request row elsewhere.
      expect(screen.queryByRole("button", { name: /allow/i })).not.toBeInTheDocument();
      act(() => useBotRequestsStore.getState().upsert(botRequest({
        kind,
        status: "answered",
        answer: { choice: "once" },
        updatedAt: "2026-01-01T00:01:00.000Z",
      })));
      expect(marker.querySelector(".lucide-loader-circle")).not.toBeNull();
    },
  );

  it("updates running progress immediately when the workspace switches styles or loses the member", async () => {
    selectAppearance({ shape: "ghost", color: "#00B894" });
    const { container } = render(<HermesProgressInline
      invocations={[{ invocation: invocation(), events: [] }]}
    />);
    await waitFor(() => expect(container.querySelector("[data-bot-avatar]")).toHaveAttribute("data-state", "working"));
    act(() => selectAppearance({ shape: "minimal", color: "#00B894" }));
    expect(screen.getByTestId("hermes-invocation-indicator").querySelector(".lucide-loader-circle")).not.toBeNull();
    expect(container.querySelector("[data-bot-avatar]")).toBeNull();
    act(() => selectAppearance({ shape: "cat", color: "#00B894" }));
    await waitFor(() => expect(container.querySelector("[data-bot-avatar]")).toHaveAttribute("data-bot-avatar", "cat"));
    expect(screen.queryByTestId("hermes-invocation-indicator")).toBeNull();
    for (const activeWorkspace of [
      { id: "workspace-1", members: [] } as unknown as WorkspaceWithDetails,
      { id: "workspace-1", members: [{ userId: "bot-user-1", bot: { id: "bot-1", kind: "hermes" } }] } as WorkspaceWithDetails,
      null,
    ]) {
      act(() => useWorkspacesStore.setState({ activeWorkspace }));
      await waitFor(() => expect(container.querySelector("[data-bot-avatar]")).toHaveAttribute("data-state", "working"));
      expect(screen.queryByTestId("hermes-invocation-indicator")).toBeNull();
    }
  });

  it("keeps the elapsed timer ticking for Minimal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:08Z"));
    try {
      selectAppearance({ shape: "minimal", color: "#3498DB" });
      const { unmount } = render(<HermesProgressInline
        invocations={[{ invocation: invocation(), events: [] }]}
      />);
      expect(screen.getByText("8s")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByText("9s")).toBeInTheDocument();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("collapses tool start and completion events into one row", () => {
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "patch-started",
                sequence: 1,
                type: "tool.started",
                status: "running",
                toolCallId: "call-patch",
                toolName: "patch",
                label: "/home/bruno/projects/python-probability-study/tests/test_expected_value.py",
                preview: "/home/bruno/projects/python-probability-study/tests/test_expected_value.py",
                payload: {
                  args: {
                    path: "/home/bruno/projects/python-probability-study/tests/test_expected_value.py",
                    mode: "replace",
                    new_string: "assert variance(outcomes, probabilities) == 2",
                  },
                },
              }),
              progressEvent({
                id: "patch-completed",
                sequence: 2,
                type: "tool.completed",
                status: "completed",
                toolCallId: "call-patch",
                toolName: "patch",
                label: null,
                preview: null,
                payload: {
                  args: {
                    path: "/home/bruno/projects/python-probability-study/tests/test_expected_value.py",
                    mode: "replace",
                    new_string: "assert variance(outcomes, probabilities) == 2",
                  },
                  duration: 0.2,
                },
              }),
              progressEvent({
                id: "terminal-started",
                sequence: 3,
                type: "tool.started",
                status: "running",
                toolCallId: "call-terminal",
                toolName: "terminal",
                label: "pwd && uv run pytest -q && uv run expected_value.py",
                preview: "pwd && uv run pytest -q && uv run expected_value.py",
                payload: {
                  args: {
                    command: "pwd && uv run pytest -q && uv run expected_value.py",
                    timeout: 300,
                  },
                },
              }),
              progressEvent({
                id: "terminal-completed",
                sequence: 4,
                type: "tool.completed",
                status: "completed",
                toolCallId: "call-terminal",
                toolName: "terminal",
                label: null,
                preview: null,
                payload: {
                  args: {
                    command: "pwd && uv run pytest -q && uv run expected_value.py",
                    timeout: 300,
                  },
                  duration: 4.5,
                },
              }),
            ],
          },
        ]}
      />,
    );

    expect(
      screen.getAllByText(
        "/home/bruno/projects/python-probability-study/tests/test_expected_value.py",
      ),
    ).toHaveLength(1);
    expect(
      screen.getAllByText("pwd && uv run pytest -q && uv run expected_value.py"),
    ).toHaveLength(1);
    expect(screen.queryByText(/^patch: mode=replace/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^terminal: command=pwd/)).not.toBeInTheDocument();
    // The duration remains visible on the row and in its details.
    expandSteps("tool");
    expect(screen.getAllByText("0.2s")).toHaveLength(2);
    expect(screen.getAllByText("4.5s")).toHaveLength(2);
  });

  it("does not render the old context footer", () => {
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "tool",
                type: "tool.started",
                status: "running",
                toolCallId: "call-read",
                toolName: "read_file",
                label: "Read task context",
              }),
            ],
          },
        ]}
      />,
    );

    expect(screen.queryByText("Context")).not.toBeInTheDocument();
    expect(screen.queryByText("85%")).not.toBeInTheDocument();
    expect(screen.queryByText("Details")).not.toBeInTheDocument();
  });

  it("renders notices and reasoning separately from tool activity", () => {
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "notice",
                sequence: 1,
                type: "notice.lifecycle",
                status: "info",
                toolCallId: null,
                toolName: null,
                label: "Codex gpt-5.5 caps context at 272K",
              }),
              progressEvent({
                id: "legacy-status",
                sequence: 2,
                type: "status.warn",
                status: "warning",
                toolCallId: null,
                toolName: null,
                label: "Compression provider is unavailable",
              }),
              progressEvent({
                id: "reasoning",
                sequence: 3,
                type: "reasoning.available",
                status: "running",
                toolCallId: null,
                toolName: null,
                preview: "Drafting a response before using tools\nmore detail",
                payload: { text: "Drafting a response before using tools" },
              }),
              progressEvent({
                id: "tool",
                sequence: 4,
                type: "tool.started",
                status: "running",
                toolCallId: "call-read",
                toolName: "read_file",
                label: "Read task context",
              }),
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("info")).toBeInTheDocument();
    expect(screen.getByText("warn")).toBeInTheDocument();
    expect(screen.getByText("Codex gpt-5.5 caps context at 272K")).toBeInTheDocument();
    expect(screen.getByText("Compression provider is unavailable")).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("Drafting a response before using tools")).toBeInTheDocument();
    expect(screen.getByText("Read task context")).toBeInTheDocument();
  });

  it("does not treat reasoning events with an internal tool name as tools", () => {
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "reasoning",
                type: "reasoning.available",
                toolCallId: null,
                toolName: "_thinking",
                preview: "Considering the request",
                payload: { text: "Considering the request" },
              }),
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("Considering the request")).toBeInTheDocument();
    expect(screen.queryByText(/^_thinking/)).not.toBeInTheDocument();
  });

  it("renders error notices without treating them as tool activity", () => {
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "error-notice",
                type: "notice.error",
                status: "failed",
                toolCallId: null,
                toolName: null,
                label: "Compression provider failed",
              }),
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("Compression provider failed")).toBeInTheDocument();
  });

  it("shows emitted tool names in the details of bare progress labels", () => {
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "skill-view",
                type: "tool.started",
                status: "running",
                toolCallId: "call-skill",
                toolName: "skill_view",
                label: "html-math-study-notes",
                preview: "html-math-study-notes",
                payload: {
                  args: { name: "html-math-study-notes" },
                },
              }),
              progressEvent({
                id: "custom-tool",
                type: "tool.started",
                status: "running",
                toolCallId: "call-custom",
                toolName: "custom_tool",
                label: "external context",
                preview: "external context",
              }),
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("external context")).toBeInTheDocument();
    expect(screen.getByText("html-math-study-notes")).toBeInTheDocument();
    expandSteps("tool");
    expect(screen.getAllByText("skill_view")).toHaveLength(2);
    expect(screen.getAllByText("custom_tool")).toHaveLength(2);
  });

  it("renders activity rows in the order events happened", () => {
    // Terminal -> thinking -> terminal: rows keep this order instead of
    // grouping by type. Approval progress from an older gateway never renders;
    // the request row carries it.
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "tool-1-started",
                sequence: 1,
                type: "tool.started",
                status: "running",
                toolCallId: "call-1",
                toolName: "terminal",
                label: "du -sh /var/cache",
              }),
              progressEvent({
                id: "tool-1-completed",
                sequence: 2,
                type: "tool.completed",
                status: "completed",
                toolCallId: "call-1",
                toolName: "terminal",
                payload: { duration: 1.2 },
              }),
              progressEvent({
                id: "approval-1",
                sequence: 3,
                type: "approval.request",
                status: "waiting",
                toolCallId: null,
                toolName: null,
                payload: { command: "rm -rf /var/cache/old" },
              }),
              progressEvent({
                id: "resolution-1",
                sequence: 4,
                type: "approval.resolved",
                status: "completed",
                toolCallId: null,
                toolName: null,
                payload: { choice: "once" },
              }),
              progressEvent({
                id: "reasoning-1",
                sequence: 5,
                type: "reasoning.available",
                toolCallId: null,
                toolName: null,
                payload: { text: "Cleanup finished, verifying disk usage" },
              }),
              progressEvent({
                id: "tool-2-started",
                sequence: 6,
                type: "tool.started",
                status: "running",
                toolCallId: "call-2",
                toolName: "terminal",
                label: "df -h /var/cache",
              }),
            ],
          },
        ]}
      />,
    );

    const kinds = screen
      .getAllByTestId("hermes-activity-row")
      .map((row) => row.dataset.kind);
    expect(kinds).toEqual(["tool", "reasoning", "tool"]);
    expect(screen.queryByText(/rm -rf/)).not.toBeInTheDocument();
  });

  it("collapses consecutive reasoning events but keeps separated blocks apart", () => {
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "reasoning-1",
                sequence: 1,
                type: "reasoning.available",
                toolCallId: null,
                toolName: null,
                payload: { text: "First thought" },
              }),
              progressEvent({
                id: "reasoning-2",
                sequence: 2,
                type: "reasoning.available",
                toolCallId: null,
                toolName: null,
                payload: { text: "Refined thought" },
              }),
              progressEvent({
                id: "tool-1",
                sequence: 3,
                type: "tool.started",
                status: "running",
                toolCallId: "call-1",
                toolName: "terminal",
                label: "ls",
              }),
              progressEvent({
                id: "reasoning-3",
                sequence: 4,
                type: "reasoning.available",
                toolCallId: null,
                toolName: null,
                payload: { text: "Second block" },
              }),
            ],
          },
        ]}
      />,
    );

    const kinds = screen
      .getAllByTestId("hermes-activity-row")
      .map((row) => row.dataset.kind);
    expect(kinds).toEqual(["reasoning", "tool", "reasoning"]);
    // The first block shows its latest text, not the first delta.
    expect(screen.getByText("Refined thought")).toBeInTheDocument();
    expect(screen.queryByText("First thought")).not.toBeInTheDocument();
    expect(screen.getByText("Second block")).toBeInTheDocument();
  });

  it("expands tool and thinking rows to show the full text", () => {
    const longCommand =
      "find /var/cache/builds -type d -mtime +30 -print0 | xargs -0 du -sh | sort -rh | head -50";
    const reasoningText = "Line one of thinking\nLine two with more detail";
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "tool-1",
                sequence: 1,
                type: "tool.started",
                status: "running",
                toolCallId: "call-1",
                toolName: "terminal",
                label: longCommand,
              }),
              progressEvent({
                id: "reasoning-1",
                sequence: 2,
                type: "reasoning.available",
                toolCallId: null,
                toolName: null,
                payload: { text: reasoningText },
              }),
            ],
          },
        ]}
      />,
    );

    expect(screen.queryByTestId("hermes-activity-detail")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /du -sh/ }));
    expect(screen.getByTestId("hermes-activity-detail")).toHaveTextContent(
      "head -50",
    );

    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
    const details = screen.getAllByTestId("hermes-activity-detail");
    expect(details).toHaveLength(2);
    expect(details[1]).toHaveTextContent("Line two with more detail");

    fireEvent.click(screen.getByRole("button", { name: /du -sh/ }));
    expect(screen.getAllByTestId("hermes-activity-detail")).toHaveLength(1);
  });

  it("shows recent tool steps individually without a generated summary", () => {
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({ id: "r1", sequence: 1, type: "tool.completed", toolCallId: "c1", toolName: "read_file", label: "Read a.ts" }),
              progressEvent({ id: "r2", sequence: 2, type: "tool.completed", toolCallId: "c2", toolName: "read_file", label: "Read b.ts" }),
              progressEvent({ id: "t1", sequence: 3, type: "tool.failed", toolCallId: "c3", toolName: "terminal", label: "pnpm test" }),
              progressEvent({ id: "t2", sequence: 4, type: "tool.started", toolCallId: "c4", toolName: "terminal", label: "pnpm build" }),
            ],
          },
        ]}
      />,
    );

    expect(screen.queryByTestId("hermes-activity-summary")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("hermes-activity-row")).toHaveLength(4);
    expect(screen.getByText("Read a.ts")).toBeInTheDocument();
    expect(screen.getByText("Read b.ts")).toBeInTheDocument();
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(screen.getByText("pnpm build")).toBeInTheDocument();
  });

  it("hops the bot in place of an orb and keeps orbs on thinking rows", async () => {
    const { container } = render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({ id: "thought-1", sequence: 1, type: "reasoning.delta", toolCallId: null, toolName: null, payload: { text: "Plan" } }),
              progressEvent({ id: "tool-1", sequence: 2, type: "tool.completed", toolCallId: "call-1" }),
              progressEvent({ id: "thought-2", sequence: 3, type: "reasoning.delta", toolCallId: null, toolName: null, payload: { text: "Check" } }),
            ],
          },
        ]}
      />,
    );

    const bot = await waitFor(() => {
      const found = container.querySelector("[data-bot-avatar]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(bot).toHaveAttribute("data-state", "working");
    expect(bot).toHaveAttribute("data-paused", "false");
    expect(bot).toHaveAttribute("data-interactive", "false");
    expect(container.querySelector('[data-thinking-orb="composing"]')).toBeNull();
    expect(container.querySelectorAll('[data-thinking-orb="solving"]')).toHaveLength(2);
  });

  it("stops working and looks around while the agent waits for an approval", async () => {
    const { container } = render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({ id: "thought-1", sequence: 1, type: "reasoning.delta", toolCallId: null, toolName: null, payload: { text: "Plan" } }),
            ],
          },
        ]}
      />,
    );
    act(() => useBotRequestsStore.getState().upsert(botRequest()));

    expect(container.querySelector("[data-thinking-orb]")).toBeNull();
    const bot = await waitFor(() => {
      const found = container.querySelector("[data-bot-avatar]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(bot).toHaveAttribute("data-state", "default");
    expect(bot).toHaveAttribute("data-paused", "false");
  });
});

function selectAppearance(avatar: BotAppearance) {
  useWorkspacesStore.setState({ activeWorkspace: {
    id: "workspace-1",
    members: [{ userId: "bot-user-1", bot: { id: "bot-1", kind: "hermes", avatar } }],
  } as WorkspaceWithDetails });
}

function botRequest(overrides: Partial<BotRequestPublic> = {}): BotRequestPublic {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "request-1",
    botId: "bot-1",
    botUserId: "bot-user-1",
    botName: "Koda",
    conversationId: "conversation-1",
    conversationType: "direct",
    conversationName: null,
    workspaceId: null,
    threadId: null,
    threadTitle: null,
    invocationId: "invocation-1",
    kind: "approval",
    title: "Run a command",
    body: null,
    details: { command: "git push" },
    response: { type: "choice", choices: ["once", "session", "always", "deny"] },
    orderGroup: "session-1",
    audienceUserId: null,
    status: "open",
    answer: null,
    answeredBy: null,
    answeredAt: null,
    deliveredAt: null,
    deliveryApplied: null,
    deliveryNote: null,
    cancelReason: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
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
    type: "tool.started",
    status: null,
    toolCallId: "tool-call-1",
    toolName: "terminal",
    label: null,
    preview: null,
    payload: null,
    occurredAt: now,
    createdAt: now,
    ...overrides,
  };
}

/** Opens every step of one kind to show its details. */
function expandSteps(kind: string) {
  for (const row of screen.queryAllByTestId("hermes-activity-row")) {
    const toggle =
      row.dataset.kind === kind ? row.querySelector("button[aria-expanded='false']") : null;
    if (toggle) fireEvent.click(toggle);
  }
}
