/**
 * Integration test for channel/DM message visibility.
 *
 * Requires:
 *  - DATABASE_URL env var
 *  - API server running on port 3000
 *  - PostgreSQL running
 *
 * Run:
 *   DATABASE_URL=postgresql://user:password@localhost:5432/thechat \
 *     pnpm test:desktop -- src/hooks/useChannelChat.integration.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useChannelChat } from "./useChannelChat";
import WS from "ws";

const HAS_DB = !!process.env.DATABASE_URL;

const API_URL = "http://localhost:3000";
const WS_URL = "ws://localhost:3000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return res.json();
}

let emailCounter = 0;
function uniqueEmail() {
  return `integ-${Date.now()}-${++emailCounter}@test.com`;
}

const createdEmails: string[] = [];

async function registerUser(name: string) {
  const email = uniqueEmail();
  createdEmails.push(email);
  const data = await api("POST", "/auth/register", {
    name,
    email,
    password: "password123",
  });
  return { token: data.token as string, user: data.user };
}

/** Connect a WebSocket, authenticate, and return the ready socket. */
function connectWs(token: string): Promise<WS> {
  return new Promise((resolve, reject) => {
    const ws = new WS(`${WS_URL}/ws`);
    const timeout = setTimeout(
      () => reject(new Error("WebSocket connection timeout")),
      5000,
    );

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token }));
    });
    ws.on("message", function handler(data) {
      const raw = typeof data === "string" ? data : data.toString();
      const event = JSON.parse(raw);
      if (event.type === "auth_ok") {
        clearTimeout(timeout);
        ws.removeListener("message", handler);
        resolve(ws);
      } else if (event.type === "auth_error") {
        clearTimeout(timeout);
        reject(new Error("WebSocket auth failed"));
      }
    });
    ws.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket connection failed"));
    });
  });
}

function onWsMessage(ws: WS, callback: (event: any) => void) {
  ws.on("message", (data) => {
    const raw = typeof data === "string" ? data : data.toString();
    const event = JSON.parse(raw);
    callback(event);
  });
}

// ---------------------------------------------------------------------------
// Test suite — skipped when DATABASE_URL is not set
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("Channel message visibility (integration)", () => {
  let userA: { token: string; user: { id: string; name: string } };
  let userB: { token: string; user: { id: string; name: string } };
  let workspaceId: string;
  let generalChannelId: string;
  let dmConversationId: string;

  beforeAll(async () => {
    userA = await registerUser("Alice");
    userB = await registerUser("Bob");

    // User A creates a workspace
    const ws = await api(
      "POST",
      "/workspaces",
      { name: "Integration Test" },
      userA.token,
    );
    workspaceId = ws.id;

    // User B joins
    await api("POST", "/workspaces/join", { workspaceId }, userB.token);

    // Get general channel ID
    const detail = await api(
      "GET",
      `/workspaces/${workspaceId}`,
      undefined,
      userA.token,
    );
    generalChannelId = detail.channels.find(
      (c: any) => c.name === "general",
    ).id;

    // Create DM between the two users
    const dm = await api(
      "POST",
      "/conversations/dm",
      { workspaceId, otherUserId: userB.user.id },
      userA.token,
    );
    dmConversationId = dm.id;
  });

  afterAll(async () => {
    // Dynamic import to avoid blowing up when DATABASE_URL is missing
    const { cleanupWorkspace, cleanupUserByEmail } = await import(
      "@thechat/api/test-helpers"
    );

    if (workspaceId) {
      await cleanupWorkspace(workspaceId);
    }
    for (const email of createdEmails) {
      await cleanupUserByEmail(email);
    }
  });

  // -------------------------------------------------------------------------
  // REST-based message fetching via useChannelChat
  // -------------------------------------------------------------------------

  describe("useChannelChat fetches messages", () => {
    test("User B sees messages sent by User A", async () => {
      await api(
        "POST",
        `/messages/${generalChannelId}`,
        { content: "Hello from Alice!" },
        userA.token,
      );

      const { result, unmount } = renderHook(() =>
        useChannelChat({
          conversationId: generalChannelId,
          token: userB.token,
          wsSendMessage: vi.fn(),
        }),
      );

      await waitFor(() => {
        expect(result.current.messages.length).toBeGreaterThanOrEqual(1);
      });

      const msg = result.current.messages.find(
        (m) => m.content === "Hello from Alice!",
      );
      expect(msg).toBeDefined();
      expect(msg!.senderName).toBe("Alice");
      unmount();
    });

    test("messages re-fetch after navigating away and back", async () => {
      await api(
        "POST",
        `/messages/${generalChannelId}`,
        { content: "Persist test" },
        userA.token,
      );

      const { result, rerender, unmount } = renderHook(
        ({ conversationId }: { conversationId: string | null }) =>
          useChannelChat({
            conversationId,
            token: userB.token,
            wsSendMessage: vi.fn(),
          }),
        {
          initialProps: {
            conversationId: generalChannelId as string | null,
          },
        },
      );

      // Wait for initial fetch
      await waitFor(() => {
        expect(result.current.messages.length).toBeGreaterThanOrEqual(1);
      });

      // Navigate away (mimics switching to agent-chat view)
      rerender({ conversationId: null });
      await waitFor(() => {
        expect(result.current.messages).toHaveLength(0);
      });

      // Navigate back to the same channel
      rerender({ conversationId: generalChannelId });
      await waitFor(() => {
        expect(result.current.messages.length).toBeGreaterThanOrEqual(1);
      });

      const msg = result.current.messages.find(
        (m) => m.content === "Persist test",
      );
      expect(msg).toBeDefined();
      unmount();
    });
  });

  // -------------------------------------------------------------------------
  // Real-time delivery via addMessage (simulating WS callback path)
  // -------------------------------------------------------------------------

  describe("addMessage delivers real-time messages", () => {
    test("channel message appears in hook state via addMessage", async () => {
      const { result, unmount } = renderHook(() =>
        useChannelChat({
          conversationId: generalChannelId,
          token: userB.token,
          wsSendMessage: vi.fn(),
        }),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      const initialCount = result.current.messages.length;

      // Simulate what App.tsx handleWsNewMessage does
      act(() => {
        result.current.addMessage({
          id: crypto.randomUUID(),
          conversationId: generalChannelId,
          senderId: userA.user.id,
          senderName: "Alice",
          content: "Real-time channel msg",
          createdAt: new Date().toISOString(),
        });
      });

      expect(result.current.messages).toHaveLength(initialCount + 1);
      expect(
        result.current.messages.find(
          (m) => m.content === "Real-time channel msg",
        ),
      ).toBeDefined();
      unmount();
    });

    test("addMessage deduplicates by id", async () => {
      const { result, unmount } = renderHook(() =>
        useChannelChat({
          conversationId: generalChannelId,
          token: userB.token,
          wsSendMessage: vi.fn(),
        }),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      const initialCount = result.current.messages.length;

      const id = crypto.randomUUID();
      const msg = {
        id,
        conversationId: generalChannelId,
        senderId: userA.user.id,
        senderName: "Alice",
        content: "Dup test",
        createdAt: new Date().toISOString(),
      };

      act(() => {
        result.current.addMessage(msg);
        result.current.addMessage(msg); // duplicate
      });

      expect(result.current.messages).toHaveLength(initialCount + 1);
      unmount();
    });

    test("addMessage ignores messages for a different conversation", async () => {
      const { result, unmount } = renderHook(() =>
        useChannelChat({
          conversationId: generalChannelId,
          token: userB.token,
          wsSendMessage: vi.fn(),
        }),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      const initialCount = result.current.messages.length;

      act(() => {
        result.current.addMessage({
          id: crypto.randomUUID(),
          conversationId: "wrong-conversation-id",
          senderId: userA.user.id,
          senderName: "Alice",
          content: "Should be ignored",
          createdAt: new Date().toISOString(),
        });
      });

      expect(result.current.messages).toHaveLength(initialCount);
      unmount();
    });
  });

  // -------------------------------------------------------------------------
  // WebSocket end-to-end: server broadcasts to the right participants
  // -------------------------------------------------------------------------

  describe("WebSocket live message delivery", () => {
    test("User B receives channel message sent by User A", async () => {
      const wsA = await connectWs(userA.token);
      const wsB = await connectWs(userB.token);

      try {
        const received: any[] = [];
        onWsMessage(wsB, (event) => {
          if (event.type === "new_message") received.push(event);
        });

        wsA.send(
          JSON.stringify({
            type: "send_message",
            conversationId: generalChannelId,
            content: "WS channel test!",
          }),
        );

        await waitFor(() =>
          expect(received.length).toBeGreaterThanOrEqual(1),
        );

        const event = received.find(
          (e) => e.message.content === "WS channel test!",
        );
        expect(event).toBeDefined();
        expect(event.message.senderName).toBe("Alice");
        expect(event.conversationType).toBe("group");
      } finally {
        wsA.close();
        wsB.close();
      }
    });

    test("User B receives DM sent by User A", async () => {
      const wsA = await connectWs(userA.token);
      const wsB = await connectWs(userB.token);

      try {
        const received: any[] = [];
        onWsMessage(wsB, (event) => {
          if (event.type === "new_message") received.push(event);
        });

        wsA.send(
          JSON.stringify({
            type: "send_message",
            conversationId: dmConversationId,
            content: "Private DM!",
          }),
        );

        await waitFor(() =>
          expect(received.length).toBeGreaterThanOrEqual(1),
        );

        const event = received.find(
          (e) => e.message.content === "Private DM!",
        );
        expect(event).toBeDefined();
        expect(event.message.senderName).toBe("Alice");
        expect(event.conversationType).toBe("direct");
      } finally {
        wsA.close();
        wsB.close();
      }
    });

    test("full flow: WS message appears in useChannelChat via addMessage", async () => {
      const wsA = await connectWs(userA.token);
      const wsB = await connectWs(userB.token);

      try {
        // User B has the channel open
        const { result, unmount } = renderHook(() =>
          useChannelChat({
            conversationId: generalChannelId,
            token: userB.token,
            wsSendMessage: vi.fn(),
          }),
        );

        await waitFor(() => expect(result.current.loading).toBe(false));

        // Wire up WebSocket → addMessage (mimicking App.tsx handleWsNewMessage)
        onWsMessage(wsB, (event) => {
          if (
            event.type === "new_message" &&
            event.message.conversationId === generalChannelId
          ) {
            act(() => result.current.addMessage(event.message));
          }
        });

        const before = result.current.messages.length;

        // User A sends via WebSocket
        wsA.send(
          JSON.stringify({
            type: "send_message",
            conversationId: generalChannelId,
            content: "Full e2e live message!",
          }),
        );

        // Verify it shows up in User B's hook state
        await waitFor(() => {
          expect(
            result.current.messages.find(
              (m) => m.content === "Full e2e live message!",
            ),
          ).toBeDefined();
        });

        expect(result.current.messages.length).toBe(before + 1);
        unmount();
      } finally {
        wsA.close();
        wsB.close();
      }
    });

    test("bidirectional: both users see each other's messages live", async () => {
      const wsA = await connectWs(userA.token);
      const wsB = await connectWs(userB.token);

      try {
        // Both users have the channel open
        const hookA = renderHook(() =>
          useChannelChat({
            conversationId: generalChannelId,
            token: userA.token,
            wsSendMessage: vi.fn(),
          }),
        );
        const hookB = renderHook(() =>
          useChannelChat({
            conversationId: generalChannelId,
            token: userB.token,
            wsSendMessage: vi.fn(),
          }),
        );

        await waitFor(() =>
          expect(hookA.result.current.loading).toBe(false),
        );
        await waitFor(() =>
          expect(hookB.result.current.loading).toBe(false),
        );

        // Wire WebSocket → addMessage for both users
        onWsMessage(wsA, (event) => {
          if (
            event.type === "new_message" &&
            event.message.conversationId === generalChannelId
          ) {
            act(() => hookA.result.current.addMessage(event.message));
          }
        });
        onWsMessage(wsB, (event) => {
          if (
            event.type === "new_message" &&
            event.message.conversationId === generalChannelId
          ) {
            act(() => hookB.result.current.addMessage(event.message));
          }
        });

        // Alice sends a message
        wsA.send(
          JSON.stringify({
            type: "send_message",
            conversationId: generalChannelId,
            content: "Hi Bob!",
          }),
        );

        // Both see it
        await waitFor(() => {
          expect(
            hookA.result.current.messages.find(
              (m) => m.content === "Hi Bob!",
            ),
          ).toBeDefined();
        });
        await waitFor(() => {
          expect(
            hookB.result.current.messages.find(
              (m) => m.content === "Hi Bob!",
            ),
          ).toBeDefined();
        });

        // Bob replies
        wsB.send(
          JSON.stringify({
            type: "send_message",
            conversationId: generalChannelId,
            content: "Hey Alice!",
          }),
        );

        // Both see the reply
        await waitFor(() => {
          expect(
            hookA.result.current.messages.find(
              (m) => m.content === "Hey Alice!",
            ),
          ).toBeDefined();
        });
        await waitFor(() => {
          expect(
            hookB.result.current.messages.find(
              (m) => m.content === "Hey Alice!",
            ),
          ).toBeDefined();
        });

        hookA.unmount();
        hookB.unmount();
      } finally {
        wsA.close();
        wsB.close();
      }
    });
  });
});
