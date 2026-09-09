import { useState, useEffect, useRef, useMemo } from "react";
import { MessageContextView } from "../components/MessageContextView";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useWebSocketStore } from "../stores/websocket";
import { useConversationsStore } from "../stores/conversations";
import { useWorkspacesStore } from "../stores/workspaces";
import { composerDraftKey } from "../stores/composer-drafts";
import { requestInputBarFocus } from "../stores/input-focus";
import { useChannelChat } from "../hooks/useChannelChat";
import { usePersistConversationRead } from "../hooks/usePersistConversationRead";
import { ChannelChatView } from "../components/ChannelChatView";
import { wsEvents, type WsEvents } from "../lib/ws-events";

export function ChannelRoute() {
  const { id } = useParams({ from: "/channel/$id" });
  const { messageId, threadId, jump } = useSearch({ from: "/channel/$id" });
  if (messageId) return <MessageContextView conversationId={id} threadId={threadId} messageId={messageId} route="/channel/$id" />;
  return <ChannelLiveRoute key={`${id}:${threadId ?? ""}:${jump ?? ""}`} threadId={threadId} />;
}

function ChannelLiveRoute({ threadId }: { threadId?: string }) {
  const navigate = useNavigate();
  const { id: channelId } = useParams({ from: "/channel/$id" });
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const members = useWorkspacesStore((s) => s.activeWorkspace?.members);
  const wsSendMessage = useWebSocketStore((s) => s.sendMessage);

  const mentions = useMemo(
    () =>
      members
        ?.filter((m) => m.userId !== user?.id)
        .map((m) => ({ id: m.userId, label: m.user.name, type: m.user.type })),
    [members, user?.id]
  );

  const channelChat = useChannelChat({
    conversationId: channelId,
    threadId,
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

  async function backToChannel() {
    await navigate({
      to: "/channel/$id",
      params: { id: channelId },
      search: {
        threadId: undefined,
        messageId: undefined,
        jump: crypto.randomUUID(),
      },
    });
    requestInputBarFocus();
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {threadId && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-elevated px-4 py-3 text-text">
            <h1 className="text-sm font-semibold">Task</h1>
            <button
              onClick={() => void backToChannel()}
              className="rounded border border-border bg-surface px-3 py-2 text-sm hover:bg-hover"
            >
              Back to channel
            </button>
          </div>
        )}
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
          scrollKey={threadId ? `${channelId}:thread:${threadId}` : channelId}
          draftKey={composerDraftKey.channel(user?.id, channelId, threadId)}
          conversationId={channelId}
          token={token}
        />
      </div>
    </div>
  );
}
