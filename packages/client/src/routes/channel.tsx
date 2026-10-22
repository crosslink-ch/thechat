import { useState, useEffect, useRef, useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useWebSocketStore } from "../stores/websocket";
import { useConversationsStore } from "../stores/conversations";
import { useWorkspacesStore } from "../stores/workspaces";
import { composerDraftKey } from "../stores/composer-drafts";
import { useChannelChat } from "../hooks/useChannelChat";
import { usePersistConversationRead } from "../hooks/usePersistConversationRead";
import { ChannelChatView } from "../components/ChannelChatView";
import { wsEvents, type WsEvents } from "../lib/ws-events";
import { botAppearanceFor } from "../lib/bot-appearance";
import { isAuthenticated } from "../lib/auth-identity";
import { selectHermesConversationProgress } from "../lib/hermes-progress";
import {
  useBotRuntime,
  useBotRuntimeCache,
  submitHermesSecureInput,
  submitHermesVaultUnlock,
} from "../hooks/useBotRuntime";

export function ChannelRoute() {
  const { id: channelId } = useParams({ from: "/channel/$id" });
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const members = useWorkspacesStore((s) => s.activeWorkspace?.members);
  const wsSendMessage = useWebSocketStore((s) => s.sendMessage);
  const runtimeQuery = useBotRuntime(channelId, token, user?.type === "human");
  const { invalidate, mergeInvocationUpdate, mergeProgressEvent } = useBotRuntimeCache();
  // Channels display all threads, like their messages and bot request timeline.
  // Only metadata is cached; the API filters private prompts to their requester.
  const progress = useMemo(() => {
    const runtime = runtimeQuery.data;
    if (!runtime) return selectHermesConversationProgress(null);
    const invocations = runtime.invocations.filter(run => run.conversationId === channelId);
    const byId = new Map(invocations.map(run => [run.id, run]));
    const events = runtime.events.filter(event => {
      const run = byId.get(event.invocationId);
      return event.conversationId === channelId && run?.botId === event.botId &&
        run.threadId === event.threadId;
    });
    return selectHermesConversationProgress({ ...runtime, invocations, events });
  }, [channelId, runtimeQuery.data]);

  const mentions = useMemo(
    () =>
      members
        ?.filter((m) => m.userId !== user?.id)
        .map((m) => ({
          id: m.userId,
          label: m.user.name,
          type: m.user.type,
          botAvatar:
            m.user.type === "bot"
              ? botAppearanceFor(m.userId, m.bot?.avatar)
              : undefined,
        })),
    [members, user?.id]
  );

  const channelChat = useChannelChat({
    conversationId: channelId,
    token,
    wsSendMessage,
    selfUser: user,
  });
  usePersistConversationRead(
    channelId,
    channelChat.messages,
    !channelChat.loading,
  );

  const channelChatRef = useRef(channelChat);
  channelChatRef.current = channelChat;

  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Mark channel as read on mount
  useEffect(() => {
    useConversationsStore.getState().markChannelRead(channelId);
  }, [channelId]);

  useEffect(() => {
    const onInvocation = ({ conversationId, invocation }: WsEvents["ws:bot_invocation_updated"]) => {
      if (conversationId !== channelId || invocation.conversationId !== channelId) return;
      mergeInvocationUpdate(channelId, invocation);
    };
    const onProgress = ({ conversationId, invocationId, event, invocation }: WsEvents["ws:bot_invocation_progress"]) => {
      if (conversationId !== channelId || event.conversationId !== channelId ||
          event.invocationId !== invocationId) return;
      if (invocation && (invocation.conversationId !== channelId ||
          invocation.id !== invocationId || invocation.botId !== event.botId ||
          invocation.threadId !== event.threadId)) return;
      mergeProgressEvent(channelId, event, invocation);
    };
    // This route only subscribes to its active channel: a cached snapshot can
    // have missed a resolution while away, even inside the normal stale window.
    invalidate(channelId);
    const onAuthenticated = () => invalidate(channelId);
    wsEvents.on("ws:bot_invocation_updated", onInvocation);
    wsEvents.on("ws:bot_invocation_progress", onProgress);
    wsEvents.on("ws:authenticated", onAuthenticated);
    return () => {
      wsEvents.off("ws:bot_invocation_updated", onInvocation);
      wsEvents.off("ws:bot_invocation_progress", onProgress);
      wsEvents.off("ws:authenticated", onAuthenticated);
    };
  }, [channelId, invalidate, mergeInvocationUpdate, mergeProgressEvent]);

  // Subscribe to WebSocket messages for this channel
  useEffect(() => {
    const onMessage = ({
      message: msg,
      clientMessageId,
    }: WsEvents["ws:new_message"]) => {
      if (msg.conversationId === channelId) {
        channelChatRef.current.addMessage(msg, clientMessageId);
      }
    };

    const onTyping = ({ conversationId, userId, userName }: WsEvents["ws:typing"]) => {
      if (conversationId !== channelId) return;

      setTypingUsers((prev) => {
        const next = new Map(prev);
        next.set(userId, userName);
        return next;
      });

      // Clear after 3s
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
    wsEvents.on("ws:new_message", onMessage);
    wsEvents.on("ws:typing", onTyping);

    return () => {
      wsEvents.off("ws:new_message", onMessage);
      wsEvents.off("ws:typing", onTyping);
      // Clear all typing timers
      for (const timer of typingTimers.current.values()) {
        clearTimeout(timer);
      }
      typingTimers.current.clear();
    };
  }, [channelId]);

  // Clear typing users when channel changes
  useEffect(() => {
    setTypingUsers(new Map());
  }, [channelId]);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelChatView
          messages={channelChat.messages}
          loading={channelChat.loading}
          loadingOlder={channelChat.loadingOlder}
          hasOlderMessages={channelChat.hasOlderMessages}
          sendError={channelChat.sendError}
          typingUsers={typingUsers}
          onSend={channelChat.sendMessage}
          onLoadOlderMessages={channelChat.loadOlderMessages}
          onSetReaction={channelChat.setReaction}
          mentions={mentions}
          scrollKey={channelId}
          draftKey={composerDraftKey.channel(user?.id, channelId)}
          conversationId={channelId}
          token={token}
          progressInvocations={progress.invocations}
          onSecureInput={async (event, response) => {
            if (!isAuthenticated(token) || user?.type !== "human" ||
                event.conversationId !== channelId || event.payload?.requesterUserId !== user.id) {
              throw new Error("Secure input unavailable");
            }
            await submitHermesSecureInput(event.invocationId, event.id, response, token);
            invalidate(channelId);
          }}
          onVaultUnlock={async (event, response) => {
            if (!isAuthenticated(token) || user?.type !== "human" ||
                event.conversationId !== channelId || event.payload?.requesterUserId !== user.id) {
              throw new Error("Vault unlock unavailable");
            }
            await submitHermesVaultUnlock(event.invocationId, event.id, response, token);
            invalidate(channelId);
          }}
        />
      </div>
    </div>
  );
}
