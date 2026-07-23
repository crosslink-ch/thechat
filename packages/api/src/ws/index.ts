import { Elysia } from "elysia";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { conversationParticipants } from "../db/schema";
import type { WsClientEvent, WsServerEvent } from "@thechat/shared";
import { resolveTokenToUser } from "../auth/middleware";
import { sendMessage } from "../services/messages";
import { ServiceError } from "../services/errors";
import { getRealtimeBus, publishWsEventToUsers } from "../realtime";
import { log } from "../logging";

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
const socketUsers = new Map<WebSocket, { id: string; name: string }>();

function addSocket(userId: string, userName: string, ws: WebSocket) {
  socketUsers.set(ws, { id: userId, name: userName });
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

function deliverToLocalUser(userId: string, event: WsServerEvent) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  const data = JSON.stringify(event);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

let realtimeSubscriptionStarted = false;

function startRealtimeSubscription() {
  if (realtimeSubscriptionStarted) return;
  realtimeSubscriptionStarted = true;
  void getRealtimeBus().subscribe(async (event) => {
    if (event.type !== "ws.event") return;
    for (const userId of event.targetUserIds) {
      deliverToLocalUser(userId, event.event);
    }
  }).catch((error) => {
    realtimeSubscriptionStarted = false;
    websocketLog.error({ err: error }, "Failed to subscribe to realtime events");
    setTimeout(startRealtimeSubscription, 1_000);
  });
}

startRealtimeSubscription();

async function validateToken(token: string) {
  const user = await resolveTokenToUser(token);
  if (!user) return null;
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
      const candidate =
        typeof rawMessage === "string"
          ? JSON.parse(rawMessage)
          : rawMessage;
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
      addSocket(user.id, user.name, socket);
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
    removeSocket(ws.raw as unknown as WebSocket);
  },
});
