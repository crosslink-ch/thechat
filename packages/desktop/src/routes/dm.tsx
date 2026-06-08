import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import {
  useBotRuntime,
  useBotRuntimeCache,
} from "../hooks/useBotRuntime";
import { useConversationThreads } from "../hooks/useConversationThreads";
import { useConversationDetail } from "../hooks/useConversationDetail";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import { useChannelChat } from "../hooks/useChannelChat";
import { ChannelChatView } from "../components/ChannelChatView";
import { HermesDmChatView } from "../components/HermesDmChatView";
import { HermesRuntimePanel } from "../components/HermesRuntimePanel";
import { fireNotification } from "../lib/notifications";
import { wsEvents, type WsEvents } from "../lib/ws-events";
import { selectHermesConversationProgress } from "../lib/hermes-progress";
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
  const [queuedPromptsByScope, setQueuedPromptsByScope] = useState<Record<string, string[]>>({});
  const previousTaskActiveByScope = useRef<Record<string, boolean>>({});

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
    updateThreadSession,
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
  const chatConversationId = conversation ? conversationId : null;
  const activeScopeKey = hermesScopeKey(conversationId, activeThreadId);
  const queuedPrompts = queuedPromptsByScope[activeScopeKey] ?? [];
  const taskActive = activeHermesProgress.invocations.length > 0;
  const activeHermesSession = useMemo(() => {
    if (activeThreadId) {
      return threads.find((thread) => thread.id === activeThreadId)?.hermesSession ?? null;
    }
    return runtime?.invocations
      .filter((invocation) => invocation.botKind === "hermes" && invocation.threadId === null)
      .find((invocation) => invocation.hermesSession)?.hermesSession ?? null;
  }, [activeThreadId, runtime?.invocations, threads]);
  const queuedCountsByThread = useMemo(() => {
    const counts = new Map<string, number>();
    const prefix = `${conversationId}:thread:`;
    for (const [scopeKey, prompts] of Object.entries(queuedPromptsByScope)) {
      if (!scopeKey.startsWith(prefix) || prompts.length === 0) continue;
      counts.set(scopeKey.slice(prefix.length), prompts.length);
    }
    return counts;
  }, [conversationId, queuedPromptsByScope]);
  const generalQueuedCount = queuedPromptsByScope[hermesScopeKey(conversationId, null)]?.length ?? 0;

  const channelChat = useChannelChat({
    conversationId: chatConversationId,
    threadId: isHermesDm ? activeThreadId : null,
    unthreadedOnly: generalThreadActive,
    token,
    wsSendMessage,
  });

  const channelChatRef = useRef(channelChat);
  channelChatRef.current = channelChat;

  // Subscribe to WebSocket messages for this DM
  useEffect(() => {
    const onMessage = ({
      message: msg,
      conversationType,
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
      } else if (conversationType === "direct" && msg.senderId !== user?.id) {
        fireNotification(msg.senderName, msg.content);
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
      if (invocation.threadId && invocation.hermesSession) {
        updateThreadSession(invocation.threadId, invocation.hermesSession);
      }
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
    updateThreadSession,
    user?.id,
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

  const handleCreateThread = () => {
    void createThread({
      botId: otherParticipant?.bot?.id,
    }).then((thread) => {
      if (thread) setActiveThreadId(thread.id);
    });
  };

  const clearQueuedPrompts = useCallback((scopeKey: string) => {
    setQueuedPromptsByScope((previous) => {
      if (!previous[scopeKey]?.length) return previous;
      const next = { ...previous };
      delete next[scopeKey];
      return next;
    });
  }, []);

  const enqueueHermesPrompt = useCallback((scopeKey: string, content: string) => {
    setQueuedPromptsByScope((previous) => ({
      ...previous,
      [scopeKey]: [
        ...(previous[scopeKey] ?? []),
        content,
      ],
    }));
  }, []);

  const sendHermesMessageNow = useCallback((content: string, threadId: string | null) => {
    if (threadId === null) {
      channelChat.sendMessage(content);
      return;
    }

    void (async () => {
      const activeThread = threads.find((thread) => thread.id === threadId);
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
  }, [channelChat, conversationId, renameThread, threads, touchThread, wsSendMessage]);

  const handleStopHermesTask = useCallback(() => {
    if (!isHermesDm) return;
    sendHermesMessageNow("/stop", activeThreadId);
  }, [activeThreadId, isHermesDm, sendHermesMessageNow]);

  const handleBranchCommand = useCallback(async (args: string) => {
    if (!isHermesDm) return;
    const sourceThread = activeThreadId
      ? threads.find((thread) => thread.id === activeThreadId)
      : null;
    const branchTitle = titleFromBranchCommand(args, sourceThread?.title);
    const sourceSession = sourceThread?.hermesSession ?? activeHermesSession;
    const hermesSession = sourceSession?.sessionId
      ? {
          branchFromSessionId: sourceSession.sessionId,
          branchFromThreadId: sourceThread?.id ?? null,
          branchFromLineageRootId: sourceSession.lineageRootId ?? sourceSession.sessionId,
          branchTitle,
          reason: "branch.pending",
          source: "thechat",
          updatedAt: new Date().toISOString(),
        }
      : undefined;

    const thread = await createThread({
      botId: otherParticipant?.bot?.id,
      title: branchTitle,
      ...(hermesSession ? { hermesSession } : {}),
    });
    if (thread) setActiveThreadId(thread.id);
  }, [activeHermesSession, activeThreadId, createThread, isHermesDm, otherParticipant?.bot?.id, threads]);

  const handleSend = (content: string) => {
    if (!isHermesDm) {
      channelChat.sendMessage(content);
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
      if (canonical === "/new" || canonical === "/reset") {
        clearQueuedPrompts(activeScopeKey);
      }
      sendHermesMessageNow(content, activeThreadId);
      return;
    }
    if (taskActive) {
      enqueueHermesPrompt(activeScopeKey, content);
      return;
    }
    sendHermesMessageNow(content, activeThreadId);
  };

  useEffect(() => {
    if (!isHermesDm) return;
    const wasActive = previousTaskActiveByScope.current[activeScopeKey] ?? false;
    previousTaskActiveByScope.current[activeScopeKey] = taskActive;
    if (!wasActive || taskActive || queuedPrompts.length === 0) return;

    const [nextPrompt] = queuedPrompts;
    setQueuedPromptsByScope((previous) => {
      const current = previous[activeScopeKey] ?? [];
      if (current.length === 0) return previous;
      const next = { ...previous };
      const remaining = current.slice(1);
      if (remaining.length > 0) {
        next[activeScopeKey] = remaining;
      } else {
        delete next[activeScopeKey];
      }
      return next;
    });
    sendHermesMessageNow(nextPrompt, activeThreadId);
  }, [activeScopeKey, activeThreadId, isHermesDm, queuedPrompts, sendHermesMessageNow, taskActive]);

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
            onTrimToRecentMessages={channelChat.trimToRecentMessages}
            mentions={mentions}
            scrollKey={`${conversationId}:${activeThreadId ?? "general"}`}
            taskActive={taskActive}
            queuedCount={queuedPrompts.length}
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
            onTrimToRecentMessages={channelChat.trimToRecentMessages}
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
          queuedCountsByThread={queuedCountsByThread}
          generalQueuedCount={generalQueuedCount}
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

function hermesScopeKey(conversationId: string, threadId: string | null) {
  return threadId ? `${conversationId}:thread:${threadId}` : `${conversationId}:general`;
}
