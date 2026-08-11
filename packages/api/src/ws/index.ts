import { Elysia } from "elysia";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { conversationParticipants } from "../db/schema";
import type { WsClientEvent, WsServerEvent } from "@thechat/shared";
import { resolveTokenToUser } from "../auth/middleware";
import { sendMessage } from "../services/messages";
import { requireConversationParticipant } from "../services/conversations";
import { ServiceError } from "../services/errors";
import { getRealtimeBus, publishWsEventToUsers } from "../realtime";
import {
  getPresenceRegistry,
  listSharedWorkspacePeerIds,
} from "../presence";
import { log } from "../logging";
import { deliverWebSocketEvent } from "./delivery";

const websocketLog = log.child({ component: "websocket" });

const wsClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().min(1) }),
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("typing"),
    conversationId: z.string().uuid(),
    threadId: z.string().uuid().nullable().optional(),
  }),
  z
    .object({
      type: z.literal("send_message"),
      conversationId: z.string().uuid(),
      clientMessageId: z.string().min(1).max(255).optional(),
      content: z.string().max(100_000).default(""),
      threadId: z.string().uuid().nullable().optional(),
      attachmentIds: z.array(z.string().uuid()).max(25).default([]),
    })
    .refine(
      (event) =>
        event.content.trim().length > 0 || event.attachmentIds.length > 0,
      { message: "Message text or at least one attachment is required" },
    ),
]);

// Connection tracking
const userSockets = new Map<string, Set<WebSocket>>();
type SocketUser = {
  id: string;
  name: string;
  token: string;
  type: "human" | "bot";
  presenceConnectionId?: string;
  presenceReady?: Promise<void>;
};
const socketUsers = new Map<WebSocket, SocketUser>();
const presenceSendQueues = new Map<WebSocket, Promise<void>>();

async function addSocket(
  userId: string,
  userName: string,
  userType: "human" | "bot",
  token: string,
  ws: WebSocket,
) {
  const existing = socketUsers.get(ws);
  if (existing?.id === userId && existing.type === userType) {
    existing.name = userName;
    existing.token = token;
    return;
  }

  if (existing) await removeSocket(ws);
  if (ws.readyState !== WebSocket.OPEN) return;

  const socketUser: SocketUser = {
    id: userId,
    name: userName,
    token,
    type: userType,
  };
  socketUsers.set(ws, socketUser);
  let sockets = userSockets.get(userId);
  if (!sockets) {
    sockets = new Set();
    userSockets.set(userId, sockets);
  }
  sockets.add(ws);

  if (userType === "human") {
    socketUser.presenceConnectionId = crypto.randomUUID();
    socketUser.presenceReady = activatePresence(ws, socketUser);
  }
}

async function removeSocket(ws: WebSocket) {
  const user = socketUsers.get(ws);
  if (!user) return;

  const sockets = userSockets.get(user.id);
  if (sockets) {
    sockets.delete(ws);
    if (sockets.size === 0) userSockets.delete(user.id);
  }
  socketUsers.delete(ws);

  if (!user.presenceConnectionId) return;
  try {
    await user.presenceReady;
    const becameOffline = await getPresenceRegistry().markOffline(
      user.id,
      user.presenceConnectionId,
    );
    if (becameOffline) await broadcastPresenceChanged(user.id, false);
  } catch (error) {
    websocketLog.warn(
      { err: error, userId: user.id },
      "Failed to clear websocket presence",
    );
  }
}

function sendTo(ws: WebSocket, event: WsServerEvent) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

export function broadcastToUser(userId: string, event: WsServerEvent) {
  void publishWsEventToUsers([userId], event).catch((error) => {
    websocketLog.error({ err: error }, "Failed to publish websocket event");
  });
}

export async function broadcastToUsers(
  userIds: string[],
  event: WsServerEvent,
) {
  await publishWsEventToUsers(userIds, event);
}

async function tryBroadcastToUsers(userIds: string[], event: WsServerEvent) {
  try {
    await broadcastToUsers(userIds, event);
  } catch (error) {
    websocketLog.error({ err: error }, "Failed to publish websocket event");
  }
}

async function broadcastPresenceChanged(userId: string, online: boolean) {
  const peerIds = await listSharedWorkspacePeerIds(userId);
  await tryBroadcastToUsers(peerIds, {
    type: "presence_changed",
    userId,
    online,
  });
}

async function activatePresence(ws: WebSocket, socketUser: SocketUser) {
  const connectionId = socketUser.presenceConnectionId;
  if (!connectionId) return;

  try {
    const becameOnline = await getPresenceRegistry().markOnline(
      socketUser.id,
      connectionId,
    );
    const peerIds = await listSharedWorkspacePeerIds(socketUser.id);
    if (becameOnline) {
      await tryBroadcastToUsers(peerIds, {
        type: "presence_changed",
        userId: socketUser.id,
        online: true,
      });
    }
    await sendPresenceSnapshot(ws, peerIds, true);
  } catch (error) {
    websocketLog.warn(
      { err: error, userId: socketUser.id },
      "Failed to establish websocket presence",
    );
  }
}

async function refreshPresence(ws: WebSocket, socketUser: SocketUser) {
  if (!socketUser.presenceConnectionId) return;

  try {
    await socketUser.presenceReady;
    const becameOnline = await getPresenceRegistry().markOnline(
      socketUser.id,
      socketUser.presenceConnectionId,
    );
    const peerIds = await listSharedWorkspacePeerIds(socketUser.id);
    if (becameOnline) {
      await tryBroadcastToUsers(peerIds, {
        type: "presence_changed",
        userId: socketUser.id,
        online: true,
      });
    }
    await sendPresenceSnapshot(ws, peerIds);
  } catch (error) {
    websocketLog.warn(
      { err: error, userId: socketUser.id },
      "Failed to refresh presence",
    );
  }
}

async function refreshAuthenticatedPresence(ws: WebSocket, socketUser: SocketUser) {
  let currentUser: Awaited<ReturnType<typeof validateToken>>;
  try {
    currentUser = await validateToken(socketUser.token);
  } catch (error) {
    // An auth-store outage is not proof of revocation. Do not renew the lease;
    // expiry will degrade this connection to unknown/offline if validation stays unavailable.
    websocketLog.warn(
      { err: error, userId: socketUser.id },
      "Presence heartbeat validation failed",
    );
    return;
  }

  if (socketUsers.get(ws) !== socketUser) return;

  if (
    !currentUser ||
    currentUser.id !== socketUser.id ||
    currentUser.type !== "human"
  ) {
    await removeSocket(ws);
    ws.close();
    return;
  }

  socketUser.name = currentUser.name;
  socketUser.type = currentUser.type;
  await refreshPresence(ws, socketUser);
}

async function queuePresenceSend(
  ws: WebSocket,
  operation: () => Promise<void> | void,
) {
  const previous = presenceSendQueues.get(ws) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  presenceSendQueues.set(ws, current);
  try {
    await current;
  } finally {
    if (presenceSendQueues.get(ws) === current) {
      presenceSendQueues.delete(ws);
    }
  }
}

async function sendPresenceSnapshot(
  ws: WebSocket,
  peerIds: string[],
  skipWhenEmpty = false,
) {
  // Accounts without workspace peers do not need an unsolicited post-auth
  // event, but heartbeat snapshots must include [] so membership removals and
  // expired leases clear stale dots.
  if (skipWhenEmpty && peerIds.length === 0) return;
  await queuePresenceSend(ws, async () => {
    const userIds = await getPresenceRegistry().onlineUserIds(peerIds);
    sendTo(ws, { type: "presence_snapshot", userIds });
  });
}

async function deliverPresenceToLocalSocket(
  userId: string,
  event: WsServerEvent,
  ws: WebSocket,
) {
  await queuePresenceSend(ws, async () => {
    const socketUser = socketUsers.get(ws);
    if (!socketUser || socketUser.id !== userId) {
      await removeSocket(ws);
      return;
    }

    try {
      const currentUser = await validateToken(socketUser.token);
      if (socketUsers.get(ws) !== socketUser) return;
      if (!currentUser || currentUser.id !== socketUser.id) {
        await removeSocket(ws);
        ws.close();
        return;
      }
      socketUser.name = currentUser.name;
      socketUser.type = currentUser.type;
    } catch (error) {
      websocketLog.error(
        { err: error, userId },
        "WebSocket presence delivery revalidation failed",
      );
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) return;
    const result = await deliverWebSocketEvent(event, [ws]);
    if (result.failed > 0) {
      websocketLog.warn(
        { sent: result.sent, failed: result.failed },
        "WebSocket presence delivery was incomplete",
      );
    }
  });
}

async function deliverToLocalUser(userId: string, event: WsServerEvent) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;

  if (event.type === "presence_snapshot" || event.type === "presence_changed") {
    await Promise.all(
      [...sockets].map((ws) => deliverPresenceToLocalSocket(userId, event, ws)),
    );
    return;
  }

  // Revalidate each distinct session token before delivering private inbound
  // events. Session rows are shared by every replica, so this closes the gap
  // where a logged-out/expired socket could no longer mutate state but could
  // continue receiving messages indefinitely. Dedupe lookups for multiple
  // local sockets sharing one session token within this delivery.
  const validations = new Map<
    string,
    Promise<Awaited<ReturnType<typeof validateToken>>>
  >();
  const validSockets: WebSocket[] = [];
  await Promise.all(
    [...sockets].map(async (ws) => {
      const socketUser = socketUsers.get(ws);
      if (!socketUser || socketUser.id !== userId) {
        await removeSocket(ws);
        return;
      }

      let validation = validations.get(socketUser.token);
      if (!validation) {
        validation = validateToken(socketUser.token);
        validations.set(socketUser.token, validation);
      }

      try {
        const currentUser = await validation;
        if (socketUsers.get(ws) !== socketUser) return;
        if (!currentUser || currentUser.id !== socketUser.id) {
          await removeSocket(ws);
          ws.close();
          return;
        }
        socketUser.name = currentUser.name;
        validSockets.push(ws);
      } catch (error) {
        // An authentication-store outage is not proof that the token is
        // invalid. Fail closed for this event without misclassifying or
        // permanently disconnecting the session; the next event retries.
        websocketLog.error(
          { err: error, userId },
          "WebSocket inbound session revalidation failed",
        );
      }
    }),
  );

  const openSockets = validSockets.filter(
    (socket) => socket.readyState === WebSocket.OPEN,
  );
  const result = await deliverWebSocketEvent(event, openSockets);
  if (result.failed > 0) {
    websocketLog.warn(
      { sent: result.sent, failed: result.failed },
      "WebSocket event delivery was incomplete",
    );
  }
}

let realtimeSubscriptionStarted = false;

function startRealtimeSubscription() {
  if (realtimeSubscriptionStarted) return;
  realtimeSubscriptionStarted = true;
  void getRealtimeBus()
    .subscribe(async (event) => {
      if (event.type !== "ws.event") return;
      await Promise.all(
        event.targetUserIds.map((userId) =>
          deliverToLocalUser(userId, event.event),
        ),
      );
    })
    .catch((error) => {
      realtimeSubscriptionStarted = false;
      websocketLog.error(
        { err: error },
        "Failed to subscribe to realtime events",
      );
      setTimeout(startRealtimeSubscription, 1_000);
    });
}

startRealtimeSubscription();

async function validateToken(token: string) {
  const user = await resolveTokenToUser(token);
  if (!user) {
    websocketLog.warn(
      {
        tokenType: typeof token,
        tokenLength: typeof token === "string" ? token.length : null,
        tokenParts: typeof token === "string" ? token.split(".").length : null,
      },
      "WebSocket bearer token validation failed",
    );
    return null;
  }
  return { id: user.id, name: user.name, type: user.type };
}

async function handleSendMessage(
  ws: WebSocket,
  userId: string,
  userName: string,
  conversationId: string,
  content: string,
  threadId?: string | null,
  clientMessageId?: string,
  attachmentIds: string[] = [],
) {
  try {
    await sendMessage(conversationId, userId, userName, content, {
      threadId: threadId ?? null,
      clientMessageId,
      attachmentIds,
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      sendTo(
        ws,
        clientMessageId
          ? {
              type: "message_error",
              conversationId,
              clientMessageId,
              message: e.message,
            }
          : { type: "error", message: e.message },
      );
      return;
    }
    throw e;
  }
}

async function handleTyping(
  ws: WebSocket,
  userId: string,
  userName: string,
  conversationId: string,
  threadId?: string | null,
) {
  try {
    await requireConversationParticipant(conversationId, userId);

    const participants = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, conversationId));

    const event: WsServerEvent = {
      type: "typing",
      conversationId,
      threadId: threadId ?? null,
      userId,
      userName,
    };

    await tryBroadcastToUsers(
      participants.filter((p) => p.userId !== userId).map((p) => p.userId),
      event,
    );
  } catch (error) {
    if (error instanceof ServiceError) {
      sendTo(ws, { type: "error", message: error.message });
      return;
    }
    throw error;
  }
}

export const wsRoutes = new Elysia().ws("/ws", {
  open(_ws) {
    // Wait for auth message
  },
  async message(ws, rawMessage) {
    let event: WsClientEvent;
    try {
      const candidate =
        typeof rawMessage === "string" ? JSON.parse(rawMessage) : rawMessage;
      event = wsClientEventSchema.parse(candidate) as WsClientEvent;
    } catch {
      sendTo(ws.raw as unknown as WebSocket, {
        type: "error",
        message: "Invalid JSON",
      });
      return;
    }

    const socket = ws.raw as unknown as WebSocket;

    if (event.type === "ping") {
      sendTo(socket, { type: "pong" });
      const socketUser = socketUsers.get(socket);
      if (socketUser?.type === "human") {
        void refreshAuthenticatedPresence(socket, socketUser);
      }
      return;
    }

    if (event.type === "auth") {
      let user: Awaited<ReturnType<typeof validateToken>>;
      try {
        user = await validateToken(event.token);
      } catch (error) {
        websocketLog.error(
          { err: error },
          "WebSocket authentication store unavailable",
        );
        sendTo(socket, {
          type: "auth_error",
          message: "Authentication service temporarily unavailable",
        });
        return;
      }
      if (!user) {
        sendTo(socket, {
          type: "auth_error",
          message: "Invalid or expired token",
        });
        ws.close();
        return;
      }
      await addSocket(user.id, user.name, user.type, event.token, socket);
      sendTo(socket, { type: "auth_ok", userId: user.id });
      return;
    }

    // All other events require auth
    const socketUser = socketUsers.get(socket);
    if (!socketUser) {
      sendTo(
        socket,
        event.type === "send_message" && event.clientMessageId
          ? {
              type: "message_error",
              conversationId: event.conversationId,
              clientMessageId: event.clientMessageId,
              message: "Not authenticated",
            }
          : { type: "error", message: "Not authenticated" },
      );
      return;
    }

    // Session rows are shared by all replicas, so revalidating before every
    // client-originated state/event mutation observes logout and expiry even
    // when the socket and logout request reached different API pods.
    let currentUser: Awaited<ReturnType<typeof validateToken>>;
    try {
      currentUser = await validateToken(socketUser.token);
    } catch (error) {
      websocketLog.error(
        { err: error, userId: socketUser.id },
        "WebSocket authentication store unavailable during revalidation",
      );
      sendTo(
        socket,
        event.type === "send_message" && event.clientMessageId
          ? {
              type: "message_error",
              conversationId: event.conversationId,
              clientMessageId: event.clientMessageId,
              message: "Authentication service temporarily unavailable",
            }
          : {
              type: "auth_error",
              message: "Authentication service temporarily unavailable",
            },
      );
      return;
    }
    if (socketUsers.get(socket) !== socketUser) return;
    if (!currentUser || currentUser.id !== socketUser.id) {
      sendTo(
        socket,
        event.type === "send_message" && event.clientMessageId
          ? {
              type: "message_error",
              conversationId: event.conversationId,
              clientMessageId: event.clientMessageId,
              message: "Session expired or revoked",
            }
          : { type: "auth_error", message: "Session expired or revoked" },
      );
      await removeSocket(socket);
      ws.close();
      return;
    }
    socketUser.name = currentUser.name;

    if (event.type === "send_message") {
      await handleSendMessage(
        socket,
        socketUser.id,
        socketUser.name,
        event.conversationId,
        event.content,
        event.threadId ?? null,
        event.clientMessageId,
        event.attachmentIds ?? [],
      );
    } else if (event.type === "typing") {
      await handleTyping(
        socket,
        socketUser.id,
        socketUser.name,
        event.conversationId,
        event.threadId ?? null,
      );
    }
  },
  close(ws) {
    void removeSocket(ws.raw as unknown as WebSocket);
  },
});
