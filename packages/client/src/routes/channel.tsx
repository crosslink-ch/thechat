import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useWebSocketStore } from "../stores/websocket";
import { useConversationsStore } from "../stores/conversations";
import { useWorkspacesStore } from "../stores/workspaces";
import { composerDraftKey } from "../stores/composer-drafts";
import { useChannelChat } from "../hooks/useChannelChat";
import { usePersistConversationRead } from "../hooks/usePersistConversationRead";
import { ChannelChatView } from "../components/ChannelChatView";
import { ThreadPanel } from "../components/ThreadPanel";
import { useReplyThreadPanel } from "../hooks/useReplyThreadPanel";
import { wsEvents, type WsEvents } from "../lib/ws-events";
import { botAppearanceFor } from "../lib/bot-appearance";
import { isAuthenticated } from "../lib/auth-identity";
import { channelIncludes } from "../lib/channel-access";
import { api } from "../lib/api";
import { authHeaders } from "../lib/eden";
import { useRecentLocationsStore } from "../stores/recent-locations";
import { selectHermesConversationProgress } from "../lib/hermes-progress";
import { usePendingMessageJump } from "../lib/search-navigation";
import {
  useBotRuntime,
  useBotRuntimeCache,
  submitHermesSecureInput,
  submitHermesVaultUnlock,
} from "../hooks/useBotRuntime";

export function ChannelRoute() {
  const { id: channelId } = useParams({ from: "/channel/$id" });
  const { replyThread: requestedReplyRoot, replyMessage: requestedReplyMessage } =
    useSearch({ from: "/channel/$id" });
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const channelName = useWorkspacesStore(
    (s) => s.activeWorkspace?.channels.find((channel) => channel.id === channelId)?.name ?? "channel",
  );
  const replyThreads = useReplyThreadPanel(channelId, {
    requestedRootId: requestedReplyRoot,
    requestedHighlightId: requestedReplyMessage,
    routeTo: "/channel/$id",
  });
  useEffect(() => {
    const recents = useRecentLocationsStore.getState();
    recents.enter({ conversationId: channelId, type: "group", threadId: null });
    return () => useRecentLocationsStore.getState().leave(channelId);
  }, [channelId]);
  const user = useAuthStore((s) => s.user);
  const activeWorkspace = useWorkspacesStore((s) => s.activeWorkspace);
  const members = activeWorkspace?.members;
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

  const channelIsVisible = activeWorkspace?.channels.some(
    (channel) => channel.id === channelId,
  );
  const activeWorkspaceId = activeWorkspace?.id;

  // A channel missing from the sidebar is not proof that it is hidden: it may
  // belong to a workspace that is still being selected (Inbox, notification
  // links) or have been created while this client was offline. Only the
  // server refusing it sends the reader to a channel they can see.
  useEffect(() => {
    if (!activeWorkspaceId || channelIsVisible || !isAuthenticated(token)) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await api.conversations
        .detail({ conversationId: channelId })
        .get(authHeaders(token));
      if (cancelled) return;
      const workspaces = useWorkspacesStore.getState();
      const current = workspaces.activeWorkspace;
      if (!current || current.id !== activeWorkspaceId) return;
      if (!error) {
        // Readable but unlisted: bring a stale channel list up to date.
        const detail = data as { workspaceId: string | null };
        if (
          detail.workspaceId === current.id &&
          !current.channels.some((channel) => channel.id === channelId)
        ) {
          void workspaces.selectWorkspace(current.id);
        }
        return;
      }
      // Eden types only the validation error; the service answers 403.
      const status: number = error.status;
      if (status !== 403 && status !== 404) return;
      if (current.channels.some((channel) => channel.id === channelId)) return;
      const fallbackChannel =
        current.channels.find((channel) => channel.name === "general") ??
        current.channels[0];
      if (fallbackChannel) {
        navigate({
          to: "/channel/$id",
          params: { id: fallbackChannel.id },
          replace: true,
        });
        return;
      }
      navigate({ to: "/", replace: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, channelId, channelIsVisible, navigate, token]);

  // In a private channel only its members can be reached by a mention.
  const currentChannel = activeWorkspace?.channels.find(
    (channel) => channel.id === channelId,
  );
  const mentions = useMemo(
    () =>
      members
        ?.filter((m) => m.userId !== user?.id)
        .filter((m) => channelIncludes(currentChannel, m.userId))
        .map((m) => ({
          id: m.userId,
          label: m.user.name,
          type: m.user.type,
          picture: m.user.avatar,
          botAvatar:
            m.user.type === "bot"
              ? botAppearanceFor(m.userId, m.bot?.avatar)
              : undefined,
        })),
    [members, currentChannel, user?.id]
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
  // "Open conversation" from a message: open the channel at that message.
  const { jump, onJumpDone } = usePendingMessageJump(channelId);

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

    const onTyping = ({ conversationId, parentMessageId, userId, userName }: WsEvents["ws:typing"]) => {
      if (conversationId !== channelId) return;
      // Typing in a reply thread is shown in the thread, not here.
      if (parentMessageId) return;

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
    <div className="relative flex min-h-0 flex-1">
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
          jump={jump}
          onJumpDone={onJumpDone}
          onOpenThread={replyThreads.onOpenThread}
          openThreadRootId={replyThreads.openThreadRootId}
          unreadThreadRootIds={replyThreads.unreadThreadRootIds}
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
      {replyThreads.openThreadRootId && (
        <ThreadPanel
          key={replyThreads.openThreadRootId}
          conversationId={channelId}
          conversationType="group"
          conversationName={channelName}
          rootMessageId={replyThreads.openThreadRootId}
          mentions={mentions}
        />
      )}
    </div>
  );
}
