import { create } from "zustand";
import type { WsClientEvent, WsServerEvent } from "@thechat/shared";
import { wsEvents } from "../lib/ws-events";

const WS_URL = __BACKEND_URL__.replace(/^http/, "ws");

const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 5_000;

interface WebSocketStore {
  connected: boolean;
  reconnecting: boolean;
  connect: (token: string) => void;
  disconnect: () => void;
  sendMessage: (conversationId: string, content: string) => void;
  sendTyping: (conversationId: string) => void;
}

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let pongTimer: ReturnType<typeof setTimeout> | undefined;
let currentToken: string | null = null;
let pendingMessages: WsClientEvent[] = [];

function clearTimers() {
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  clearTimeout(pongTimer);
}

function startHeartbeat() {
  clearInterval(pingTimer);
  clearTimeout(pongTimer);

  pingTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
      pongTimer = setTimeout(() => {
        // No pong received — connection is stale, force reconnect
        ws?.close();
      }, PONG_TIMEOUT);
    }
  }, PING_INTERVAL);
}

function flushPendingMessages() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const messages = pendingMessages;
  pendingMessages = [];
  for (const msg of messages) {
    ws.send(JSON.stringify(msg));
  }
}

function doConnect() {
  if (!currentToken) return;

  const socket = new WebSocket(`${WS_URL}/ws`);
  ws = socket;

  socket.onopen = () => {
    const event: WsClientEvent = { type: "auth", token: currentToken! };
    socket.send(JSON.stringify(event));
  };

  socket.onmessage = (e) => {
    let event: WsServerEvent;
    try {
      event = JSON.parse(e.data);
    } catch {
      return;
    }

    if (event.type === "pong") {
      clearTimeout(pongTimer);
      return;
    }

    if (event.type === "auth_ok") {
      useWebSocketStore.setState({ connected: true, reconnecting: false });
      reconnectAttempt = 0;
      startHeartbeat();
      flushPendingMessages();
    } else if (event.type === "auth_error") {
      currentToken = null;
      socket.close();
    } else if (event.type === "new_message") {
      wsEvents.emit("ws:new_message", {
        message: event.message,
        conversationType: event.conversationType,
      });
    } else if (event.type === "typing") {
      wsEvents.emit("ws:typing", {
        conversationId: event.conversationId,
        userId: event.userId,
        userName: event.userName,
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
    } else if (event.type === "member_removed") {
      wsEvents.emit("ws:member_removed", {
        workspaceId: event.workspaceId,
        userId: event.userId,
      });
    } else if (event.type === "invite_received") {
      wsEvents.emit("ws:invite_received", {
        invite: event.invite,
      });
    }
  };

  socket.onclose = () => {
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
    ws = null;

    const shouldReconnect = !!currentToken;
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
    // onclose will fire after this
  };
}

function handleVisibilityChange() {
  if (
    document.visibilityState === "visible" &&
    currentToken &&
    (!ws || ws.readyState === WebSocket.CLOSED)
  ) {
    clearTimers();
    reconnectAttempt = 0;
    doConnect();
  }
}

document.addEventListener("visibilitychange", handleVisibilityChange);

export const useWebSocketStore = create<WebSocketStore>()(() => ({
  connected: false,
  reconnecting: false,

  connect: (token: string) => {
    currentToken = token;
    pendingMessages = [];
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
    pendingMessages = [];
    clearTimers();
    if (ws) {
      ws.close();
      ws = null;
    }
    useWebSocketStore.setState({ connected: false, reconnecting: false });
  },

  sendMessage: (conversationId: string, content: string) => {
    const event: WsClientEvent = {
      type: "send_message",
      conversationId,
      content,
    };
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    } else {
      pendingMessages.push(event);
    }
  },

  sendTyping: (conversationId: string) => {
    if (ws?.readyState === WebSocket.OPEN) {
      const event: WsClientEvent = { type: "typing", conversationId };
      ws.send(JSON.stringify(event));
    }
  },
}));
