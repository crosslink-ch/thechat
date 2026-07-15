import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { conversations, conversationParticipants } from "../db/schema";
import type { WsClientEvent, WsServerEvent } from "@thechat/shared";
import { resolveTokenToUser } from "../auth/middleware";
import { sendMessage } from "../services/messages";
import { ServiceError } from "../services/errors";
import { getRealtimeBus, publishWsEventToUsers } from "../realtime";
import { log } from "../logging";

const websocketLog = log.child({ component: "websocket" });

// Connection tracking
const userSockets = new Map<string, Set<WebSocket>>();
const socketUsers = new Map<
  WebSocket,
  { id: string; name: string; token: string }
>();

function addSocket(
  userId: string,
  userName: string,
  token: string,
  ws: WebSocket,
) {
  removeSocket(ws);
  socketUsers.set(ws, { id: userId, name: userName, token });
  let sockets = userSockets.get(userId);
  if (!sockets) {
    sockets = new Set();
    userSockets.set(userId, sockets);
  }
  sockets.add(ws);
}

function removeSocket(ws: WebSocket) {
  const user = socketUsers.get(ws);
  if (user) {
    const sockets = userSockets.get(user.id);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) userSockets.delete(user.id);
    }
    socketUsers.delete(ws);
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

export async function broadcastToUsers(userIds: string[], event: WsServerEvent) {
  await publishWsEventToUsers(userIds, event);
}

async function tryBroadcastToUsers(userIds: string[], event: WsServerEvent) {
  try {
    await broadcastToUsers(userIds, event);
  } catch (error) {
    websocketLog.error({ err: error }, "Failed to publish websocket event");
  }
}

async function deliverToLocalUser(userId: string, event: WsServerEvent) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;

  // Revalidate each distinct session token before delivering private inbound
  // events. Session rows are shared by every replica, so this closes the gap
  // where a logged-out/expired socket could no longer mutate state but could
  // continue receiving messages indefinitely. Dedupe lookups for multiple
  // local sockets sharing one session token within this delivery.
  const validations = new Map<
    string,
    Promise<Awaited<ReturnType<typeof validateToken>>>
  >();
  await Promise.all(
    [...sockets].map(async (ws) => {
      const socketUser = socketUsers.get(ws);
      if (!socketUser || socketUser.id !== userId) {
        removeSocket(ws);
        return;
      }

      let validation = validations.get(socketUser.token);
      if (!validation) {
        validation = validateToken(socketUser.token);
        validations.set(socketUser.token, validation);
      }

      try {
        const currentUser = await validation;
        if (!currentUser || currentUser.id !== socketUser.id) {
          removeSocket(ws);
          ws.close();
          return;
        }
        socketUser.name = currentUser.name;
        sendTo(ws, event);
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
}

let realtimeSubscriptionStarted = false;

function startRealtimeSubscription() {
  if (realtimeSubscriptionStarted) return;
  realtimeSubscriptionStarted = true;
  void getRealtimeBus().subscribe(async (event) => {
    if (event.type !== "ws.event") return;
    await Promise.all(
      event.targetUserIds.map((userId) =>
        deliverToLocalUser(userId, event.event),
      ),
    );
  }).catch((error) => {
    realtimeSubscriptionStarted = false;
    websocketLog.error({ err: error }, "Failed to subscribe to realtime events");
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
  return { id: user.id, name: user.name };
}

async function handleSendMessage(
  ws: WebSocket,
  userId: string,
  userName: string,
  conversationId: string,
  content: string,
  threadId?: string | null,
  clientMessageId?: string,
) {
  let msg;
  try {
    msg = await sendMessage(conversationId, userId, userName, content, {
      threadId: threadId ?? null,
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

  // Get conversation type for broadcast event
  const [conv] = await db
    .select({ type: conversations.type })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  // Get all participant IDs for broadcasting
  const participants = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, conversationId));

  const event: WsServerEvent = {
    type: "new_message",
    message: {
      id: msg.id,
      conversationId: msg.conversationId,
      threadId: msg.threadId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      senderType: msg.senderType,
      content: msg.content,
      parts: msg.parts,
      createdAt: msg.createdAt,
    },
    conversationType: conv?.type ?? "group",
    clientMessageId,
  };

  await tryBroadcastToUsers(participants.map((p) => p.userId), event);
}

async function handleTyping(
  _ws: WebSocket,
  userId: string,
  userName: string,
  conversationId: string,
  threadId?: string | null,
) {
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
}

export const wsRoutes = new Elysia().ws("/ws", {
  open(_ws) {
    // Wait for auth message
  },
  async message(ws, rawMessage) {
    let event: WsClientEvent;
    try {
      event =
        typeof rawMessage === "string"
          ? JSON.parse(rawMessage)
          : (rawMessage as WsClientEvent);
    } catch {
      sendTo(ws.raw as unknown as WebSocket, {
        type: "error",
        message: "Invalid JSON",
      });
      return;
    }

    const socket = ws.raw as unknown as WebSocket;

    if (event.type === "ping") {
      sendTo(ws.raw as unknown as WebSocket, { type: "pong" });
      return;
    }

    if (event.type === "auth") {
      const user = await validateToken(event.token);
      if (!user) {
        sendTo(socket, {
          type: "auth_error",
          message: "Invalid or expired token",
        });
        ws.close();
        return;
      }
      addSocket(user.id, user.name, event.token, socket);
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
    const currentUser = await validateToken(socketUser.token);
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
      removeSocket(socket);
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
    removeSocket(ws.raw as unknown as WebSocket);
  },
});
