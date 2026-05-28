import { useState, useEffect, useRef, useMemo } from "react";
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
import { HermesRuntimePanel } from "../components/HermesRuntimePanel";
import { fireNotification } from "../lib/notifications";
import { wsEvents, type WsEvents } from "../lib/ws-events";
import { selectHermesConversationProgress } from "../lib/hermes-progress";

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
  const chatConversationId = conversation ? conversationId : null;

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

  const handleSend = (content: string) => {
    if (!isHermesDm || activeThreadId === null) {
      channelChat.sendMessage(content);
      return;
    }

    void (async () => {
      const threadId = activeThreadId;
      const activeThread = threads.find((thread) => thread.id === threadId);
      if (isAutoNamedThread(activeThread)) {
        try {
          await renameThread(threadId, titleFromMessage(content));
        } catch (error) {
          console.error("Failed to rename Hermes task thread", error);
        }
      }
      wsSendMessage(conversationId, content, threadId);
      touchThread(threadId);
    })();
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelChatView
          messages={channelChat.messages}
          loading={
            channelChat.loading ||
            conversationLoading ||
            conversationPending
          }
          typingUsers={typingUsers}
          progressInvocations={activeHermesProgress.invocations}
          progressEvents={activeHermesProgress.events}
          typingSuppressedUserIds={activeHermesProgress.typingSuppressedUserIds}
          onSend={handleSend}
          mentions={mentions}
        />
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

function isAutoNamedThread(thread: { title: string } | null | undefined) {
  return thread?.title.trim() === "New task";
}
