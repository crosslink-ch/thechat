import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import {
  useBotRuntime,
  useBotRuntimeCache,
} from "../hooks/useBotRuntime";
import { useConversationThreads } from "../hooks/useConversationThreads";
import { useConversationDetail } from "../hooks/useConversationDetail";
import { useScopedCommands } from "../hooks/useScopedCommands";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import { useChannelChat } from "../hooks/useChannelChat";
import { ChannelChatView } from "../components/ChannelChatView";
import { HermesDmChatView } from "../components/HermesDmChatView";
import { HermesRuntimePanel } from "../components/HermesRuntimePanel";
import { closePaletteAndRefocus } from "../CommandPalette";
import type { Command } from "../commands";
import { wsEvents, type WsEvents } from "../lib/ws-events";
import { selectHermesConversationProgress } from "../lib/hermes-progress";
import {
  decisionFromApprovalCommand,
  pendingApprovalEvents,
} from "../lib/hermes-approvals";
import {
  recordApprovalDecision,
  useHermesApprovalsStore,
} from "../stores/hermes-approvals";
import {
  hermesScopeKey,
  useHermesIndicatorsStore,
} from "../stores/hermes-indicators";
import {
  buildHermesSlashCommands,
  canonicalHermesSlashCommand,
  parseHermesSlashCommand,
} from "../lib/hermes-slash-commands";

export function DmRoute() {
  const { id: conversationId } = useParams({ from: "/dm/$id" });
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const members = useWorkspacesStore((s) => s.activeWorkspace?.members);
  const wsSendMessage = useWebSocketStore((s) => s.sendMessage);
  const conversationQuery = useConversationDetail(conversationId, token);
  const conversation = conversationQuery.data ?? null;
  const conversationLoading = conversationQuery.isLoading;
  const conversationPending = !conversation && !!token && !conversationQuery.error;

  const mentions = useMemo(
    () =>
      members
        ?.filter((m) => m.userId !== user?.id)
        .map((m) => ({ id: m.userId, label: m.user.name, type: m.user.type })),
    [members, user?.id]
  );

  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const otherParticipant = useMemo(
    () => conversation?.participants.find((p) => p.userId !== user?.id) ?? null,
    [conversation, user?.id],
  );
  const isHermesDm = conversation?.type === "direct" && otherParticipant?.bot?.kind === "hermes";
  const registeredBotCommands = otherParticipant?.bot?.commands;
  const slashCommands = useMemo(
    () => buildHermesSlashCommands(registeredBotCommands),
    [registeredBotCommands],
  );
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const runtimeQuery = useBotRuntime(conversationId, token, isHermesDm);
  const runtime = runtimeQuery.data ?? null;
  const runtimeLoading = runtimeQuery.isLoading;
  const threadState = useConversationThreads(conversationId, token, isHermesDm);
  const {
    threads,
    loading: threadsLoading,
    loadingMore: threadsLoadingMore,
    hasMore: threadsHasMore,
    loadMore: loadMoreThreads,
    createThread,
    renameThread,
    touchThread,
  } = threadState;
  const { mergeInvocationUpdate, mergeProgressEvent } = useBotRuntimeCache();
  const generalThreadActive = isHermesDm && activeThreadId === null;
  const activeHermesProgress = useMemo(
    () =>
      selectHermesConversationProgress(runtime, activeThreadId, {
        unthreadedOnly: generalThreadActive,
      }),
    [activeThreadId, generalThreadActive, runtime],
  );
  const activeHermesProgressRef = useRef(activeHermesProgress);
  activeHermesProgressRef.current = activeHermesProgress;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const chatConversationId = conversation ? conversationId : null;
  const taskActive = activeHermesProgress.invocations.length > 0;

  // Attention indicators: which tasks in this DM need approval or finished unread.
  const pendingApprovals = useHermesIndicatorsStore((s) => s.pendingApprovals);
  const unreadScopes = useHermesIndicatorsStore((s) => s.unreadScopes);
  const approvalThreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const approval of pendingApprovals) {
      if (approval.conversationId !== conversationId) continue;
      if (approval.threadId) ids.add(approval.threadId);
    }
    return ids;
  }, [conversationId, pendingApprovals]);
  const generalNeedsApproval = useMemo(
    () =>
      pendingApprovals.some(
        (approval) =>
          approval.conversationId === conversationId && approval.threadId === null,
      ),
    [conversationId, pendingApprovals],
  );
  const unreadThreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const scope of Object.values(unreadScopes)) {
      if (scope.conversationId !== conversationId) continue;
      if (scope.threadId) ids.add(scope.threadId);
    }
    return ids;
  }, [conversationId, unreadScopes]);
  const generalUnread = useMemo(
    () =>
      Object.values(unreadScopes).some(
        (scope) => scope.conversationId === conversationId && scope.threadId === null,
      ),
    [conversationId, unreadScopes],
  );

  // Keep the indicators store in sync with what the user is looking at, and
  // seed it from the fetched runtime snapshot so approvals requested before
  // this client connected still show up.
  useEffect(() => {
    if (!isHermesDm) return;
    const store = useHermesIndicatorsStore.getState();
    store.setVisibleScope(hermesScopeKey(conversationId, activeThreadId));
    return () => {
      useHermesIndicatorsStore.getState().setVisibleScope(null);
    };
  }, [activeThreadId, conversationId, isHermesDm]);

  useEffect(() => {
    if (!isHermesDm || !runtime) return;
    useHermesIndicatorsStore
      .getState()
      .seedFromSnapshot(
        conversationId,
        runtime,
        useHermesApprovalsStore.getState().decisions,
      );
  }, [conversationId, isHermesDm, runtime]);

  const channelChat = useChannelChat({
    conversationId: chatConversationId,
    threadId: isHermesDm ? activeThreadId : null,
    unthreadedOnly: generalThreadActive,
    token,
    wsSendMessage,
  });

  const channelChatRef = useRef(channelChat);
  channelChatRef.current = channelChat;
  const channelSendMessage = channelChat.sendMessage;

  // Subscribe to WebSocket messages for this DM
  useEffect(() => {
    const onMessage = ({
      message: msg,
    }: WsEvents["ws:new_message"]) => {
      if (msg.conversationId === conversationId) {
        channelChatRef.current.addMessage(msg);
        if (msg.threadId) {
          touchThread(msg.threadId, msg.createdAt);
        }
        if (!isHermesDm || msg.threadId === activeThreadId) {
          setTypingUsers((prev) => {
            if (!prev.has(msg.senderId)) return prev;
            const next = new Map(prev);
            next.delete(msg.senderId);
            return next;
          });
        }
      }
    };

    const onTyping = ({
      conversationId: convId,
      threadId,
      userId,
      userName,
    }: WsEvents["ws:typing"]) => {
      if (convId !== conversationId) return;
      if (isHermesDm && (threadId ?? null) !== activeThreadId) return;

      setTypingUsers((prev) => {
        const next = new Map(prev);
        next.set(userId, userName);
        return next;
      });

      const existing = typingTimers.current.get(userId);
      if (existing) clearTimeout(existing);
      typingTimers.current.set(
        userId,
        setTimeout(() => {
          setTypingUsers((prev) => {
            const next = new Map(prev);
            next.delete(userId);
            return next;
          });
          typingTimers.current.delete(userId);
        }, 3000),
      );
    };

    const onBotInvocationUpdated = ({
      conversationId: convId,
      invocation,
    }: WsEvents["ws:bot_invocation_updated"]) => {
      if (convId !== conversationId) return;
      mergeInvocationUpdate(conversationId, invocation);
    };
    const onBotInvocationProgress = ({
      conversationId: convId,
      event,
    }: WsEvents["ws:bot_invocation_progress"]) => {
      if (convId !== conversationId) return;
      mergeProgressEvent(conversationId, event);
    };

    wsEvents.on("ws:new_message", onMessage);
    wsEvents.on("ws:typing", onTyping);
    wsEvents.on("ws:bot_invocation_updated", onBotInvocationUpdated);
    wsEvents.on("ws:bot_invocation_progress", onBotInvocationProgress);

    return () => {
      wsEvents.off("ws:new_message", onMessage);
      wsEvents.off("ws:typing", onTyping);
      wsEvents.off("ws:bot_invocation_updated", onBotInvocationUpdated);
      wsEvents.off("ws:bot_invocation_progress", onBotInvocationProgress);
      for (const timer of typingTimers.current.values()) {
        clearTimeout(timer);
      }
      typingTimers.current.clear();
    };
  }, [
    activeThreadId,
    conversationId,
    isHermesDm,
    mergeInvocationUpdate,
    mergeProgressEvent,
    touchThread,
  ]);

  // Clear typing users when the visible DM or Hermes task changes.
  useEffect(() => {
    setTypingUsers(new Map());
    for (const timer of typingTimers.current.values()) {
      clearTimeout(timer);
    }
    typingTimers.current.clear();
  }, [conversationId, activeThreadId]);

  // Reset task selection when the visible DM changes.
  useEffect(() => {
    setActiveThreadId(null);
  }, [conversationId]);

  useEffect(() => {
    if (!isHermesDm) return;
    if (activeThreadId && !threads.some((thread) => thread.id === activeThreadId)) {
      setActiveThreadId(null);
    }
  }, [activeThreadId, isHermesDm, threads]);

  const handleCreateThread = useCallback(() => {
    if (!isHermesDm) return;
    void createThread({
      botId: otherParticipant?.bot?.id,
    }).then((thread) => {
      if (thread) setActiveThreadId(thread.id);
    });
  }, [createThread, isHermesDm, otherParticipant?.bot?.id]);

  const hermesTaskCommands = useMemo<Command[]>(
    () => [
      {
        id: "hermes.new-task",
        label: "New Task",
        shortcut: "C-x n",
        keybinding: { prefix: "C-x", key: "n" },
        enabled: isHermesDm,
        priority: 100,
        execute: () => {
          handleCreateThread();
          closePaletteAndRefocus();
        },
      },
    ],
    [handleCreateThread, isHermesDm],
  );
  useScopedCommands(hermesTaskCommands);

  const sendHermesMessageNow = useCallback((content: string, threadId: string | null) => {
    if (threadId === null) {
      channelSendMessage(content);
      return;
    }

    void (async () => {
      const activeThread = threadsRef.current.find((thread) => thread.id === threadId);
      if (!parseHermesSlashCommand(content) && isAutoNamedThread(activeThread)) {
        try {
          await renameThread(threadId, titleFromMessage(content));
        } catch (error) {
          console.error("Failed to rename Hermes task thread", error);
        }
      }
      wsSendMessage(conversationId, content, threadId);
      touchThread(threadId);
    })();
  }, [channelSendMessage, conversationId, renameThread, touchThread, wsSendMessage]);

  const handleStopHermesTask = useCallback(() => {
    if (!isHermesDm) return;
    sendHermesMessageNow("/stop", activeThreadId);
  }, [activeThreadId, isHermesDm, sendHermesMessageNow]);

  const handleBranchCommand = useCallback(async (args: string) => {
    if (!isHermesDm) return;
    const sourceThread = activeThreadId
      ? threadsRef.current.find((thread) => thread.id === activeThreadId)
      : null;
    const branchTitle = titleFromBranchCommand(args, sourceThread?.title);

    const thread = await createThread({
      botId: otherParticipant?.bot?.id,
      title: branchTitle,
      branchFromThreadId: sourceThread?.id ?? null,
    });
    if (thread) setActiveThreadId(thread.id);
  }, [activeThreadId, createThread, isHermesDm, otherParticipant?.bot?.id]);

  const handleSend = useCallback((content: string) => {
    if (!isHermesDm) {
      channelSendMessage(content);
      return;
    }

    const slash = parseHermesSlashCommand(content);
    const canonical = slash
      ? canonicalHermesSlashCommand(slash.command, slashCommands) ?? slash.command
      : null;
    if (canonical === "/branch") {
      void handleBranchCommand(slash!.args);
      return;
    }
    if (slash) {
      // Optimistically resolve approval cards: the gateway resolves pending
      // approvals oldest-first, so mirror that here. Covers both the inline
      // approval buttons (which send these commands) and typed commands.
      const approvalDecision = decisionFromApprovalCommand(content);
      if (approvalDecision) {
        const pending = pendingApprovalEvents(
          activeHermesProgressRef.current.invocations,
          useHermesApprovalsStore.getState().decisions,
        );
        const targets = approvalDecision.all ? pending : pending.slice(0, 1);
        for (const event of targets) {
          recordApprovalDecision(event.id, approvalDecision.decision);
        }
      }
      sendHermesMessageNow(content, activeThreadId);
      return;
    }
    // TheChat intentionally does not queue normal Hermes DM messages locally.
    // Hermes owns the busy-turn policy: default messages can interrupt/steer
    // according to gateway config, while /queue passes through to Hermes' FIFO.
    sendHermesMessageNow(content, activeThreadId);
  }, [
    activeThreadId,
    channelSendMessage,
    handleBranchCommand,
    isHermesDm,
    sendHermesMessageNow,
    slashCommands,
  ]);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {isHermesDm ? (
          <HermesDmChatView
            messages={channelChat.messages}
            loading={
              channelChat.loading ||
              conversationLoading ||
              conversationPending
            }
            loadingOlder={channelChat.loadingOlder}
            hasOlderMessages={channelChat.hasOlderMessages}
            typingUsers={typingUsers}
            progressInvocations={activeHermesProgress.invocations}
            typingSuppressedUserIds={activeHermesProgress.typingSuppressedUserIds}
            onSend={handleSend}
            onStop={handleStopHermesTask}
            onLoadOlderMessages={channelChat.loadOlderMessages}
            mentions={mentions}
            scrollKey={`${conversationId}:${activeThreadId ?? "general"}`}
            taskActive={taskActive}
            slashCommands={slashCommands}
          />
        ) : (
          <ChannelChatView
            messages={channelChat.messages}
            loading={
              channelChat.loading ||
              conversationLoading ||
              conversationPending
            }
            loadingOlder={channelChat.loadingOlder}
            hasOlderMessages={channelChat.hasOlderMessages}
            typingUsers={typingUsers}
            onSend={handleSend}
            onLoadOlderMessages={channelChat.loadOlderMessages}
            mentions={mentions}
            scrollKey={conversationId}
          />
        )}
      </div>
      {isHermesDm && (
        <HermesRuntimePanel
          botName={otherParticipant.user.name}
          runtime={runtime}
          loading={runtimeLoading}
          threads={threads}
          threadsLoading={threadsLoading}
          threadsLoadingMore={threadsLoadingMore}
          threadsHasMore={threadsHasMore}
          activeThreadId={activeThreadId}
          onSelectThread={setActiveThreadId}
          onCreateThread={handleCreateThread}
          approvalThreadIds={approvalThreadIds}
          generalNeedsApproval={generalNeedsApproval}
          unreadThreadIds={unreadThreadIds}
          generalUnread={generalUnread}
          onLoadMoreThreads={() => {
            void loadMoreThreads();
          }}
        />
      )}
    </div>
  );
}

function titleFromMessage(content: string) {
  const normalized = content.trim().replace(/\s+/g, " ");
  if (!normalized) return "New task";
  return normalized.length > 48 ? `${normalized.slice(0, 45)}...` : normalized;
}

function titleFromBranchCommand(args: string, sourceTitle?: string | null) {
  const explicitTitle = args.trim().replace(/\s+/g, " ");
  if (explicitTitle) return titleFromMessage(explicitTitle);
  const normalizedSourceTitle = sourceTitle?.trim();
  if (normalizedSourceTitle && normalizedSourceTitle !== "New task") {
    return titleFromMessage(`${normalizedSourceTitle} branch`);
  }
  return "Branch";
}

function isAutoNamedThread(thread: { title: string } | null | undefined) {
  return thread?.title.trim() === "New task";
}
