import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  messages,
  conversations,
  conversationParticipants,
} from "../db/schema";
import type { WsClientEvent, WsServerEvent } from "@thechat/shared";
import { resolveTokenToUser } from "../auth/middleware";
import { processMessageMentions } from "../bots/webhooks";

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

function broadcastToUser(userId: string, event: WsServerEvent) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  const data = JSON.stringify(event);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

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
  content: string
) {
  // Validate user is a participant
  const [participant] = await db
    .select()
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId)
      )
    )
    .limit(1);

  if (!participant) {
    sendTo(ws, { type: "error", message: "Not a participant of this conversation" });
    return;
  }

  // Insert message
  const [msg] = await db
    .insert(messages)
    .values({
      conversationId,
      senderId: userId,
      content,
    })
    .returning();

  // Get conversation type
  const [conv] = await db
    .select({ type: conversations.type })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  // Get all participant IDs
  const participants = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, conversationId));

  const createdAt = msg.createdAt.toISOString();

  const event: WsServerEvent = {
    type: "new_message",
    message: {
      id: msg.id,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      senderName: userName,
      content: msg.content,
      createdAt,
    },
    conversationType: conv?.type ?? "group",
  };

  // Broadcast to all connected participants
  for (const p of participants) {
    broadcastToUser(p.userId, event);
  }

  // Fire-and-forget webhook notifications for @mentioned bots
  processMessageMentions({
    id: msg.id,
    content: msg.content,
    conversationId: msg.conversationId,
    senderId: msg.senderId,
    senderName: userName,
    createdAt,
  });
}

async function handleTyping(
  _ws: WebSocket,
  userId: string,
  userName: string,
  conversationId: string
) {
  // Get all participant IDs
  const participants = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, conversationId));

  const event: WsServerEvent = {
    type: "typing",
    conversationId,
    userId,
    userName,
  };

  // Broadcast to all participants except sender
  for (const p of participants) {
    if (p.userId !== userId) {
      broadcastToUser(p.userId, event);
    }
  }
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
          : rawMessage as WsClientEvent;
    } catch {
      sendTo(ws.raw as unknown as WebSocket, {
        type: "error",
        message: "Invalid JSON",
      });
      return;
    }

    const socket = ws.raw as unknown as WebSocket;

    if (event.type === "auth") {
      const user = await validateToken(event.token);
      if (!user) {
        sendTo(socket, { type: "auth_error", message: "Invalid or expired token" });
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
      sendTo(socket, { type: "error", message: "Not authenticated" });
      return;
    }

    if (event.type === "send_message") {
      await handleSendMessage(
        socket,
        socketUser.id,
        socketUser.name,
        event.conversationId,
        event.content
      );
    } else if (event.type === "typing") {
      await handleTyping(socket, socketUser.id, socketUser.name, event.conversationId);
    }
  },
  close(ws) {
    removeSocket(ws.raw as unknown as WebSocket);
  },
});
