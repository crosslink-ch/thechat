import { useAuthStore } from "./auth";
import { expireBrowserSession, onSessionReset } from "../lib/session-boundary";
import { isWeb } from "../platform/environment";
import { API_URL } from "../lib/api";
import { create } from "zustand";
import type { WsClientEvent, WsServerEvent } from "@thechat/shared";
import {
  contextFromRemoteTrace,
  SpanKind,
  withDesktopSpan,
} from "../lib/telemetry";
import { wsEvents } from "../lib/ws-events";
import { usePresenceStore } from "./presence";

const WS_URL = isWeb && __WEB_WS_URL__ ? __WEB_WS_URL__ : `${API_URL.replace(/^http/, "ws")}/ws`;

const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 5_000;

interface WebSocketStore {
  connected: boolean;
  reconnecting: boolean;
  connect: (token: string | null) => void;
  disconnect: () => void;
  sendMessage: (
    conversationId: string,
    content: string,
    threadId?: string | null,
    clientMessageId?: string,
    attachmentIds?: string[],
  ) => void;
  sendTyping: (conversationId: string, threadId?: string | null) => void;
}

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let pongTimer: ReturnType<typeof setTimeout> | undefined;
let currentToken: string | null = null;
let sessionRequested = false;
let authenticated = false;
let connectedUserId: string | null = null;
let pendingMessages: WsClientEvent[] = [];

export const WEBSOCKET_BOUNDARY_EVENT = "thechat:websocket-boundary";

type WebSocketBoundaryDetail = {
  operation:
    | "send_message_requested"
    | "message_queued"
    | "pending_flush_started"
    | "message_transported";
  conversationId?: string;
  threadId?: string | null;
  pendingMessageCount: number;
  pendingEventTypes?: string[];
};

function recordWebSocketBoundary(detail: WebSocketBoundaryDetail) {
  window.dispatchEvent(
    new CustomEvent<WebSocketBoundaryDetail>(WEBSOCKET_BOUNDARY_EVENT, {
      detail,
    }),
  );
}

function clearTimers() {
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  clearTimeout(pongTimer);
}

function startHeartbeat() {
  clearInterval(pingTimer);
  clearTimeout(pongTimer);

  pingTimer = setInterval(() => {
    if (authenticated && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));

onSessionReset(() => { if (isWeb) useWebSocketStore.getState().disconnect(); });
      pongTimer = setTimeout(() => {
        // No pong received — connection is stale, force reconnect
        ws?.close();
      }, PONG_TIMEOUT);
    }
  }, PING_INTERVAL);
}

function flushPendingMessages() {
  if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) return;
  const messages = pendingMessages;
  recordWebSocketBoundary({
    operation: "pending_flush_started",
    pendingMessageCount: messages.length,
    pendingEventTypes: messages.map((message) => message.type),
  });
  pendingMessages = [];
  for (const msg of messages) {
    ws.send(JSON.stringify(msg));
    if (msg.type === "send_message") {
      recordWebSocketBoundary({
        operation: "message_transported",
        conversationId: msg.conversationId,
        threadId: msg.threadId,
        pendingMessageCount: pendingMessages.length,
      });
    }
  }
}

function doConnect() {
  if (!sessionRequested) return;
  authenticated = false;

  const socket = new WebSocket(WS_URL);
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) {
      socket.close();
      return;
    }
    const event = isWeb ? { type: "auth", mode: "cookie" } as const : { type: "auth", token: currentToken! } as const;
    socket.send(JSON.stringify(event));
  };

  socket.onmessage = (e) => {
    if (ws !== socket) return;
    let event: WsServerEvent;
    try {
      event = JSON.parse(e.data);
    } catch {
      return;
    }

    if (!authenticated && event.type !== "auth_ok" && event.type !== "auth_error") return;

    if (event.type === "pong") {
      clearTimeout(pongTimer);
      return;
    }

    if (event.type === "auth_ok") {
      if (isWeb && (!connectedUserId || event.userId !== connectedUserId)) {
        expireBrowserSession();
        void useAuthStore.getState().initialize();
        return;
      }
      authenticated = true;
      useWebSocketStore.setState({ connected: true, reconnecting: false });
      reconnectAttempt = 0;
      startHeartbeat();
      flushPendingMessages();
      wsEvents.emit("ws:authenticated", {});
    } else if (event.type === "auth_error") {
      authenticated = false;
      if (!("retryable" in event && event.retryable === true)) {
        sessionRequested = false;
        currentToken = null;
        pendingMessages = [];
        if (isWeb) expireBrowserSession();
      }
      socket.close();
    } else if (event.type === "new_message") {
      void withDesktopSpan(
        "realtime.message.receive",
        {
          "messaging.system": "thechat-websocket",
          "messaging.operation": "receive",
          "thechat.message.attachment_count":
            event.message.attachments?.length ?? 0,
        },
        (span) => {
          wsEvents.emit("ws:new_message", {
            message: event.message,
            conversationType: event.conversationType,
            clientMessageId: event.clientMessageId,
          });
          span.setAttribute("thechat.realtime.outcome", "handled");
        },
        {
          kind: SpanKind.CONSUMER,
          parentContext: contextFromRemoteTrace(event.traceContext),
        },
      );
    } else if (event.type === "message_reactions_updated") {
      wsEvents.emit("ws:message_reactions_updated", {
        conversationId: event.conversationId,
        messageId: event.messageId,
      });
    } else if (event.type === "message_error") {
      wsEvents.emit("ws:message_error", {
        conversationId: event.conversationId,
        clientMessageId: event.clientMessageId,
        message: event.message,
      });
    } else if (event.type === "bot_invocation_updated") {
      wsEvents.emit("ws:bot_invocation_updated", {
        conversationId: event.conversationId,
        invocation: event.invocation,
      });
    } else if (event.type === "bot_invocation_progress") {
      wsEvents.emit("ws:bot_invocation_progress", {
        conversationId: event.conversationId,
        invocationId: event.invocationId,
        event: event.event,
        invocation: event.invocation,
      });
    } else if (event.type === "conversation_thread_updated") {
      wsEvents.emit("ws:conversation_thread_updated", {
        conversationId: event.conversationId,
        thread: event.thread,
      });
    } else if (event.type === "typing") {
      wsEvents.emit("ws:typing", {
        conversationId: event.conversationId,
        threadId: event.threadId,
        userId: event.userId,
        userName: event.userName,
      });
    } else if (event.type === "presence_snapshot") {
      wsEvents.emit("ws:presence_snapshot", { userIds: event.userIds });
    } else if (event.type === "presence_changed") {
      wsEvents.emit("ws:presence_changed", {
        userId: event.userId,
        online: event.online,
      });
    } else if (event.type === "member_joined") {
      wsEvents.emit("ws:member_joined", {
        workspaceId: event.workspaceId,
        member: event.member,
      });
    } else if (event.type === "member_role_changed") {
      wsEvents.emit("ws:member_role_changed", {
        workspaceId: event.workspaceId,
        userId: event.userId,
        newRole: event.newRole,
      });
    } else if (event.type === "member_updated") {
      wsEvents.emit("ws:member_updated", {
        workspaceId: event.workspaceId,
        userId: event.userId,
        name: event.name,
      });
    } else if (event.type === "member_removed") {
      wsEvents.emit("ws:member_removed", {
        workspaceId: event.workspaceId,
        userId: event.userId,
      });
    } else if (event.type === "channel_created") {
      wsEvents.emit("ws:channel_created", {
        workspaceId: event.workspaceId,
        channel: event.channel,
      });
    } else if (event.type === "channel_renamed") {
      wsEvents.emit("ws:channel_renamed", {
        workspaceId: event.workspaceId,
        channel: event.channel,
      });
    } else if (event.type === "channel_deleted") {
      wsEvents.emit("ws:channel_deleted", {
        workspaceId: event.workspaceId,
        channelId: event.channelId,
      });
    } else if (event.type === "invite_received") {
      wsEvents.emit("ws:invite_received", {
        invite: event.invite,
      });
    } else if (event.type === "bot_workspace_invite_received") {
      wsEvents.emit("ws:bot_workspace_invite_received", {
        invite: event.invite,
      });
    } else if (event.type === "bot_workspace_invite_resolved") {
      wsEvents.emit("ws:bot_workspace_invite_resolved", {
        inviteId: event.inviteId,
        workspaceId: event.workspaceId,
        botId: event.botId,
        status: event.status,
      });
    }
  };

  socket.onclose = () => {
    // Ignore a late close from a socket that was already replaced by connect().
    if (ws !== socket) return;
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
    ws = null;
    authenticated = false;
    usePresenceStore.getState().clear();

    const shouldReconnect = sessionRequested;
    useWebSocketStore.setState({
      connected: false,
      reconnecting: shouldReconnect,
    });

    if (shouldReconnect) {
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30_000);
      reconnectAttempt++;
      reconnectTimer = setTimeout(doConnect, delay);
    }
  };

  socket.onerror = () => {
    if (ws !== socket) return;
    // onclose will fire after this
  };
}

function handleVisibilityChange() {
  if (
    document.visibilityState === "visible" &&
    sessionRequested &&
    (!ws || ws.readyState === WebSocket.CLOSED)
  ) {
    clearTimers();
    reconnectAttempt = 0;
    doConnect();
  }
}

document.addEventListener("visibilitychange", handleVisibilityChange);

function disposeWebSocketModule() {
  currentToken = null;
  sessionRequested = false;
  authenticated = false;
  pendingMessages = [];
  clearTimers();
  usePresenceStore.getState().clear();
  document.removeEventListener("visibilitychange", handleVisibilityChange);

  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  ws.close();
  ws = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(disposeWebSocketModule);
}

export const useWebSocketStore = create<WebSocketStore>()(() => ({
  connected: false,
  reconnecting: false,

  connect: (token: string | null) => {
    currentToken = isWeb ? null : token;
    connectedUserId = useAuthStore.getState().user?.id ?? null;
    sessionRequested = isWeb ? Boolean(connectedUserId) : Boolean(token);
    authenticated = false;
    useWebSocketStore.setState({ connected: false, reconnecting: false });
    pendingMessages = [];
    usePresenceStore.getState().clear();
    if (ws) {
      ws.close();
      ws = null;
    }
    clearTimers();
    reconnectAttempt = 0;
    doConnect();
  },

  disconnect: () => {
    currentToken = null;
    sessionRequested = false;
    authenticated = false;
    pendingMessages = [];
    clearTimers();
    usePresenceStore.getState().clear();
    if (ws) {
      ws.close();
      ws = null;
    }
    useWebSocketStore.setState({ connected: false, reconnecting: false });
  },

  sendMessage: (
    conversationId: string,
    content: string,
    threadId?: string | null,
    clientMessageId?: string,
    attachmentIds?: string[],
  ) => {
    recordWebSocketBoundary({
      operation: "send_message_requested",
      conversationId,
      threadId: threadId ?? null,
      pendingMessageCount: pendingMessages.length,
    });
    const event: WsClientEvent = {
      type: "send_message",
      conversationId,
      content,
      threadId: threadId ?? null,
      clientMessageId,
      attachmentIds,
    };
    if (authenticated && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
      recordWebSocketBoundary({
        operation: "message_transported",
        conversationId,
        threadId: threadId ?? null,
        pendingMessageCount: pendingMessages.length,
      });
    } else {
      pendingMessages.push(event);
      recordWebSocketBoundary({
        operation: "message_queued",
        conversationId,
        threadId: threadId ?? null,
        pendingMessageCount: pendingMessages.length,
      });
    }
  },

  sendTyping: (conversationId: string, threadId?: string | null) => {
    if (authenticated && ws?.readyState === WebSocket.OPEN) {
      const event: WsClientEvent = {
        type: "typing",
        conversationId,
        threadId: threadId ?? null,
      };
      ws.send(JSON.stringify(event));
    }
  },
}));

onSessionReset(() => { if (isWeb) useWebSocketStore.getState().disconnect(); });
