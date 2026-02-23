import { create } from "zustand";
import type { WsClientEvent, WsServerEvent } from "@thechat/shared";
import { wsEvents } from "../lib/ws-events";

const WS_URL = __BACKEND_URL__.replace(/^http/, "ws");

interface WebSocketStore {
  connected: boolean;
  connect: (token: string) => void;
  disconnect: () => void;
  sendMessage: (conversationId: string, content: string) => void;
  sendTyping: (conversationId: string) => void;
}

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let currentToken: string | null = null;

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

    if (event.type === "auth_ok") {
      useWebSocketStore.setState({ connected: true });
      reconnectAttempt = 0;
    } else if (event.type === "auth_error") {
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
    useWebSocketStore.setState({ connected: false });
    ws = null;

    // Exponential backoff reconnect
    if (currentToken) {
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
      reconnectAttempt++;
      reconnectTimer = setTimeout(doConnect, delay);
    }
  };

  socket.onerror = () => {
    // onclose will fire after this
  };
}

export const useWebSocketStore = create<WebSocketStore>()(() => ({
  connected: false,

  connect: (token: string) => {
    currentToken = token;
    // Close existing connection
    if (ws) {
      ws.close();
      ws = null;
    }
    clearTimeout(reconnectTimer);
    reconnectAttempt = 0;
    doConnect();
  },

  disconnect: () => {
    currentToken = null;
    clearTimeout(reconnectTimer);
    if (ws) {
      ws.close();
      ws = null;
    }
    useWebSocketStore.setState({ connected: false });
  },

  sendMessage: (conversationId: string, content: string) => {
    if (ws?.readyState === WebSocket.OPEN) {
      const event: WsClientEvent = { type: "send_message", conversationId, content };
      ws.send(JSON.stringify(event));
    }
  },

  sendTyping: (conversationId: string) => {
    if (ws?.readyState === WebSocket.OPEN) {
      const event: WsClientEvent = { type: "typing", conversationId };
      ws.send(JSON.stringify(event));
    }
  },
}));
