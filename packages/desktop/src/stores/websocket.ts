import { create } from "zustand";
import type { WsClientEvent, WsServerEvent, ChatMessage, WorkspaceMember, WorkspaceMemberRole, WorkspaceInvite } from "@thechat/shared";

const WS_URL = __BACKEND_URL__.replace(/^http/, "ws");

type MessageCallback = (msg: ChatMessage, type: "direct" | "group") => void;
type TypingCallback = (conversationId: string, userId: string, userName: string) => void;
type MemberJoinedCallback = (workspaceId: string, member: WorkspaceMember) => void;
type MemberRoleChangedCallback = (workspaceId: string, userId: string, newRole: WorkspaceMemberRole) => void;
type MemberRemovedCallback = (workspaceId: string, userId: string) => void;
type InviteReceivedCallback = (invite: WorkspaceInvite) => void;

interface WebSocketStore {
  connected: boolean;
  connect: (token: string) => void;
  disconnect: () => void;
  sendMessage: (conversationId: string, content: string) => void;
  sendTyping: (conversationId: string) => void;
  subscribeToMessages: (cb: MessageCallback) => () => void;
  subscribeToTyping: (cb: TypingCallback) => () => void;
  subscribeToMemberJoined: (cb: MemberJoinedCallback) => () => void;
  subscribeToMemberRoleChanged: (cb: MemberRoleChangedCallback) => () => void;
  subscribeToMemberRemoved: (cb: MemberRemovedCallback) => () => void;
  subscribeToInviteReceived: (cb: InviteReceivedCallback) => () => void;
}

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let currentToken: string | null = null;

const messageListeners = new Set<MessageCallback>();
const typingListeners = new Set<TypingCallback>();
const memberJoinedListeners = new Set<MemberJoinedCallback>();
const memberRoleChangedListeners = new Set<MemberRoleChangedCallback>();
const memberRemovedListeners = new Set<MemberRemovedCallback>();
const inviteReceivedListeners = new Set<InviteReceivedCallback>();

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
      for (const cb of messageListeners) {
        cb(event.message, event.conversationType);
      }
    } else if (event.type === "typing") {
      for (const cb of typingListeners) {
        cb(event.conversationId, event.userId, event.userName);
      }
    } else if (event.type === "member_joined") {
      for (const cb of memberJoinedListeners) {
        cb(event.workspaceId, event.member);
      }
    } else if (event.type === "member_role_changed") {
      for (const cb of memberRoleChangedListeners) {
        cb(event.workspaceId, event.userId, event.newRole);
      }
    } else if (event.type === "member_removed") {
      for (const cb of memberRemovedListeners) {
        cb(event.workspaceId, event.userId);
      }
    } else if (event.type === "invite_received") {
      for (const cb of inviteReceivedListeners) {
        cb(event.invite);
      }
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

  subscribeToMessages: (cb: MessageCallback) => {
    messageListeners.add(cb);
    return () => {
      messageListeners.delete(cb);
    };
  },

  subscribeToTyping: (cb: TypingCallback) => {
    typingListeners.add(cb);
    return () => {
      typingListeners.delete(cb);
    };
  },

  subscribeToMemberJoined: (cb: MemberJoinedCallback) => {
    memberJoinedListeners.add(cb);
    return () => {
      memberJoinedListeners.delete(cb);
    };
  },

  subscribeToMemberRoleChanged: (cb: MemberRoleChangedCallback) => {
    memberRoleChangedListeners.add(cb);
    return () => {
      memberRoleChangedListeners.delete(cb);
    };
  },

  subscribeToMemberRemoved: (cb: MemberRemovedCallback) => {
    memberRemovedListeners.add(cb);
    return () => {
      memberRemovedListeners.delete(cb);
    };
  },

  subscribeToInviteReceived: (cb: InviteReceivedCallback) => {
    inviteReceivedListeners.add(cb);
    return () => {
      inviteReceivedListeners.delete(cb);
    };
  },
}));
