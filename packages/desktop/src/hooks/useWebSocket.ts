import { useEffect, useRef, useCallback, useState } from "react";
import type { WsClientEvent, WsServerEvent, ChatMessage } from "@thechat/shared";

const WS_URL = (import.meta.env.VITE_API_URL || "http://localhost:3000")
  .replace(/^http/, "ws");

interface UseWebSocketOptions {
  token: string | null;
  onNewMessage?: (msg: ChatMessage, conversationType: "direct" | "group") => void;
  onTyping?: (conversationId: string, userId: string, userName: string) => void;
}

export function useWebSocket({ token, onNewMessage, onTyping }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // Stable refs for callbacks
  const onNewMessageRef = useRef(onNewMessage);
  onNewMessageRef.current = onNewMessage;
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;

  const connect = useCallback(() => {
    if (!tokenRef.current) return;

    const ws = new WebSocket(`${WS_URL}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      const event: WsClientEvent = { type: "auth", token: tokenRef.current! };
      ws.send(JSON.stringify(event));
    };

    ws.onmessage = (e) => {
      let event: WsServerEvent;
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }

      if (event.type === "auth_ok") {
        setConnected(true);
        reconnectAttempt.current = 0;
      } else if (event.type === "auth_error") {
        ws.close();
      } else if (event.type === "new_message") {
        onNewMessageRef.current?.(event.message, event.conversationType);
      } else if (event.type === "typing") {
        onTypingRef.current?.(event.conversationId, event.userId, event.userName);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;

      // Exponential backoff reconnect
      if (tokenRef.current) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempt.current), 30000);
        reconnectAttempt.current++;
        reconnectTimer.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }, []);

  useEffect(() => {
    if (token) {
      connect();
    } else {
      // Disconnect on logout
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnected(false);
    }

    return () => {
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [token, connect]);

  const sendMessage = useCallback((conversationId: string, content: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const event: WsClientEvent = { type: "send_message", conversationId, content };
      wsRef.current.send(JSON.stringify(event));
    }
  }, []);

  const sendTyping = useCallback((conversationId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const event: WsClientEvent = { type: "typing", conversationId };
      wsRef.current.send(JSON.stringify(event));
    }
  }, []);

  return { connected, sendMessage, sendTyping };
}
